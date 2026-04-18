//! datacat-insights — AI Auto-Ops 인사이트 서비스
//!
//! Z-score 기반 이상 탐지, X-View 패턴 인식, LLM/규칙 기반 챗봇을 제공한다.
//!
//! - REST API: axum (기본 0.0.0.0:9091)
//! - 이상 탐지: sliding-window Z-score on error_rate, p99 latency
//! - 패턴 탐지: Surge, Waterfall, Droplet, Wave
//! - 챗봇: Ollama LLM 프록시 또는 규칙 기반 fallback
//!
//! 환경변수:
//! - DATACAT_LISTEN_ADDR      (기본: "0.0.0.0:9091")
//! - DATACAT_CLICKHOUSE_URL   (기본: "http://localhost:8123")
//! - DATACAT_CLICKHOUSE_DB    (기본: "datacat")
//! - DATACAT_CLICKHOUSE_USER  (기본: "datacat")
//! - DATACAT_CLICKHOUSE_PASSWORD (기본: "datacat_dev")
//! - OLLAMA_URL               (선택, 미설정 시 규칙 기반 챗봇 사용)

mod anomaly;
mod api;
mod chat;
mod patterns;
mod state;

use anyhow::Result;
use axum::Router;
use axum::routing::{get, post};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;
use tracing_subscriber::{EnvFilter, fmt};

use state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    // 로깅 초기화
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    info!(
        version = env!("CARGO_PKG_VERSION"),
        "datacat-insights 시작"
    );

    // 환경변수에서 설정 읽기
    let listen_addr = std::env::var("DATACAT_LISTEN_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:9091".to_string());
    let ch_url = std::env::var("DATACAT_CLICKHOUSE_URL")
        .unwrap_or_else(|_| "http://localhost:8123".to_string());
    let ch_db = std::env::var("DATACAT_CLICKHOUSE_DB")
        .unwrap_or_else(|_| "datacat".to_string());
    let ch_user = std::env::var("DATACAT_CLICKHOUSE_USER")
        .unwrap_or_else(|_| "datacat".to_string());
    let ch_password = std::env::var("DATACAT_CLICKHOUSE_PASSWORD")
        .unwrap_or_else(|_| "datacat_dev".to_string());
    let ollama_url = std::env::var("OLLAMA_URL").ok();

    if let Some(ref url) = ollama_url {
        info!(ollama_url = %url, "Ollama LLM 챗봇 활성화");
    } else {
        info!("OLLAMA_URL 미설정 — 규칙 기반 챗봇 모드");
    }

    // ClickHouse 클라이언트 초기화
    let ch_client = clickhouse::Client::default()
        .with_url(&ch_url)
        .with_database(&ch_db)
        .with_user(&ch_user)
        .with_password(&ch_password);

    // HTTP 클라이언트 (Ollama 프록시용)
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(35))
        .build()
        .unwrap_or_default();

    // 공유 상태
    let state = Arc::new(AppState {
        ch_client,
        ollama_url,
        http_client,
    });

    // CORS 레이어
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // 라우터 빌드
    let app = Router::new()
        .route("/health", get(api::health_handler))
        .route("/api/v1/insights/analyze", post(api::analyze_handler))
        .route("/api/v1/insights/patterns", get(api::patterns_handler))
        .route("/api/v1/insights/chat", post(api::chat_handler))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&listen_addr).await?;
    info!(addr = %listen_addr, "Insights API 서버 대기 중");

    axum::serve(listener, app).await?;

    Ok(())
}
