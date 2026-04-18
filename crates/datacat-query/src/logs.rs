//! Logs 쿼리 핸들러
//!
//! GET  /api/v1/logs         — 시간 범위 + 필터 기반 로그 조회
//! GET  /api/v1/logs/stream  — WebSocket 라이브테일 (1초 poll × 100개)
//!
//! ClickHouse tokenbf_v1 인덱스를 활용한 풀텍스트 검색 지원.
//! SQL 인젝션 방어: 모든 String 파라미터에 single-quote 이스케이프 적용.

use anyhow::Result;
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
};
use clickhouse::Row;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::time::{Duration, interval};
use tracing::{debug, error};

// ---------------------------------------------------------------------------
// 요청 파라미터
// ---------------------------------------------------------------------------

/// GET /api/v1/logs 쿼리 파라미터.
#[derive(Debug, Deserialize)]
pub struct LogsParams {
    /// 조회 시작 시각 (Unix 타임스탬프, 밀리초)
    pub start: i64,
    /// 조회 종료 시각 (Unix 타임스탬프, 밀리초)
    pub end: i64,
    /// 서비스 필터
    pub service: Option<String>,
    /// 심각도 필터 문자열 (DEBUG | INFO | WARN | ERROR).
    /// OTel severity_number로 변환: DEBUG≥5, INFO≥9, WARN≥13, ERROR≥17.
    /// 프론트엔드에서 텍스트로 전달하므로 String으로 수신한다.
    pub severity: Option<String>,
    /// 풀텍스트 검색 (공백 분리 → 각 단어에 hasToken AND 조건)
    pub query: Option<String>,
    /// 특정 trace 로그 필터
    pub trace_id: Option<String>,
    /// 최대 반환 행 수 (기본 1000)
    pub limit: Option<u32>,
    /// 테넌트 ID (기본 "default")
    pub tenant_id: Option<String>,
}

/// GET /api/v1/logs/stream WebSocket 쿼리 파라미터.
#[derive(Debug, Deserialize)]
pub struct LogsStreamParams {
    /// 서비스 필터
    pub service: Option<String>,
    /// 심각도 필터 문자열 (DEBUG | INFO | WARN | ERROR)
    pub severity: Option<String>,
    /// 풀텍스트 필터
    pub query: Option<String>,
    /// 테넌트 ID (기본 "default")
    pub tenant_id: Option<String>,
}

// ---------------------------------------------------------------------------
// 응답 타입
// ---------------------------------------------------------------------------

/// 개별 로그 항목 — 프론트엔드 wire 포맷.
#[derive(Debug, Serialize, Deserialize)]
pub struct LogEntry {
    /// 타임스탬프 (Unix ms)
    pub ts: i64,
    pub service: String,
    pub severity: String,
    pub body: String,
    pub trace_id: String,
    pub span_id: String,
    /// attrs_keys + attrs_values를 key:value 객체로 병합
    pub attrs: serde_json::Value,
}

/// GET /api/v1/logs 응답.
#[derive(Debug, Serialize)]
pub struct LogsResponse {
    pub logs: Vec<LogEntry>,
    pub total: u64,
}

// ---------------------------------------------------------------------------
// ClickHouse Row — 내부 조회용
// ---------------------------------------------------------------------------

/// ClickHouse에서 읽어오는 raw Row.
#[derive(Debug, Deserialize, Row)]
struct LogRowRaw {
    ts: i64,
    service: String,
    severity: String,
    body: String,
    trace_id: String,
    span_id: String,
    attrs_keys: Vec<String>,
    attrs_values: Vec<String>,
}

// ---------------------------------------------------------------------------
// SQL 이스케이프 헬퍼
// ---------------------------------------------------------------------------

/// ClickHouse String 리터럴용 이스케이프.
/// `\` → `\\`, `'` → `\'` 로 치환하여 SQL 인젝션을 방지한다.
fn escape_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// OTel LogSeverity 텍스트를 최소 severity_number로 변환한다.
/// DEBUG=5~8, INFO=9~12, WARN=13~16, ERROR=17~20, FATAL=21~24.
/// 알 수 없는 값은 None 반환 (필터 없이 전체 조회).
fn severity_text_to_min_number(s: &str) -> Option<u8> {
    match s.to_ascii_uppercase().as_str() {
        "TRACE" => Some(1),
        "DEBUG" => Some(5),
        "INFO"  => Some(9),
        "WARN" | "WARNING" => Some(13),
        "ERROR" => Some(17),
        "FATAL" => Some(21),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 쿼리 빌더
// ---------------------------------------------------------------------------

/// LogsParams에서 WHERE 절 조건 목록을 구성한다.
fn build_where_conditions(
    tenant_id: &str,
    start: i64,
    end: i64,
    service: &Option<String>,
    severity: &Option<String>,
    query_text: &Option<String>,
    trace_id: &Option<String>,
) -> Vec<String> {
    let mut conditions = vec![
        format!("tenant_id = '{}'", escape_str(tenant_id)),
        format!("timestamp >= fromUnixTimestamp64Milli({})", start),
        format!("timestamp <  fromUnixTimestamp64Milli({})", end),
    ];

    if let Some(svc) = service {
        conditions.push(format!("service = '{}'", escape_str(svc)));
    }

    if let Some(sev_str) = severity {
        if let Some(min_num) = severity_text_to_min_number(sev_str) {
            conditions.push(format!("severity_number >= {}", min_num));
        }
    }

    if let Some(tid) = trace_id {
        // trace_id는 hex string — bloom_filter 인덱스 활용
        conditions.push(format!("trace_id = '{}'", escape_str(tid)));
    }

    // 풀텍스트: 공백으로 분리한 각 단어에 hasToken(body, word) AND 조건
    // tokenbf_v1 인덱스가 활용된다.
    if let Some(q) = query_text {
        for word in q.split_whitespace() {
            if !word.is_empty() {
                conditions.push(format!("hasToken(body, '{}')", escape_str(word)));
            }
        }
    }

    conditions
}

/// WHERE 조건 목록을 AND로 결합한다.
fn join_conditions(conditions: &[String]) -> String {
    conditions.join("\n  AND ")
}

// ---------------------------------------------------------------------------
// LogRowRaw → LogEntry 변환
// ---------------------------------------------------------------------------

fn raw_to_entry(raw: LogRowRaw) -> LogEntry {
    // attrs_keys + attrs_values → serde_json::Value::Object
    let attrs = {
        let mut map = serde_json::Map::new();
        for (k, v) in raw.attrs_keys.iter().zip(raw.attrs_values.iter()) {
            map.insert(k.clone(), serde_json::Value::String(v.clone()));
        }
        serde_json::Value::Object(map)
    };

    LogEntry {
        ts: raw.ts,
        service: raw.service,
        severity: raw.severity,
        body: raw.body,
        trace_id: raw.trace_id,
        span_id: raw.span_id,
        attrs,
    }
}

// ---------------------------------------------------------------------------
// 핵심 쿼리 함수
// ---------------------------------------------------------------------------

/// ClickHouse에서 로그를 조회하고 LogEntry 목록을 반환한다.
pub async fn query_logs(
    client: &clickhouse::Client,
    params: &LogsParams,
) -> Result<LogsResponse> {
    let tenant_id = params.tenant_id.as_deref().unwrap_or("default");
    let limit = params.limit.unwrap_or(1000);

    let conditions = build_where_conditions(
        tenant_id,
        params.start,
        params.end,
        &params.service,
        &params.severity,
        &params.query,
        &params.trace_id,
    );
    let where_clause = join_conditions(&conditions);

    let logs_sql = format!(
        r#"SELECT
    toUnixTimestamp64Milli(timestamp) AS ts,
    service,
    severity_text                     AS severity,
    body,
    trace_id,
    span_id,
    attrs_keys,
    attrs_values
FROM datacat.logs
WHERE {where_clause}
ORDER BY timestamp DESC
LIMIT {limit}"#,
        where_clause = where_clause,
        limit = limit,
    );

    debug!(sql = %logs_sql, "logs 쿼리 실행");

    let raw_rows: Vec<LogRowRaw> = client
        .query(&logs_sql)
        .fetch_all()
        .await
        .unwrap_or_else(|e| {
            error!(error = %e, "logs 쿼리 실패");
            Vec::new()
        });

    let total = raw_rows.len() as u64;
    let logs: Vec<LogEntry> = raw_rows.into_iter().map(raw_to_entry).collect();

    Ok(LogsResponse { logs, total })
}

/// 라이브테일용 최근 N개 로그 조회 (단순 최근 N개, 시간 범위 없음).
async fn query_live_logs(
    client: &clickhouse::Client,
    tenant_id: &str,
    service: &Option<String>,
    severity: &Option<String>,
    query_text: &Option<String>,
    limit: u32,
) -> Vec<LogEntry> {
    // 라이브테일: 현재 시각 기준 최근 10분 내 로그 조회
    let now_ms = chrono::Utc::now().timestamp_millis();
    let start_ms = now_ms - 600_000; // 10분 전

    let conditions = build_where_conditions(
        tenant_id,
        start_ms,
        now_ms,
        service,
        severity,
        query_text,
        &None,
    );
    let where_clause = join_conditions(&conditions);

    let sql = format!(
        r#"SELECT
    toUnixTimestamp64Milli(timestamp) AS ts,
    service,
    severity_text                     AS severity,
    body,
    trace_id,
    span_id,
    attrs_keys,
    attrs_values
FROM datacat.logs
WHERE {where_clause}
ORDER BY timestamp DESC
LIMIT {limit}"#,
        where_clause = where_clause,
        limit = limit,
    );

    client
        .query(&sql)
        .fetch_all::<LogRowRaw>()
        .await
        .unwrap_or_else(|e| {
            error!(error = %e, "라이브테일 쿼리 실패");
            Vec::new()
        })
        .into_iter()
        .map(raw_to_entry)
        .collect()
}

// ---------------------------------------------------------------------------
// HTTP 핸들러
// ---------------------------------------------------------------------------

/// GET /api/v1/logs
pub async fn logs_handler(
    State(state): State<Arc<crate::AppState>>,
    Query(params): Query<LogsParams>,
) -> impl IntoResponse {
    match query_logs(&state.ch_client, &params).await {
        Ok(result) => (StatusCode::OK, axum::Json(result)).into_response(),
        Err(e) => {
            error!(error = %e, "Logs 쿼리 실패");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "internal server error" })),
            )
                .into_response()
        }
    }
}

/// GET /api/v1/logs/stream — WebSocket 라이브테일
///
/// 클라이언트가 WebSocket 연결 시 1초마다 최근 100개 로그를 JSON 배열로 전송한다.
/// 클라이언트가 연결을 끊으면 루프를 종료한다.
pub async fn logs_stream_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<crate::AppState>>,
    Query(params): Query<LogsStreamParams>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_logs_stream(socket, state, params))
}

/// WebSocket 연결 핸들러 — 1초마다 최근 100개 로그를 전송한다.
async fn handle_logs_stream(
    mut socket: WebSocket,
    state: Arc<crate::AppState>,
    params: LogsStreamParams,
) {
    let tenant_id = params
        .tenant_id
        .as_deref()
        .unwrap_or("default")
        .to_string();

    let mut ticker = interval(Duration::from_secs(1));

    loop {
        tokio::select! {
            _ = ticker.tick() => {
                let entries = query_live_logs(
                    &state.ch_client,
                    &tenant_id,
                    &params.service,
                    &params.severity,
                    &params.query,
                    100,
                ).await;

                let payload = match serde_json::to_string(&entries) {
                    Ok(s) => s,
                    Err(e) => {
                        error!(error = %e, "라이브테일 JSON 직렬화 실패");
                        continue;
                    }
                };

                if socket.send(Message::Text(payload)).await.is_err() {
                    // 클라이언트 연결 종료
                    debug!("라이브테일 클라이언트 연결 종료");
                    break;
                }
            }
            // 클라이언트로부터 메시지 수신 (Close 포함)
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
                    _ => {} // Ping/Pong/Text — 무시
                }
            }
        }
    }
}
