//! datacat-ingester — Redpanda consumer + ClickHouse writer 진입점
//!
//! Redpanda(Kafka) 토픽에서 OTLP 메시지를 소비하여
//! ClickHouse에 배치 삽입한다.
//!
//! 처리 흐름:
//! 1. Kafka consumer가 토픽에서 메시지 수신
//! 2. Protobuf 디코딩 → datacat-common 도메인 타입으로 변환
//! 3. ClickHouse inserter에 누적
//! 4. 배치 크기(10k) 또는 flush 주기(1s) 도달 시 일괄 삽입

mod consumer;
mod logs_writer;
mod metrics_writer;
mod profiling_writer;
mod writer;

use anyhow::Result;
use tracing::info;
use tracing_subscriber::{EnvFilter, fmt};

/// Ingester 설정.
#[derive(Debug, serde::Deserialize)]
pub struct IngesterConfig {
    pub kafka_brokers: String,
    pub kafka_group: String,
    pub clickhouse_url: String,
    pub clickhouse_db: String,
    pub clickhouse_user: String,
    pub clickhouse_password: String,
    pub flush_interval_ms: u64,
    pub batch_size: usize,
}

fn load_config() -> IngesterConfig {
    IngesterConfig {
        kafka_brokers: std::env::var("DATACAT_KAFKA_BROKERS")
            .unwrap_or_else(|_| "localhost:9092".to_string()),
        kafka_group: std::env::var("DATACAT_KAFKA_GROUP")
            .unwrap_or_else(|_| "datacat-ingester".to_string()),
        clickhouse_url: std::env::var("DATACAT_CLICKHOUSE_URL")
            .unwrap_or_else(|_| "http://localhost:8123".to_string()),
        clickhouse_db: std::env::var("DATACAT_CLICKHOUSE_DB")
            .unwrap_or_else(|_| "datacat".to_string()),
        clickhouse_user: std::env::var("DATACAT_CLICKHOUSE_USER")
            .unwrap_or_else(|_| "datacat".to_string()),
        clickhouse_password: std::env::var("DATACAT_CLICKHOUSE_PASSWORD")
            .unwrap_or_else(|_| "datacat_dev".to_string()),
        flush_interval_ms: std::env::var("DATACAT_FLUSH_INTERVAL_MS")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(1000),
        batch_size: std::env::var("DATACAT_BATCH_SIZE")
            .ok().and_then(|v| v.parse().ok()).unwrap_or(10_000),
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
        "datacat-ingester 시작"
    );

    let cfg = load_config();

    // ClickHouse 클라이언트 초기화
    let ch_client = clickhouse::Client::default()
        .with_url(&cfg.clickhouse_url)
        .with_database(&cfg.clickhouse_db)
        .with_user(&cfg.clickhouse_user)
        .with_password(&cfg.clickhouse_password);

    // 스키마 초기화 (DDL 실행)
    writer::init_schema(&ch_client).await?;

    // ---------------------------------------------------------------------------
    // Spans 파이프라인: datacat.spans 전용 consumer + writer
    // ---------------------------------------------------------------------------

    let (spans_tx, spans_rx) = tokio::sync::mpsc::channel::<consumer::KafkaMessage>(cfg.batch_size * 2);

    let spans_consumer_handle = tokio::spawn(consumer::run_consumer(
        cfg.kafka_brokers.clone(),
        format!("{}-spans", cfg.kafka_group),
        vec!["datacat.spans".to_string()],
        spans_tx,
    ));

    let spans_writer_handle = tokio::spawn(writer::run_writer(
        ch_client.clone(),
        spans_rx,
        cfg.batch_size,
        cfg.flush_interval_ms,
    ));

    // ---------------------------------------------------------------------------
    // Logs 파이프라인: datacat.logs 전용 consumer + logs_writer
    // ---------------------------------------------------------------------------

    let (logs_tx, logs_rx) = tokio::sync::mpsc::channel::<consumer::KafkaMessage>(cfg.batch_size * 2);

    let logs_consumer_handle = tokio::spawn(consumer::run_consumer(
        cfg.kafka_brokers.clone(),
        format!("{}-logs", cfg.kafka_group),
        vec!["datacat.logs".to_string()],
        logs_tx,
    ));

    let logs_writer_handle = tokio::spawn(logs_writer::run_logs_writer(
        ch_client.clone(),
        logs_rx,
        cfg.batch_size,
        cfg.flush_interval_ms,
    ));

    // ---------------------------------------------------------------------------
    // Metrics 파이프라인: datacat.metrics 전용 consumer + metrics_writer
    // ---------------------------------------------------------------------------

    let (metrics_tx, metrics_rx) = tokio::sync::mpsc::channel::<consumer::KafkaMessage>(cfg.batch_size * 2);

    let metrics_consumer_handle = tokio::spawn(consumer::run_consumer(
        cfg.kafka_brokers.clone(),
        format!("{}-metrics", cfg.kafka_group),
        vec!["datacat.metrics".to_string()],
        metrics_tx,
    ));

    let metrics_writer_handle = tokio::spawn(metrics_writer::run_metrics_writer(
        ch_client.clone(),
        metrics_rx,
        cfg.batch_size,
        cfg.flush_interval_ms,
    ));

    // ---------------------------------------------------------------------------
    // Profiles 파이프라인: datacat.profiles 전용 consumer + profiling_writer
    // ---------------------------------------------------------------------------
    // 프로파일은 크기가 크므로 배치 크기를 100으로 캡핑, flush 주기는 5초로 설정.

    let (profiles_tx, profiles_rx) = tokio::sync::mpsc::channel::<consumer::KafkaMessage>(200);

    let profiles_consumer_handle = tokio::spawn(consumer::run_consumer(
        cfg.kafka_brokers.clone(),
        format!("{}-profiles", cfg.kafka_group),
        vec!["datacat.profiles".to_string()],
        profiles_tx,
    ));

    // flush_interval_ms를 5000ms로 고정 (프로파일 특성상 더 느슨한 flush)
    let profiles_flush_interval_ms = cfg.flush_interval_ms.max(5_000);
    let profiles_writer_handle = tokio::spawn(profiling_writer::run_profiles_writer(
        ch_client.clone(),
        profiles_rx,
        cfg.batch_size,
        profiles_flush_interval_ms,
    ));

    info!("spans/logs/metrics/profiles 파이프라인 모두 시작 완료");

    // 어느 태스크라도 먼저 종료되면 전체 프로세스를 종료한다.
    tokio::select! {
        res = spans_consumer_handle => {
            if let Err(e) = res { tracing::error!("spans consumer 태스크 오류: {}", e); }
        }
        res = spans_writer_handle => {
            if let Err(e) = res { tracing::error!("spans writer 태스크 오류: {}", e); }
        }
        res = logs_consumer_handle => {
            if let Err(e) = res { tracing::error!("logs consumer 태스크 오류: {}", e); }
        }
        res = logs_writer_handle => {
            if let Err(e) = res { tracing::error!("logs writer 태스크 오류: {}", e); }
        }
        res = metrics_consumer_handle => {
            if let Err(e) = res { tracing::error!("metrics consumer 태스크 오류: {}", e); }
        }
        res = metrics_writer_handle => {
            if let Err(e) = res { tracing::error!("metrics writer 태스크 오류: {}", e); }
        }
        res = profiles_consumer_handle => {
            if let Err(e) = res { tracing::error!("profiles consumer 태스크 오류: {}", e); }
        }
        res = profiles_writer_handle => {
            if let Err(e) = res { tracing::error!("profiles writer 태스크 오류: {}", e); }
        }
    }

    Ok(())
}
