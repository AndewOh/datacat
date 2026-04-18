//! datacat-api — REST API Gateway 진입점
//!
//! 외부 클라이언트(대시보드, CLI, SDK)의 단일 진입점.
//! 인증/인가 처리 후 datacat-query 서비스로 프록시한다.
//!
//! 환경변수:
//!   DATACAT_AUTH_ENABLED   — "true" 이면 X-API-Key 인증 활성화 (기본: false)
//!   DATACAT_ADMIN_URL      — datacat-admin URL (기본: http://localhost:9092)

mod auth;
mod routes;

use anyhow::Result;
use std::sync::Arc;
use tracing::{info, warn};
use tracing_subscriber::{EnvFilter, fmt};

/// API Gateway 설정.
#[derive(Debug, serde::Deserialize)]
pub struct ApiConfig {
    #[serde(default = "default_listen_addr")]
    pub listen_addr: String,

    /// datacat-query 서비스 URL (내부 서비스 디스커버리)
    #[serde(default = "default_query_service_url")]
    pub query_service_url: String,

    /// datacat-insights 서비스 URL (기본: http://localhost:9091)
    #[serde(default = "default_insights_service_url")]
    pub insights_service_url: String,

    /// datacat-admin 서비스 URL (기본: http://localhost:9092)
    #[serde(default = "default_admin_service_url")]
    pub admin_service_url: String,
}

fn default_listen_addr() -> String { "0.0.0.0:8000".to_string() }
fn default_query_service_url() -> String { "http://localhost:8080".to_string() }
fn default_insights_service_url() -> String { "http://localhost:9091".to_string() }
fn default_admin_service_url() -> String { "http://localhost:9092".to_string() }

impl Default for ApiConfig {
    fn default() -> Self {
        ApiConfig {
            listen_addr: default_listen_addr(),
            query_service_url: default_query_service_url(),
            insights_service_url: default_insights_service_url(),
            admin_service_url: default_admin_service_url(),
        }
    }
}

fn load_config() -> ApiConfig {
    let builder = config::Config::builder()
        .add_source(config::File::with_name("config").required(false))
        .add_source(config::Environment::with_prefix("DATACAT").separator("_"));

    match builder.build() {
        Ok(cfg) => cfg.try_deserialize().unwrap_or_else(|e| {
            warn!("설정 역직렬화 실패, 기본값 사용: {}", e);
            ApiConfig::default()
        }),
        Err(e) => {
            warn!("설정 로드 실패, 기본값 사용: {}", e);
            ApiConfig::default()
        }
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
        http_client,
        auth_config,
    });

    let app = routes::build_router(state);

    let listener = tokio::net::TcpListener::bind(&cfg.listen_addr).await?;
    info!(addr = %cfg.listen_addr, "API Gateway 대기 중");

    axum::serve(listener, app).await?;

    Ok(())
}
