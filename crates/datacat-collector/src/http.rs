//! OTLP HTTP 수신기 (axum 기반)
//!
//! OTLP/HTTP 스펙에 따라 Protobuf 인코딩 요청을 수신한다.
//! - POST /v1/traces   (Content-Type: application/x-protobuf)
//! - POST /v1/logs     (Content-Type: application/x-protobuf)
//! - POST /v1/metrics  (Content-Type: application/x-protobuf)
//!
//! Phase 4: pprof/JFR 프로파일 수신 엔드포인트 추가.
//! - POST /api/v1/profiles (Content-Type: application/octet-stream)
//!
//! JSON 인코딩(application/json)도 추후 지원 예정이나
//! 성능 우선으로 Protobuf를 기본으로 한다.

use crate::producer::KafkaProducer;
use anyhow::Result;
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::post,
};
use opentelemetry_proto::tonic::collector::{
    logs::v1::ExportLogsServiceRequest,
    metrics::v1::ExportMetricsServiceRequest,
    trace::v1::ExportTraceServiceRequest,
};
use prost::Message;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::trace::TraceLayer;
use tracing::{debug, error, info};

// ---------------------------------------------------------------------------
// 공유 상태
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct AppState {
    producer: KafkaProducer,
}

/// profiling 핸들러용 공유 상태.
/// http.rs 외부(profiling.rs)에서도 접근할 수 있도록 pub으로 노출한다.
#[derive(Clone)]
pub struct ProfilesState {
    pub producer: KafkaProducer,
    /// Kafka profiles 토픽 이름 (기본: "datacat.profiles")
    pub profiles_topic: String,
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

/// POST /v1/traces — OTLP/HTTP trace export 처리
async fn export_traces(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> impl IntoResponse {
    match ExportTraceServiceRequest::decode(body) {
        Ok(req) => {
            let span_count: usize = req
                .resource_spans
                .iter()
                .flat_map(|rs| &rs.scope_spans)
                .map(|ss| ss.spans.len())
                .sum();
            debug!(span_count, "HTTP /v1/traces 수신");

            let payload = req.encode_to_vec();
            state
                .producer
                .send_best_effort("datacat.spans", "trace", &payload)
                .await;

            StatusCode::OK
        }
        Err(e) => {
            error!(error = %e, "trace 요청 디코딩 실패");
            StatusCode::BAD_REQUEST
        }
    }
}

/// POST /v1/logs — OTLP/HTTP log export 처리
async fn export_logs(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> impl IntoResponse {
    match ExportLogsServiceRequest::decode(body) {
        Ok(req) => {
            let log_count: usize = req
                .resource_logs
                .iter()
                .flat_map(|rl| &rl.scope_logs)
                .map(|sl| sl.log_records.len())
                .sum();
            debug!(log_count, "HTTP /v1/logs 수신");

            let payload = req.encode_to_vec();
            state
                .producer
                .send_best_effort("datacat.logs", "logs", &payload)
                .await;

            StatusCode::OK
        }
        Err(e) => {
            error!(error = %e, "logs 요청 디코딩 실패");
            StatusCode::BAD_REQUEST
        }
    }
}

/// POST /v1/metrics — OTLP/HTTP metrics export 처리
async fn export_metrics(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> impl IntoResponse {
    match ExportMetricsServiceRequest::decode(body) {
        Ok(req) => {
            let metric_count: usize = req
                .resource_metrics
                .iter()
                .flat_map(|rm| &rm.scope_metrics)
                .map(|sm| sm.metrics.len())
                .sum();
            debug!(metric_count, "HTTP /v1/metrics 수신");

            let payload = req.encode_to_vec();
            state
                .producer
                .send_best_effort("datacat.metrics", "metrics", &payload)
                .await;

            StatusCode::OK
        }
        Err(e) => {
            error!(error = %e, "metrics 요청 디코딩 실패");
            StatusCode::BAD_REQUEST
        }
    }
}

/// GET /health — 헬스체크 (로드밸런서용)
async fn health() -> impl IntoResponse {
    StatusCode::OK
}

// ---------------------------------------------------------------------------
// 서버 기동
// ---------------------------------------------------------------------------

/// HTTP 서버를 주어진 주소에 바인딩한다.
///
/// `profiles_topic`: Kafka profiles 토픽 이름 (기본: "datacat.profiles")
pub async fn serve(addr: SocketAddr, producer: KafkaProducer, profiles_topic: String) -> Result<()> {
    info!(%addr, "HTTP 서버 시작");

    // OTLP 엔드포인트용 상태
    let otlp_state = Arc::new(AppState { producer: producer.clone() });

    // Profiling 엔드포인트용 상태 (별도 Arc — 토픽 이름 포함)
    let profiles_state = Arc::new(crate::http::ProfilesState {
        producer,
        profiles_topic,
    });

    // profiling 서브라우터 — profiles_state를 with_state로 주입
    let profiles_router: Router = Router::new()
        .route("/api/v1/profiles", post(crate::profiling::ingest_profile))
        .with_state(profiles_state);

    // OTLP 서브라우터
    let otlp_router: Router = Router::new()
        .route("/v1/traces", post(export_traces))
        .route("/v1/logs", post(export_logs))
        .route("/v1/metrics", post(export_metrics))
        .route("/health", axum::routing::get(health))
        .with_state(otlp_state);

    // 두 라우터를 merge하여 하나의 axum App으로 서빙
    let app = otlp_router
        .merge(profiles_router)
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .await
        .map_err(|e| anyhow::anyhow!("HTTP 서버 오류: {}", e))?;

    Ok(())
}
