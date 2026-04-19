//! datacat-alerting — Alerting & Incident 서비스 진입점
//!
//! Monitor(알림 규칙)를 관리하고 ClickHouse에서 주기적으로 평가하여
//! 조건 위반 시 Incident를 생성하고 Slack/Webhook으로 알림을 발송한다.
//!
//! - REST API: axum (0.0.0.0:9090)
//! - 평가 엔진: 백그라운드 tokio 태스크 (10초 tick)
//! - 저장소: In-memory Arc<RwLock<Vec<_>>> (Phase 7에서 영속화 예정)

mod api;
mod evaluator;
mod incident;
mod monitor;
mod notifier;

use anyhow::Result;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};
use tracing_subscriber::{EnvFilter, fmt};

/// Alerting 서비스 설정.
pub struct AlertingConfig {
    pub listen_addr: String,
    pub clickhouse_url: String,
    pub clickhouse_db: String,
    pub clickhouse_user: String,
    pub clickhouse_password: String,
}

fn load_config() -> AlertingConfig {
    AlertingConfig {
        listen_addr: std::env::var("DATACAT_LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:9090".to_string()),
        clickhouse_url: std::env::var("DATACAT_CLICKHOUSE_URL")
            .unwrap_or_else(|_| "http://localhost:8123".to_string()),
        clickhouse_db: std::env::var("DATACAT_CLICKHOUSE_DB")
            .unwrap_or_else(|_| "datacat".to_string()),
        clickhouse_user: std::env::var("DATACAT_CLICKHOUSE_USER")
            .unwrap_or_else(|_| "datacat".to_string()),
        clickhouse_password: std::env::var("DATACAT_CLICKHOUSE_PASSWORD")
            .unwrap_or_else(|_| "datacat_dev".to_string()),
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
        "datacat-alerting 시작"
    );

    let cfg = load_config();

    // ClickHouse 클라이언트
    let ch_client = clickhouse::Client::default()
        .with_url(&cfg.clickhouse_url)
        .with_database(&cfg.clickhouse_db)
        .with_user(&cfg.clickhouse_user)
        .with_password(&cfg.clickhouse_password);

    // In-memory 저장소 (Phase 7에서 영속화)
    let monitors: Arc<RwLock<Vec<monitor::Monitor>>> =
        Arc::new(RwLock::new(Vec::new()));
    let incidents: Arc<RwLock<Vec<incident::Incident>>> =
        Arc::new(RwLock::new(Vec::new()));

    // reqwest Client (Slack/Webhook 알림용)
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_default();

    // 평가 엔진 백그라운드 태스크 시작
    let eval_monitors  = Arc::clone(&monitors);
    let eval_incidents = Arc::clone(&incidents);
    let eval_ch        = ch_client.clone();
    let eval_http      = http_client.clone();

    tokio::spawn(async move {
        if let Err(e) = evaluator::run_evaluator(
            eval_ch,
            eval_monitors,
            eval_incidents,
            eval_http,
        ).await {
            warn!(error = %e, "평가 엔진 종료 (예상치 못한 에러)");
        }
    });

    // REST API 서버
    let state = Arc::new(api::AlertingState {
        monitors,
        incidents,
        http_client,
    });

    let app = api::build_router(state);

    let listener = tokio::net::TcpListener::bind(&cfg.listen_addr).await?;
    info!(addr = %cfg.listen_addr, "Alerting API 서버 대기 중");

    axum::serve(listener, app).await?;

    Ok(())
}
