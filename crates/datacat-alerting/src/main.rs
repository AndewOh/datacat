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
#[derive(Debug, serde::Deserialize)]
pub struct AlertingConfig {
    /// HTTP 서버 바인드 주소
    #[serde(default = "default_listen_addr")]
    pub listen_addr: String,

    /// ClickHouse HTTP URL
    #[serde(default = "default_clickhouse_url")]
    pub clickhouse_url: String,

    /// ClickHouse 데이터베이스 이름
    #[serde(default = "default_clickhouse_db")]
    pub clickhouse_db: String,
}

fn default_listen_addr()    -> String { "0.0.0.0:9090".to_string() }
fn default_clickhouse_url() -> String { "http://localhost:8123".to_string() }
fn default_clickhouse_db()  -> String { "datacat".to_string() }

impl Default for AlertingConfig {
    fn default() -> Self {
        AlertingConfig {
            listen_addr:    default_listen_addr(),
            clickhouse_url: default_clickhouse_url(),
            clickhouse_db:  default_clickhouse_db(),
        }
    }
}

fn load_config() -> AlertingConfig {
    let builder = config::Config::builder()
        .add_source(config::File::with_name("config").required(false))
        .add_source(config::Environment::with_prefix("DATACAT").separator("_"));

    match builder.build() {
        Ok(cfg) => cfg.try_deserialize().unwrap_or_else(|e| {
            warn!("설정 역직렬화 실패, 기본값 사용: {}", e);
            AlertingConfig::default()
        }),
        Err(e) => {
            warn!("설정 로드 실패, 기본값 사용: {}", e);
            AlertingConfig::default()
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
        "datacat-alerting 시작"
    );

    let cfg = load_config();

    // ClickHouse 클라이언트
    let ch_client = clickhouse::Client::default()
        .with_url(&cfg.clickhouse_url)
        .with_database(&cfg.clickhouse_db);

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
