//! API Gateway 라우터 정의
//!
//! 모든 외부 HTTP 요청의 단일 진입점.
//! 인증/인가 미들웨어, 레이트 리미팅은 이 레이어에서 처리한다.
//!
//! 현재 라우트:
//! - GET /                                    — /#/about 리다이렉트 (HTML meta-refresh)
//! - GET /install.sh                          — 설치 스크립트 (인증 불필요)
//! - GET /install.ps1                         — Windows 설치 스크립트 (미구현, 404)
//! - GET /health                              — 헬스체크
//! - GET /api/v1/xview                        — X-View 히트맵 데이터
//! - GET /api/v1/traces/:trace_id             — 특정 trace 조회 (TODO)
//! - GET /api/v1/services                     — 서비스 목록 조회 (TODO)
//! - GET /api/v1/services/:service/operations — 오퍼레이션 목록 (TODO)

/// deploy/scripts/install.sh 파일을 빌드 시 정적으로 포함한다.
/// CARGO_MANIFEST_DIR 기준 ../../deploy/scripts/install.sh 경로를 참조하며
/// 요청당 IO가 전혀 없이 메모리에서 서빙된다.
static INSTALL_SH: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../deploy/scripts/install.sh"
));

use axum::{
    Json, Router,
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, Request, State,
    },
    http::{HeaderValue, StatusCode, header},
    middleware,
    response::{Html, IntoResponse, Response},
    routing::{any, get, post},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::time::{Duration, interval};
use tower_http::{
    cors::{Any, CorsLayer},
    trace::TraceLayer,
};
use tracing::{debug, error, info};

use crate::auth::{AuthConfig, auth_middleware};

// ---------------------------------------------------------------------------
// 공유 상태
// ---------------------------------------------------------------------------

/// API Gateway 공유 상태.
/// 실제 쿼리는 datacat-query 서비스로 프록시한다.
#[derive(Clone)]
pub struct ApiState {
    /// datacat-query 서비스 URL
    pub query_service_url: String,
    /// datacat-insights 서비스 URL (기본: http://localhost:9091)
    pub insights_service_url: String,
    /// datacat-admin 서비스 URL (기본: http://localhost:9092)
    pub admin_service_url: String,
    /// datacat-alerting 서비스 URL (기본: http://localhost:9090)
    pub alerting_service_url: String,
    /// 재사용 가능한 HTTP 클라이언트 (연결 풀 공유)
    pub http_client: reqwest::Client,
    /// 인증 미들웨어 설정 (DATACAT_AUTH_ENABLED=true 시 활성화)
    pub auth_config: AuthConfig,
}

// ---------------------------------------------------------------------------
// 응답 타입
// ---------------------------------------------------------------------------

/// 표준 API 응답 래퍼.
#[derive(Debug, Serialize)]
pub struct ApiResponse<T: Serialize> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T: Serialize> ApiResponse<T> {
    #[allow(dead_code)]
    pub fn ok(data: T) -> Self {
        ApiResponse {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(msg: impl Into<String>) -> ApiResponse<()> {
        ApiResponse {
            success: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

/// GET /health — Kubernetes liveness/readiness probe용
async fn health_handler() -> impl IntoResponse {
    #[derive(Serialize)]
    struct HealthResponse {
        status: &'static str,
        version: &'static str,
    }

    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// GET / — /#/about 로 HTML meta-refresh 리다이렉트
async fn root_handler() -> impl IntoResponse {
    Html("<html><meta http-equiv=\"refresh\" content=\"0; url=/#/about\"></html>")
}

/// GET /install.sh — 설치 스크립트 서빙 (인증 불필요)
///
/// 스크립트는 빌드 시 정적으로 포함되므로 요청당 IO가 없다.
/// `curl -sSL http://<host>:8000/install.sh | bash` 패턴으로 사용한다.
async fn install_sh_handler() -> impl IntoResponse {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, HeaderValue::from_static("text/x-shellscript"))],
        INSTALL_SH,
    )
}

/// GET /install.ps1 — Windows 설치 스크립트 (미구현)
async fn install_ps1_handler() -> impl IntoResponse {
    StatusCode::NOT_FOUND
}

/// GET /api/v1/xview 쿼리 파라미터.
#[derive(Debug, Deserialize)]
pub struct XViewQuery {
    /// 조회 시작 (Unix timestamp, 밀리초)
    pub start: i64,
    /// 조회 종료 (Unix timestamp, 밀리초)
    pub end: i64,
    /// 서비스 필터
    pub service: Option<String>,
    /// 환경 필터 (production, staging 등)
    pub env: Option<String>,
    /// 테넌트 ID
    pub tenant_id: Option<String>,
    /// 최대 포인트 수 (다운샘플링)
    pub limit: Option<u32>,
}

/// GET /api/v1/xview — X-View 히트맵 데이터 조회
///
/// X-View는 시간(X축) × 응답시간(Y축) 히트맵으로
/// 서비스의 응답시간 분포를 시각화한다.
/// 실제 쿼리 실행은 datacat-query 서비스에 위임한다.
async fn xview_handler(
    State(state): State<Arc<ApiState>>,
    Query(params): Query<XViewQuery>,
) -> Response {
    info!(
        start = params.start,
        end = params.end,
        service = ?params.service,
        "X-View 쿼리 요청"
    );

    // datacat-query 서비스로 HTTP 프록시
    // 쿼리 파라미터를 그대로 전달하여 응답을 relay한다.
    let mut query_pairs: Vec<(&str, String)> = vec![
        ("start", params.start.to_string()),
        ("end", params.end.to_string()),
    ];
    if let Some(ref svc) = params.service {
        query_pairs.push(("service", svc.clone()));
    }
    if let Some(ref env) = params.env {
        query_pairs.push(("env", env.clone()));
    }
    if let Some(ref tenant) = params.tenant_id {
        query_pairs.push(("tenant_id", tenant.clone()));
    }
    if let Some(limit) = params.limit {
        query_pairs.push(("limit", limit.to_string()));
    }

    let upstream_url = format!("{}/api/v1/xview", state.query_service_url);

    match state
        .http_client
        .get(&upstream_url)
        .query(&query_pairs)
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            match resp.json::<serde_json::Value>().await {
                Ok(body) => {
                    let status_code = StatusCode::from_u16(status.as_u16())
                        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                    (status_code, Json(body)).into_response()
                }
                Err(e) => {
                    error!(error = %e, "datacat-query 응답 역직렬화 실패");
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({ "error": "upstream response parse failed" })),
                    )
                        .into_response()
                }
            }
        }
        Err(e) => {
            error!(error = %e, url = %upstream_url, "datacat-query 프록시 요청 실패");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": "query service unavailable" })),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// Logs 핸들러
// ---------------------------------------------------------------------------

/// GET /api/v1/logs 쿼리 파라미터 — datacat-query 서비스로 전달
///
/// `severity`는 프론트엔드에서 "DEBUG" | "INFO" | "WARN" | "ERROR" 문자열로 전달된다.
/// query service로 그대로 전달(proxying)하므로 String으로 수신한다.
#[derive(Debug, Deserialize)]
pub struct LogsQuery {
    pub start: i64,
    pub end: i64,
    pub service: Option<String>,
    pub severity: Option<String>,
    pub query: Option<String>,
    pub trace_id: Option<String>,
    pub limit: Option<u32>,
    pub tenant_id: Option<String>,
}

/// GET /api/v1/logs — Logs 데이터 조회 프록시
async fn logs_handler(
    State(state): State<Arc<ApiState>>,
    Query(params): Query<LogsQuery>,
) -> Response {
    info!(
        start = params.start,
        end = params.end,
        service = ?params.service,
        "Logs 쿼리 요청"
    );

    let mut query_pairs: Vec<(&str, String)> = vec![
        ("start", params.start.to_string()),
        ("end", params.end.to_string()),
    ];
    if let Some(ref svc) = params.service {
        query_pairs.push(("service", svc.clone()));
    }
    if let Some(ref sev) = params.severity {
        query_pairs.push(("severity", sev.clone()));
    }
    if let Some(ref q) = params.query {
        query_pairs.push(("query", q.clone()));
    }
    if let Some(ref tid) = params.trace_id {
        query_pairs.push(("trace_id", tid.clone()));
    }
    if let Some(ref limit) = params.limit {
        query_pairs.push(("limit", limit.to_string()));
    }
    if let Some(ref tenant) = params.tenant_id {
        query_pairs.push(("tenant_id", tenant.clone()));
    }

    let upstream_url = format!("{}/api/v1/logs", state.query_service_url);

    match state
        .http_client
        .get(&upstream_url)
        .query(&query_pairs)
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            match resp.json::<serde_json::Value>().await {
                Ok(body) => {
                    let status_code = StatusCode::from_u16(status.as_u16())
                        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
                    (status_code, Json(body)).into_response()
                }
                Err(e) => {
                    error!(error = %e, "logs 응답 역직렬화 실패");
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({ "error": "upstream response parse failed" })),
                    )
                        .into_response()
                }
            }
        }
        Err(e) => {
            error!(error = %e, url = %upstream_url, "logs 프록시 요청 실패");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": "query service unavailable" })),
            )
                .into_response()
        }
    }
}

/// GET /api/v1/logs/stream 쿼리 파라미터
///
/// `severity`는 프론트엔드에서 "DEBUG" | "INFO" | "WARN" | "ERROR" 문자열로 전달된다.
#[derive(Debug, Deserialize)]
pub struct LogsStreamQuery {
    pub service: Option<String>,
    pub severity: Option<String>,
    pub query: Option<String>,
    pub tenant_id: Option<String>,
}

/// GET /api/v1/logs/stream — WebSocket 라이브테일 프록시
///
/// 클라이언트 WebSocket 연결을 수락한 후, 1초마다 datacat-query의
/// /api/v1/logs를 HTTP poll하여 최근 로그 100개를 JSON으로 전송한다.
/// (query service WebSocket 직접 프록시 대신 단순 HTTP poll 방식)
async fn logs_stream_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ApiState>>,
    Query(params): Query<LogsStreamQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_logs_stream_proxy(socket, state, params))
}

/// WebSocket 연결 내에서 1초마다 query service를 HTTP poll하여 로그를 전송한다.
async fn handle_logs_stream_proxy(
    mut socket: WebSocket,
    state: Arc<ApiState>,
    params: LogsStreamQuery,
) {
    let mut ticker = interval(Duration::from_secs(1));

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                // 현재 시각 기준 최근 10분 조회
                let now_ms = chrono::Utc::now().timestamp_millis();
                let start_ms = now_ms - 600_000;

                let mut query_pairs: Vec<(&str, String)> = vec![
                    ("start", start_ms.to_string()),
                    ("end", now_ms.to_string()),
                    ("limit", "100".to_string()),
                ];
                if let Some(ref svc) = params.service {
                    query_pairs.push(("service", svc.clone()));
                }
                if let Some(ref sev) = params.severity {
                    query_pairs.push(("severity", sev.clone()));
                }
                if let Some(ref q) = params.query {
                    query_pairs.push(("query", q.clone()));
                }
                if let Some(ref tenant) = params.tenant_id {
                    query_pairs.push(("tenant_id", tenant.clone()));
                }

                let upstream_url = format!("{}/api/v1/logs", state.query_service_url);

                let payload = match state
                    .http_client
                    .get(&upstream_url)
                    .query(&query_pairs)
                    .send()
                    .await
                {
                    Ok(resp) => match resp.json::<serde_json::Value>().await {
                        Ok(body) => {
                            // logs 배열만 추출하여 전송
                            let logs = body.get("logs").cloned().unwrap_or(serde_json::json!([]));
                            serde_json::to_string(&logs).unwrap_or_else(|_| "[]".to_string())
                        }
                        Err(e) => {
                            debug!(error = %e, "라이브테일 upstream 응답 파싱 실패");
                            continue;
                        }
                    },
                    Err(e) => {
                        debug!(error = %e, "라이브테일 upstream 요청 실패");
                        continue;
                    }
                };

                if socket.send(Message::Text(payload)).await.is_err() {
                    debug!("라이브테일 클라이언트 연결 종료");
                    break;
                }
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => {
                        debug!("라이브테일 WebSocket 종료 요청");
                        break;
                    }
                    Some(Err(e)) => {
                        debug!(error = %e, "라이브테일 WebSocket 오류");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
}

/// GET /api/v1/traces/:trace_id — 특정 trace의 전체 span tree 조회
async fn get_trace_handler(
    State(_state): State<Arc<ApiState>>,
    Path(trace_id): Path<String>,
) -> impl IntoResponse {
    info!(trace_id = %trace_id, "trace 조회 요청");

    // TODO: datacat-query 서비스로 프록시
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(ApiResponse::<()>::err("datacat-query 서비스 연동 구현 예정")),
    )
}

/// GET /api/v1/services — 서비스 목록 (query service 프록시)
async fn list_services_handler(
    State(state): State<Arc<ApiState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    proxy_to_query(&state, "/api/v1/services", &params).await
}

/// GET /api/v1/query_range — PromQL-lite 시계열 메트릭 조회 (query service 프록시)
async fn query_range_handler(
    State(state): State<Arc<ApiState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    proxy_to_query(&state, "/api/v1/query_range", &params).await
}

/// GET /api/v1/metrics — 메트릭 이름 목록 (query service 프록시)
async fn list_metrics_handler(
    State(state): State<Arc<ApiState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    proxy_to_query(&state, "/api/v1/metrics", &params).await
}

/// query service로 GET 요청을 프록시하는 공통 헬퍼.
async fn proxy_to_query(
    state: &ApiState,
    path: &str,
    params: &std::collections::HashMap<String, String>,
) -> Response {
    let upstream_url = format!("{}{}", state.query_service_url, path);
    let query_pairs: Vec<(&str, &str)> = params
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    match state
        .http_client
        .get(&upstream_url)
        .query(&query_pairs)
        .send()
        .await
    {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            match resp.json::<serde_json::Value>().await {
                Ok(body) => (status, Json(body)).into_response(),
                Err(e) => {
                    error!(error = %e, path, "query service 응답 파싱 실패");
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({ "error": "upstream response parse failed" })),
                    )
                        .into_response()
                }
            }
        }
        Err(e) => {
            error!(error = %e, url = %upstream_url, "query service 프록시 요청 실패");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": "query service unavailable" })),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// 라우터 빌더
// ---------------------------------------------------------------------------

/// GET /api/v1/profiles — 프로파일 목록 조회 (query service 프록시)
async fn list_profiles_handler(
    State(state): State<Arc<ApiState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    proxy_to_query(&state, "/api/v1/profiles", &params).await
}

/// GET /api/v1/profiles/:id/flamegraph — 플레임그래프 데이터 (query service 프록시)
async fn get_flamegraph_handler(
    State(state): State<Arc<ApiState>>,
    Path(profile_id): Path<String>,
) -> Response {
    let path = format!("/api/v1/profiles/{}/flamegraph", profile_id);
    let empty: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    proxy_to_query(&state, &path, &empty).await
}

// ---------------------------------------------------------------------------
// Insights 핸들러 (Phase 6 — AI Auto-Ops)
// ---------------------------------------------------------------------------

/// datacat-insights 서비스로 POST 요청을 프록시하는 공통 헬퍼.
async fn proxy_post_to_insights(
    state: &ApiState,
    path: &str,
    body: bytes::Bytes,
) -> Response {
    let upstream_url = format!("{}{}", state.insights_service_url, path);

    match state
        .http_client
        .post(&upstream_url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            match resp.json::<serde_json::Value>().await {
                Ok(body) => (status, Json(body)).into_response(),
                Err(e) => {
                    error!(error = %e, path, "insights 응답 파싱 실패");
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({ "error": "upstream response parse failed" })),
                    )
                        .into_response()
                }
            }
        }
        Err(e) => {
            error!(error = %e, url = %upstream_url, "insights 프록시 요청 실패");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": "insights service unavailable" })),
            )
                .into_response()
        }
    }
}

/// datacat-insights 서비스로 GET 요청을 프록시하는 공통 헬퍼.
async fn proxy_get_to_insights(
    state: &ApiState,
    path: &str,
    params: &std::collections::HashMap<String, String>,
) -> Response {
    let upstream_url = format!("{}{}", state.insights_service_url, path);
    let query_pairs: Vec<(&str, &str)> = params
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();

    match state
        .http_client
        .get(&upstream_url)
        .query(&query_pairs)
        .send()
        .await
    {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            match resp.json::<serde_json::Value>().await {
                Ok(body) => (status, Json(body)).into_response(),
                Err(e) => {
                    error!(error = %e, path, "insights GET 응답 파싱 실패");
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({ "error": "upstream response parse failed" })),
                    )
                        .into_response()
                }
            }
        }
        Err(e) => {
            error!(error = %e, url = %upstream_url, "insights GET 프록시 요청 실패");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({ "error": "insights service unavailable" })),
            )
                .into_response()
        }
    }
}

/// POST /api/v1/insights/analyze — 이상 탐지 프록시
async fn insights_analyze_handler(
    State(state): State<Arc<ApiState>>,
    body: bytes::Bytes,
) -> Response {
    proxy_post_to_insights(&state, "/api/v1/insights/analyze", body).await
}

/// GET /api/v1/insights/patterns — X-View 패턴 탐지 프록시
async fn insights_patterns_handler(
    State(state): State<Arc<ApiState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    proxy_get_to_insights(&state, "/api/v1/insights/patterns", &params).await
}

/// POST /api/v1/insights/chat — AI Ops 챗봇 프록시
async fn insights_chat_handler(
    State(state): State<Arc<ApiState>>,
    body: bytes::Bytes,
) -> Response {
    proxy_post_to_insights(&state, "/api/v1/insights/chat", body).await
}

// ---------------------------------------------------------------------------
// Admin 프록시 핸들러 (Phase 7 — Multi-tenancy)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Log Metric Rules 핸들러 (Phase 5)
// ---------------------------------------------------------------------------

/// GET /api/v1/log-metric-rules — 로그 메트릭 규칙 목록 (query service 프록시)
async fn list_log_metric_rules_handler(
    State(state): State<Arc<ApiState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    proxy_to_query(&state, "/api/v1/log-metric-rules", &params).await
}

/// POST /api/v1/log-metric-rules — 로그 메트릭 규칙 생성 (query service 프록시)
async fn create_log_metric_rule_handler(
    State(state): State<Arc<ApiState>>,
    body: bytes::Bytes,
) -> Response {
    let upstream_url = format!("{}/api/v1/log-metric-rules", state.query_service_url);
    match state
        .http_client
        .post(&upstream_url)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            match resp.json::<serde_json::Value>().await {
                Ok(b) => (status, Json(b)).into_response(),
                Err(e) => {
                    error!(error = %e, "log-metric-rules POST 응답 파싱 실패");
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({"error": "upstream response parse failed"})),
                    )
                        .into_response()
                }
            }
        }
        Err(e) => {
            error!(error = %e, url = %upstream_url, "log-metric-rules POST 프록시 실패");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": "query service unavailable"})),
            )
                .into_response()
        }
    }
}

/// DELETE /api/v1/log-metric-rules/:rule_id — 로그 메트릭 규칙 삭제 (query service 프록시)
async fn delete_log_metric_rule_handler(
    State(state): State<Arc<ApiState>>,
    Path(rule_id): Path<String>,
) -> Response {
    let upstream_url = format!(
        "{}/api/v1/log-metric-rules/{}",
        state.query_service_url, rule_id
    );
    match state.http_client.delete(&upstream_url).send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            if status == StatusCode::NO_CONTENT {
                return status.into_response();
            }
            let bytes = resp.bytes().await.unwrap_or_default();
            if bytes.is_empty() {
                return status.into_response();
            }
            match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(b) => (status, Json(b)).into_response(),
                Err(_) => status.into_response(),
            }
        }
        Err(e) => {
            error!(error = %e, url = %upstream_url, "log-metric-rules DELETE 프록시 실패");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": "query service unavailable"})),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// Alerting 프록시 핸들러 (Phase 8 — Alerting)
// ---------------------------------------------------------------------------

/// ANY /api/v1/monitors[/*] 및 /api/v1/incidents[/*] —
/// datacat-alerting 서비스로 모든 요청을 프록시한다.
async fn alerting_proxy_handler(
    State(state): State<Arc<ApiState>>,
    req: Request<Body>,
) -> Response {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");

    let upstream_url = format!("{}{}", state.alerting_service_url, path_and_query);

    let method = req.method().clone();
    let headers = req.headers().clone();
    let body_bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(b) => b,
        Err(e) => {
            error!(error = %e, "alerting 프록시 요청 본문 읽기 실패");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "internal server error"})),
            )
                .into_response();
        }
    };

    let mut upstream_req = state
        .http_client
        .request(
            reqwest::Method::from_bytes(method.as_str().as_bytes())
                .unwrap_or(reqwest::Method::GET),
            &upstream_url,
        )
        .body(body_bytes);

    if let Some(ct) = headers.get("content-type") {
        if let Ok(ct_str) = ct.to_str() {
            upstream_req = upstream_req.header("content-type", ct_str);
        }
    }

    match upstream_req.send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            // 204 No Content 등 본문 없는 응답은 파싱하지 않는다
            if status == StatusCode::NO_CONTENT {
                return status.into_response();
            }
            let bytes = resp.bytes().await.unwrap_or_default();
            if bytes.is_empty() {
                return status.into_response();
            }
            match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(body) => (status, Json(body)).into_response(),
                Err(e) => {
                    error!(error = %e, "alerting 프록시 응답 파싱 실패");
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({"error": "upstream response parse failed"})),
                    )
                        .into_response()
                }
            }
        }
        Err(e) => {
            error!(error = %e, url = %upstream_url, "alerting 프록시 요청 실패");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": "alerting service unavailable"})),
            )
                .into_response()
        }
    }
}

/// POST /api/v1/admin/* — datacat-admin 서비스로 모든 요청을 프록시한다.
///
/// SECURITY NOTE: 이 경로는 네트워크 레벨 보호(프라이빗 네트워크/VPN)가
/// 필요하다. 프로덕션 환경에서 퍼블릭 인터넷에 노출하지 말 것.
async fn admin_proxy_handler(
    State(state): State<Arc<ApiState>>,
    req: Request<Body>,
) -> Response {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");

    let upstream_url = format!("{}{}", state.admin_service_url, path_and_query);

    let method = req.method().clone();
    let headers = req.headers().clone();
    let body_bytes = match axum::body::to_bytes(req.into_body(), usize::MAX).await {
        Ok(b) => b,
        Err(e) => {
            error!(error = %e, "admin 프록시 요청 본문 읽기 실패");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "internal server error"})),
            )
                .into_response();
        }
    };

    let mut upstream_req = state
        .http_client
        .request(
            reqwest::Method::from_bytes(method.as_str().as_bytes())
                .unwrap_or(reqwest::Method::GET),
            &upstream_url,
        )
        .body(body_bytes);

    // content-type 헤더 전달
    if let Some(ct) = headers.get("content-type") {
        if let Ok(ct_str) = ct.to_str() {
            upstream_req = upstream_req.header("content-type", ct_str);
        }
    }

    match upstream_req.send().await {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16())
                .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
            if status == StatusCode::NO_CONTENT {
                return status.into_response();
            }
            let bytes = resp.bytes().await.unwrap_or_default();
            if bytes.is_empty() {
                return status.into_response();
            }
            match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(body) => (status, Json(body)).into_response(),
                Err(e) => {
                    error!(error = %e, "admin 프록시 응답 파싱 실패");
                    (
                        StatusCode::BAD_GATEWAY,
                        Json(serde_json::json!({"error": "upstream response parse failed"})),
                    )
                        .into_response()
                }
            }
        }
        Err(e) => {
            error!(error = %e, url = %upstream_url, "admin 프록시 요청 실패");
            (
                StatusCode::BAD_GATEWAY,
                Json(serde_json::json!({"error": "admin service unavailable"})),
            )
                .into_response()
        }
    }
}

/// 전체 라우터를 구성한다.
/// CORS, 트레이싱 미들웨어를 포함한다.
pub fn build_router(state: Arc<ApiState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let auth_enabled = std::env::var("DATACAT_AUTH_ENABLED")
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    let auth_config = state.auth_config.clone();

    // Admin 프록시 라우트 — 네트워크 레벨에서 프라이빗 접근만 허용할 것
    let admin_routes = Router::new()
        .route("/api/v1/admin/*path", any(admin_proxy_handler));

    // Alerting 프록시 라우트 (Phase 8)
    let alerting_routes = Router::new()
        .route("/api/v1/monitors", any(alerting_proxy_handler))
        .route("/api/v1/monitors/*path", any(alerting_proxy_handler))
        .route("/api/v1/incidents", any(alerting_proxy_handler))
        .route("/api/v1/incidents/*path", any(alerting_proxy_handler));

    // 인증이 필요한 API 라우트
    let api_routes = Router::new()
        // 헬스체크 (인증 불필요)
        .route("/health", get(health_handler))
        // X-View API
        .route("/api/v1/xview", get(xview_handler))
        // Logs API (Phase 3)
        .route("/api/v1/logs", get(logs_handler))
        .route("/api/v1/logs/stream", get(logs_stream_handler))
        // Trace 조회
        .route("/api/v1/traces/:trace_id", get(get_trace_handler))
        // Metrics API (Phase 2)
        .route("/api/v1/query_range", get(query_range_handler))
        .route("/api/v1/metrics", get(list_metrics_handler))
        // 서비스 목록 (spans + metrics 합산)
        .route("/api/v1/services", get(list_services_handler))
        // Profiling API (Phase 4)
        .route("/api/v1/profiles", get(list_profiles_handler))
        .route(
            "/api/v1/profiles/:profile_id/flamegraph",
            get(get_flamegraph_handler),
        )
        // Insights API (Phase 6 — AI Auto-Ops)
        .route("/api/v1/insights/analyze", post(insights_analyze_handler))
        .route("/api/v1/insights/patterns", get(insights_patterns_handler))
        .route("/api/v1/insights/chat", post(insights_chat_handler))
        // Log Metric Rules API (Phase 5)
        .route(
            "/api/v1/log-metric-rules",
            get(list_log_metric_rules_handler).post(create_log_metric_rule_handler),
        )
        .route(
            "/api/v1/log-metric-rules/:rule_id",
            axum::routing::delete(delete_log_metric_rule_handler),
        );

    // DATACAT_AUTH_ENABLED=true 시 API 키 인증 미들웨어를 활성화한다.
    // 개발 모드에서는 미들웨어를 붙이지 않아 오버헤드가 없다.
    let api_routes = if auth_enabled {
        info!("API 키 인증 미들웨어 활성화 (DATACAT_AUTH_ENABLED=true)");
        api_routes
            .layer(middleware::from_fn_with_state(auth_config, auth_middleware))
    } else {
        info!("API 키 인증 비활성화 (개발 모드) — DATACAT_AUTH_ENABLED=true 로 활성화");
        api_routes
    };

    // 인증 없이 공개 접근이 필요한 정적 라우트 — auth 레이어 밖에 위치한다.
    let public_routes = Router::new()
        .route("/", get(root_handler))
        .route("/install.sh", get(install_sh_handler))
        .route("/install.ps1", get(install_ps1_handler));

    Router::new()
        .merge(public_routes)
        .merge(api_routes)
        .merge(admin_routes)
        .merge(alerting_routes)
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}
