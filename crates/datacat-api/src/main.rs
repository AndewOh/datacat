//! datacat-api — REST API Gateway 진입점
//!
//! 외부 클라이언트(대시보드, CLI, SDK)의 단일 진입점.
//! 인증/인가 처리 후 datacat-query 서비스로 프록시한다.
//!
//! 환경변수:
//!   DATACAT_AUTH_ENABLED   — "true" 이면 X-API-Key 인증 활성화 (기본: false)
//!   DATACAT_ADMIN_URL      — datacat-admin URL (기본: http://localhost:9093)

mod auth;
mod routes;

use anyhow::Result;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::{EnvFilter, fmt};

/// API Gateway 설정.
pub struct ApiConfig {
    pub listen_addr: String,
    pub query_service_url: String,
    pub insights_service_url: String,
    pub admin_service_url: String,
    pub alerting_service_url: String,
}

fn load_config() -> ApiConfig {
    ApiConfig {
        listen_addr: std::env::var("DATACAT_LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8000".to_string()),
        query_service_url: std::env::var("DATACAT_QUERY_SERVICE_URL")
            .unwrap_or_else(|_| "http://localhost:8001".to_string()),
        insights_service_url: std::env::var("DATACAT_INSIGHTS_SERVICE_URL")
            .unwrap_or_else(|_| "http://localhost:9091".to_string()),
        admin_service_url: std::env::var("DATACAT_ADMIN_URL")
            .unwrap_or_else(|_| "http://localhost:9093".to_string()),
        alerting_service_url: std::env::var("DATACAT_ALERTING_SERVICE_URL")
            .unwrap_or_else(|_| "http://localhost:9090".to_string()),
    }
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
        "datacat-api 시작"
    );

    let cfg = load_config();

    // reqwest Client는 연결 풀을 내부적으로 관리하므로 Arc 없이 clone 가능
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    let auth_config = crate::auth::AuthConfig::from_env();

    let state = Arc::new(routes::ApiState {
        query_service_url: cfg.query_service_url.clone(),
        insights_service_url: cfg.insights_service_url.clone(),
        admin_service_url: cfg.admin_service_url.clone(),
        alerting_service_url: cfg.alerting_service_url.clone(),
        http_client,
        auth_config,
    });

    let app = routes::build_router(state);

    let listener = tokio::net::TcpListener::bind(&cfg.listen_addr).await?;
    info!(addr = %cfg.listen_addr, "API Gateway 대기 중");

    axum::serve(listener, app).await?;

    Ok(())
}
