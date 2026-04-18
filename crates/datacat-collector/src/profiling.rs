//! pprof / JFR 프로파일 수신 핸들러
//!
//! 대상 앱(Go, JVM 등)에서 직접 profiling 데이터를 POST로 전송한다.
//! 수신한 raw bytes를 base64로 래핑하여 Kafka "datacat.profiles" 토픽에 publish한다.
//!
//! 수신 오버헤드 목표: 대상 앱 CPU 영향 < 1%
//! 처리 전략: 헤더 파싱 + base64 인코딩만 수행하고 모든 파싱은 ingester에 위임.

use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, error, warn};

// ---------------------------------------------------------------------------
// 메시지 타입 (Kafka 전송용)
// ---------------------------------------------------------------------------

/// Kafka "datacat.profiles" 토픽에 전송되는 JSON 래퍼.
/// ingester가 이 구조를 역직렬화하여 ClickHouse에 삽입한다.
#[derive(Debug, Serialize, Deserialize)]
pub struct ProfilePayload {
    /// 테넌트 ID (X-Datacat-Tenant 헤더, 없으면 "default")
    pub tenant_id: String,
    /// 서비스 이름 (X-Datacat-Service 헤더)
    pub service: String,
    /// 환경 (X-Datacat-Env 헤더, e.g. production, staging)
    pub env: String,
    /// 프로파일 타입 (X-Datacat-Type 헤더, e.g. cpu, heap, goroutine, block)
    pub profile_type: String,
    /// 수신 시각 (Unix 나노초)
    pub timestamp_ns: u64,
    /// pprof 또는 JFR raw bytes를 Base64 인코딩한 값
    pub data_base64: String,
}

// ---------------------------------------------------------------------------
// 헤더 파싱 헬퍼
// ---------------------------------------------------------------------------

/// 헤더 맵에서 UTF-8 문자열 값을 추출한다.
/// 헤더 값에 비ASCII 바이트나 파싱 실패 시 빈 문자열을 반환한다.
fn header_str(headers: &HeaderMap, name: &str) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

/// 현재 Unix 시각을 나노초로 반환한다.
fn now_unix_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

/// POST /api/v1/profiles
///
/// 요청 헤더:
/// - `X-Datacat-Service`: 서비스 이름 (필수)
/// - `X-Datacat-Env`: 환경 (선택, 기본: "production")
/// - `X-Datacat-Type`: 프로파일 타입 (선택, 기본: "cpu")
/// - `X-Datacat-Tenant`: 테넌트 ID (선택, 기본: "default")
///
/// Content-Type: application/octet-stream (pprof binary) 또는
///              application/x-pprof (Go pprof HTTP endpoint 호환)
///              application/json (래핑된 경우)
///
/// 처리:
/// 1. 헤더에서 메타데이터 추출
/// 2. payload를 Base64 인코딩
/// 3. Kafka "datacat.profiles" 토픽으로 JSON publish
/// 4. 200 OK 반환 (fire-and-forget — Kafka 전송 실패도 200 반환하여 앱 영향 최소화)
pub async fn ingest_profile(
    State(state): State<Arc<super::http::ProfilesState>>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    if body.is_empty() {
        warn!("빈 profile payload 수신 — 무시");
        return StatusCode::BAD_REQUEST;
    }

    // 헤더에서 메타데이터 추출
    let service = {
        let s = header_str(&headers, "x-datacat-service");
        if s.is_empty() { "unknown".to_string() } else { s }
    };
    let env = {
        let e = header_str(&headers, "x-datacat-env");
        if e.is_empty() { "production".to_string() } else { e }
    };
    let profile_type = {
        let t = header_str(&headers, "x-datacat-type");
        if t.is_empty() { "cpu".to_string() } else { t }
    };
    let tenant_id = {
        let tid = header_str(&headers, "x-datacat-tenant");
        if tid.is_empty() { "default".to_string() } else { tid }
    };

    let timestamp_ns = now_unix_ns();
    let data_base64 = BASE64.encode(&body);

    debug!(
        service = %service,
        env = %env,
        profile_type = %profile_type,
        tenant_id = %tenant_id,
        bytes = body.len(),
        "profile 수신"
    );

    let payload = ProfilePayload {
        tenant_id: tenant_id.clone(),
        service: service.clone(),
        env,
        profile_type,
        timestamp_ns,
        data_base64,
    };

    // JSON 직렬화 — 실패 시 서버 오류 반환
    let json = match serde_json::to_vec(&payload) {
        Ok(j) => j,
        Err(e) => {
            error!(error = %e, "profile payload JSON 직렬화 실패");
            return StatusCode::INTERNAL_SERVER_ERROR;
        }
    };

    // Kafka fire-and-forget 전송
    // 앱 수집 오버헤드를 최소화하기 위해 Kafka 실패 시에도 200 반환
    let kafka_key = format!("{}:{}", tenant_id, service);
    state
        .producer
        .send_best_effort(&state.profiles_topic, &kafka_key, &json)
        .await;

    StatusCode::OK
}
