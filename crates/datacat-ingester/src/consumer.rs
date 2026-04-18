//! Redpanda/Kafka consumer
//!
//! rdkafka StreamConsumer를 사용하여 비동기 메시지 소비.
//! 수신된 원시 bytes를 채널로 전달하여 writer가 처리한다.

use anyhow::Result;
use rdkafka::{
    ClientConfig, Message,
    consumer::{Consumer, StreamConsumer},
};
use tokio::sync::mpsc::Sender;
use tracing::{debug, error, info, warn};

/// Kafka로부터 수신한 원시 메시지.
#[derive(Debug)]
pub struct KafkaMessage {
    pub topic: String,
    pub payload: Vec<u8>,
}

/// Consumer 루프를 실행한다.
/// 메시지를 수신할 때마다 채널로 전송한다.
pub async fn run_consumer(
    brokers: String,
    group_id: String,
    topics: Vec<String>,
    tx: Sender<KafkaMessage>,
) -> Result<()> {
    let consumer: StreamConsumer = ClientConfig::new()
        .set("bootstrap.servers", &brokers)
        .set("group.id", &group_id)
        // 컨슈머 그룹 재조인 시 마지막 커밋 오프셋부터 재개
        .set("auto.offset.reset", "latest")
        // 자동 커밋: 5초 간격
        .set("enable.auto.commit", "true")
        .set("auto.commit.interval.ms", "5000")
        // 세션 타임아웃
        .set("session.timeout.ms", "10000")
        .create()?;

    let topic_refs: Vec<&str> = topics.iter().map(|s| s.as_str()).collect();
    consumer.subscribe(&topic_refs)?;

    info!(topics = ?topics, group_id = %group_id, "Kafka consumer 구독 시작");

    loop {
        match consumer.recv().await {
            Err(e) => {
                warn!(error = %e, "Kafka 수신 오류");
            }
            Ok(msg) => {
                let topic = msg.topic().to_string();
                let payload = match msg.payload() {
                    Some(p) => p.to_vec(),
                    None => {
                        debug!(topic, "빈 페이로드 무시");
                        continue;
                    }
                };

                debug!(
                    topic = %topic,
                    bytes = payload.len(),
                    partition = msg.partition(),
                    offset = msg.offset(),
                    "메시지 수신"
                );

                if tx.send(KafkaMessage { topic, payload }).await.is_err() {
                    error!("채널 수신 측 종료 — consumer 루프 중단");
                    break;
                }
            }
        }
    }

    Ok(())
}
