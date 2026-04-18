//! Redpanda/Kafka 프로듀서
//!
//! rdkafka의 FutureProducer를 래핑하여 fire-and-forget 방식으로
//! spans/logs/metrics를 각 토픽에 비동기 전송한다.
//!
//! 성능 특성:
//! - queue.buffering.max.ms = 5ms: 지연과 처리량의 균형
//! - batch.num.messages = 10000: 배치 크기 최대화
//! - compression.type = lz4: CPU 효율적인 압축

use anyhow::{Context, Result};
use rdkafka::ClientConfig;
use rdkafka::producer::{FutureProducer, FutureRecord};
use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, warn};

/// 공유 가능한 Kafka 프로듀서 핸들.
/// `Arc`로 감싸 여러 핸들러에서 clone하여 사용한다.
#[derive(Clone)]
pub struct KafkaProducer {
    inner: Arc<FutureProducer>,
}

impl KafkaProducer {
    /// 새 프로듀서를 생성한다.
    pub fn new(brokers: &str) -> Result<Self> {
        let producer: FutureProducer = ClientConfig::new()
            .set("bootstrap.servers", brokers)
            // 배치 지연: 최대 5ms 기다린 후 전송 (처리량 vs 지연 트레이드오프)
            .set("queue.buffering.max.ms", "5")
            // 배치당 최대 메시지 수
            .set("batch.num.messages", "10000")
            // lz4 압축: snappy보다 CPU 효율적
            .set("compression.type", "lz4")
            // 전송 실패 시 재시도
            .set("retries", "3")
            // 전체 전송 타임아웃
            .set("message.timeout.ms", "5000")
            .create()
            .context("Kafka 프로듀서 생성 실패")?;

        Ok(KafkaProducer {
            inner: Arc::new(producer),
        })
    }

    /// 토픽에 메시지를 비동기 전송한다.
    /// `key`는 파티셔닝에 사용 (보통 tenant_id + trace_id).
    pub async fn send(&self, topic: &str, key: &str, payload: &[u8]) -> Result<()> {
        let record = FutureRecord::to(topic)
            .key(key)
            .payload(payload);

        self.inner
            .send(record, Duration::from_secs(0))
            .await
            .map_err(|(err, _msg)| {
                warn!(topic, key, error = %err, "Kafka 전송 실패");
                anyhow::anyhow!("Kafka 전송 오류: {}", err)
            })?;

        debug!(topic, key, bytes = payload.len(), "메시지 전송 완료");
        Ok(())
    }

    /// 파이어-앤-포겟 방식 전송. 에러를 무시하고 로깅만 한다.
    /// 수집 경로에서 Kafka 장애가 수집 자체를 차단하지 않도록 한다.
    pub async fn send_best_effort(&self, topic: &str, key: &str, payload: &[u8]) {
        if let Err(e) = self.send(topic, key, payload).await {
            warn!(topic, key, error = %e, "Kafka 전송 best-effort 실패 (무시)");
        }
    }
}
