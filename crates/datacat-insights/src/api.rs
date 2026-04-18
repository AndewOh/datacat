//! HTTP 핸들러
//!
//! 세 가지 insights 엔드포인트를 구현한다:
//! - POST /api/v1/insights/analyze — 이상 탐지
//! - GET  /api/v1/insights/patterns — X-View 패턴 탐지
//! - POST /api/v1/insights/chat — AI Ops 챗봇

use std::sync::Arc;

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use crate::anomaly::detect_anomalies;
use crate::chat::{ChatRequest, handle_chat};
use crate::patterns::detect_patterns;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// 요청 / 응답 타입
// ---------------------------------------------------------------------------

/// POST /api/v1/insights/analyze 요청 본문.
#[derive(Debug, Deserialize)]
pub struct AnalyzeRequest {
    /// 테넌트 ID
    pub tenant_id: Option<String>,
    /// 분석할 시간 윈도우 (분 단위, 기본값: 60)
    pub window_minutes: Option<u32>,
}

/// POST /api/v1/insights/analyze 응답.
#[derive(Debug, Serialize)]
pub struct AnalyzeResponse {
    pub anomalies: Vec<crate::anomaly::AnomalyReport>,
    pub total: usize,
}

/// GET /api/v1/insights/patterns 쿼리 파라미터.
#[derive(Debug, Deserialize)]
pub struct PatternsQuery {
    /// 테넌트 ID
    pub tenant_id: Option<String>,
    /// 조회 시작 (Unix 밀리초)
    pub start: Option<i64>,
    /// 조회 종료 (Unix 밀리초)
    pub end: Option<i64>,
}

/// GET /api/v1/insights/patterns 응답.
#[derive(Debug, Serialize)]
pub struct PatternsResponse {
    pub patterns: Vec<crate::patterns::PatternDetected>,
    pub total: usize,
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

/// GET /health — liveness probe
pub async fn health_handler() -> impl IntoResponse {
    #[derive(Serialize)]
    struct HealthResponse {
        status: &'static str,
        service: &'static str,
    }
    Json(HealthResponse {
        status: "ok",
        service: "datacat-insights",
    })
}

/// POST /api/v1/insights/analyze — 이상 탐지 실행
///
/// 지정된 시간 윈도우에서 Z-score 기반 이상을 탐지하여 반환한다.
pub async fn analyze_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AnalyzeRequest>,
) -> Response {
    let tenant_id = req.tenant_id.as_deref().unwrap_or("default");
    let window_minutes = req.window_minutes.unwrap_or(60).min(1440);

    let anomalies = detect_anomalies(&state.ch_client, tenant_id, window_minutes).await;
    let total = anomalies.len();

    (StatusCode::OK, Json(AnalyzeResponse { anomalies, total })).into_response()
}

/// GET /api/v1/insights/patterns — X-View 패턴 탐지
///
/// 지정된 시간 범위에서 Surge / Waterfall / Droplet / Wave 패턴을 탐지한다.
pub async fn patterns_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<PatternsQuery>,
) -> Response {
    let tenant_id = params.tenant_id.as_deref().unwrap_or("default");

    let now_ms = chrono::Utc::now().timestamp_millis();
    let start_ms = params.start.unwrap_or(now_ms - 3_600_000); // 기본값: 1시간 전
    let end_ms = params.end.unwrap_or(now_ms);

    if start_ms >= end_ms {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "start must be less than end" })),
        )
            .into_response();
    }

    let patterns = detect_patterns(&state.ch_client, tenant_id, start_ms, end_ms).await;
    let total = patterns.len();

    (StatusCode::OK, Json(PatternsResponse { patterns, total })).into_response()
}

/// POST /api/v1/insights/chat — AI Ops 챗봇
///
/// Ollama가 설정된 경우 LLM을 사용하고, 그렇지 않으면 규칙 기반 응답을 반환한다.
pub async fn chat_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChatRequest>,
) -> Response {
    if req.message.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "message must not be empty" })),
        )
            .into_response();
    }

    let ollama_url = state.ollama_url.as_deref();
    let response = handle_chat(
        &state.ch_client,
        &state.http_client,
        ollama_url,
        req,
    )
    .await;

    (StatusCode::OK, Json(response)).into_response()
}
