//! datacat-query — Query API 서버 진입점
//!
//! ClickHouse에서 데이터를 조회하여 X-View 형식으로 반환한다.
//! - REST API: axum (0.0.0.0:8080)
//! - Arrow Flight: 향후 추가 예정 (대용량 데이터 스트리밍)

mod logs;
mod metrics;
mod profiling;
mod xview;

use anyhow::Result;
use axum::{
    Router,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
};
use std::sync::Arc;
use tracing::{info, warn};
use tracing_subscriber::{EnvFilter, fmt};

/// Query 서버 설정.
#[derive(Debug, serde::Deserialize)]
pub struct QueryConfig {
    #[serde(default = "default_listen_addr")]
    pub listen_addr: String,

    #[serde(default = "default_clickhouse_url")]
    pub clickhouse_url: String,

    #[serde(default = "default_clickhouse_db")]
    pub clickhouse_db: String,
}

fn default_listen_addr() -> String { "0.0.0.0:8080".to_string() }
fn default_clickhouse_url() -> String { "http://localhost:8123".to_string() }
fn default_clickhouse_db() -> String { "datacat".to_string() }

impl Default for QueryConfig {
    fn default() -> Self {
        QueryConfig {
            listen_addr: default_listen_addr(),
            clickhouse_url: default_clickhouse_url(),
            clickhouse_db: default_clickhouse_db(),
        }
    }
}

fn load_config() -> QueryConfig {
    let builder = config::Config::builder()
        .add_source(config::File::with_name("config").required(false))
        .add_source(config::Environment::with_prefix("DATACAT").separator("_"));

    match builder.build() {
        Ok(cfg) => cfg.try_deserialize().unwrap_or_else(|e| {
            warn!("설정 역직렬화 실패, 기본값 사용: {}", e);
            QueryConfig::default()
        }),
        Err(e) => {
            warn!("설정 로드 실패, 기본값 사용: {}", e);
            QueryConfig::default()
        }
    }
}

/// 공유 애플리케이션 상태.
pub struct AppState {
    pub ch_client: clickhouse::Client,
}

#[tokio::main]
async fn main() -> Result<()> {
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .json()
        .init();

    info!(
        version = env!("CARGO_PKG_VERSION"),
        "datacat-query 시작"
    );

    let cfg = load_config();

    let ch_client = clickhouse::Client::default()
        .with_url(&cfg.clickhouse_url)
        .with_database(&cfg.clickhouse_db);

    let state = Arc::new(AppState { ch_client });

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/api/v1/xview", get(xview_handler))
        // Logs API (Phase 3)
        .route("/api/v1/logs", get(logs::logs_handler))
        .route("/api/v1/logs/stream", get(logs::logs_stream_handler))
        // Metrics API (Phase 2)
        .route("/api/v1/query_range", get(query_range_handler))
        .route("/api/v1/metrics", get(list_metrics_handler))
        .route("/api/v1/services", get(list_services_handler))
        // Profiling API (Phase 4)
        .route("/api/v1/profiles", get(profiling::list_profiles_handler))
        .route(
            "/api/v1/profiles/:profile_id/flamegraph",
            get(profiling::get_flamegraph_handler),
        )
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&cfg.listen_addr).await?;
    info!(addr = %cfg.listen_addr, "Query API 서버 대기 중");

    axum::serve(listener, app).await?;

    Ok(())
}

/// GET /health
async fn health_handler() -> impl IntoResponse {
    StatusCode::OK
}

/// GET /api/v1/xview
/// X-View: 서비스별 응답시간 분포 (히트맵) 데이터를 반환한다.
async fn xview_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<xview::XViewParams>,
) -> impl IntoResponse {
    match xview::query_xview(&state.ch_client, &params).await {
        Ok(result) => (StatusCode::OK, axum::Json(result)).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "X-View 쿼리 실패");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    }
}

/// GET /api/v1/query_range
/// PromQL-lite: 시계열 메트릭 조회.
async fn query_range_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<metrics::QueryRangeParams>,
) -> impl IntoResponse {
    info!(
        query = %params.query,
        start = params.start,
        end = params.end,
        "query_range 요청"
    );
    match metrics::query_range(&state.ch_client, &params).await {
        Ok(result) => (StatusCode::OK, axum::Json(result)).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "query_range 실패");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    }
}

/// GET /api/v1/metrics
/// 수집된 메트릭 이름 + 서비스 목록 반환.
async fn list_metrics_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TenantQuery>,
) -> impl IntoResponse {
    let tenant_id = params.tenant_id.as_deref().unwrap_or("default");
    match metrics::list_metrics(&state.ch_client, tenant_id).await {
        Ok(result) => (StatusCode::OK, axum::Json(result)).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "list_metrics 실패");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    }
}

/// GET /api/v1/services
/// spans + metrics 통합 서비스 목록 반환.
async fn list_services_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<TenantQuery>,
) -> impl IntoResponse {
    let tenant_id = params.tenant_id.as_deref().unwrap_or("default");
    match metrics::list_services(&state.ch_client, tenant_id).await {
        Ok(result) => (StatusCode::OK, axum::Json(result)).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "list_services 실패");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": e.to_string() })),
            )
                .into_response()
        }
    }
}

/// 테넌트 필터 공통 파라미터.
#[derive(Debug, serde::Deserialize)]
struct TenantQuery {
    pub tenant_id: Option<String>,
}
