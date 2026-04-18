//! datacat-collector — OTLP 수신기 진입점
//!
//! 두 가지 프로토콜을 동시에 수신한다:
//! - gRPC (OTLP/gRPC): 0.0.0.0:4317
//! - HTTP (OTLP/HTTP): 0.0.0.0:4318
//!
//! 수신된 데이터는 Redpanda(Kafka)에 produce하여
//! datacat-ingester가 ClickHouse로 비동기 배치 삽입하도록 한다.

mod grpc;
mod http;
mod producer;
mod profiling;
mod statsd;

use anyhow::Result;
use tracing::{info, warn};
use tracing_subscriber::{EnvFilter, fmt};

/// 수집기 설정.
/// config.toml 또는 환경변수 DATACAT_ 접두사로 오버라이드 가능.
#[derive(Debug, serde::Deserialize)]
pub struct CollectorConfig {
    /// gRPC 바인딩 주소
    #[serde(default = "default_grpc_addr")]
    pub grpc_addr: String,

    /// HTTP 바인딩 주소
    #[serde(default = "default_http_addr")]
    pub http_addr: String,

    /// Redpanda/Kafka 브로커 주소 목록
    #[serde(default = "default_kafka_brokers")]
    pub kafka_brokers: String,

    /// spans 토픽 이름
    #[serde(default = "default_spans_topic")]
    pub spans_topic: String,

    /// logs 토픽 이름
    #[serde(default = "default_logs_topic")]
    pub logs_topic: String,

    /// metrics 토픽 이름
    #[serde(default = "default_metrics_topic")]
    pub metrics_topic: String,

    /// profiles 토픽 이름 (Phase 4 pprof/JFR)
    #[serde(default = "default_profiles_topic")]
    pub profiles_topic: String,

    /// StatsD UDP 바인딩 주소
    #[serde(default = "default_statsd_bind")]
    pub statsd_bind: String,
}

fn default_grpc_addr() -> String { "0.0.0.0:4317".to_string() }
fn default_http_addr() -> String { "0.0.0.0:4318".to_string() }
fn default_kafka_brokers() -> String { "localhost:9092".to_string() }
fn default_spans_topic() -> String { "datacat.spans".to_string() }
fn default_logs_topic() -> String { "datacat.logs".to_string() }
fn default_metrics_topic() -> String { "datacat.metrics".to_string() }
fn default_profiles_topic() -> String { "datacat.profiles".to_string() }
fn default_statsd_bind() -> String { "0.0.0.0:8125".to_string() }

impl Default for CollectorConfig {
    fn default() -> Self {
        CollectorConfig {
            grpc_addr: default_grpc_addr(),
            http_addr: default_http_addr(),
            kafka_brokers: default_kafka_brokers(),
            spans_topic: default_spans_topic(),
            logs_topic: default_logs_topic(),
            metrics_topic: default_metrics_topic(),
            profiles_topic: default_profiles_topic(),
            statsd_bind: default_statsd_bind(),
        }
    }
}

/// 설정 파일을 로드한다. 파일이 없으면 기본값을 사용한다.
fn load_config() -> CollectorConfig {
    let builder = config::Config::builder()
        .add_source(
            config::File::with_name("config")
                .required(false),
        )
        .add_source(
            config::Environment::with_prefix("DATACAT")
                .separator("_"),
        );

    match builder.build() {
        Ok(cfg) => cfg.try_deserialize().unwrap_or_else(|e| {
            warn!("설정 역직렬화 실패, 기본값 사용: {}", e);
            CollectorConfig::default()
        }),
        Err(e) => {
            warn!("설정 로드 실패, 기본값 사용: {}", e);
            CollectorConfig::default()
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    // 구조화 로깅 초기화
    // RUST_LOG 환경변수로 필터 제어 (기본: info)
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .json()
        .init();

    info!(
        version = env!("CARGO_PKG_VERSION"),
        "datacat-collector 시작"
    );

    let cfg = load_config();
    info!(
        grpc_addr = %cfg.grpc_addr,
        http_addr = %cfg.http_addr,
        kafka_brokers = %cfg.kafka_brokers,
        "설정 로드 완료"
    );

    // Kafka 프로듀서 초기화
    let producer = producer::KafkaProducer::new(&cfg.kafka_brokers)?;

    let grpc_addr = cfg.grpc_addr.parse()?;
    let http_addr = cfg.http_addr.parse()?;
    let statsd_addr: std::net::SocketAddr = cfg.statsd_bind.parse()?;

    // gRPC 서버와 HTTP 서버를 병렬로 실행
    let grpc_server = grpc::serve(grpc_addr, producer.clone());
    let http_server = http::serve(http_addr, producer.clone(), cfg.profiles_topic.clone());

    // StatsD UDP 서버 — 별도 tokio 태스크로 실행
    let statsd_producer = producer.clone();
    let statsd_metrics_topic = cfg.metrics_topic.clone();
    let statsd_handle = tokio::spawn(async move {
        if let Err(e) = statsd::run_statsd(statsd_addr, statsd_producer, statsd_metrics_topic).await {
            tracing::error!("StatsD 서버 오류: {}", e);
        }
    });

    info!(
        "gRPC 서버: {}, HTTP 서버: {}, StatsD UDP: {} 대기 중",
        cfg.grpc_addr, cfg.http_addr, cfg.statsd_bind
    );

    // 세 서버를 동시에 실행; 하나라도 종료되면 전체 종료
    tokio::select! {
        res = grpc_server => {
            if let Err(e) = res {
                tracing::error!("gRPC 서버 오류: {}", e);
            }
        }
        res = http_server => {
            if let Err(e) = res {
                tracing::error!("HTTP 서버 오류: {}", e);
            }
        }
        _ = statsd_handle => {
            warn!("StatsD 서버 태스크 종료");
        }
    }

    Ok(())
}
