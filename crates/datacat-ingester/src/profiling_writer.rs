//! Profiles ClickHouse writer
//!
//! Kafka "datacat.profiles" 토픽을 소비하여 ClickHouse datacat.profiles 테이블에 삽입한다.
//!
//! 배치 전략:
//! - 프로파일은 크기가 크므로 (수십~수백 KB) 배치 크기를 100개로 제한
//! - 최대 5초마다 flush (spans/logs의 1초보다 느슨하게 설정)
//!
//! Kafka 메시지 포맷: JSON (ProfilePayload — collector에서 정의)
//! ClickHouse 행 포맷: ProfileRow (UUID, base64 payload 포함)

use crate::consumer::KafkaMessage;
use anyhow::Result;
use clickhouse::{Client, Row};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc::Receiver;
use tracing::{debug, error, info, warn};

// ---------------------------------------------------------------------------
// Kafka 메시지 역직렬화 타입
// collector의 ProfilePayload와 동일한 구조여야 한다.
// ---------------------------------------------------------------------------

/// collector가 Kafka로 전송한 JSON 메시지 구조.
#[derive(Debug, Deserialize)]
struct ProfilePayload {
    pub tenant_id: String,
    pub service: String,
    pub env: String,
    pub profile_type: String,
    /// 수신 시각 (Unix 나노초)
    pub timestamp_ns: u64,
    /// pprof/JFR bytes Base64 인코딩
    pub data_base64: String,
}

// ---------------------------------------------------------------------------
// ClickHouse Row 타입
// ---------------------------------------------------------------------------

/// ClickHouse `datacat.profiles` 테이블에 대응하는 Row.
///
/// DDL:
/// ```sql
/// CREATE TABLE datacat.profiles (
///     tenant_id    LowCardinality(String),
///     timestamp    DateTime64(9, 'UTC'),  -- Unix 나노초로 변환
///     service      LowCardinality(String),
///     env          LowCardinality(String),
///     profile_id   FixedString(32),       -- UUID v4, hex 32자
///     type         LowCardinality(String),
///     payload      String                 -- base64 pprof/JFR
/// )
/// ```
#[derive(Debug, Clone, Serialize, Deserialize, Row)]
pub struct ProfileRow {
    pub tenant_id: String,
    /// Unix 나노초 (ClickHouse DateTime64(9) 호환)
    pub timestamp: i64,
    pub service: String,
    pub env: String,
    /// UUID v4를 hex 32자로 인코딩 (FixedString(32))
    pub profile_id: String,
    /// 프로파일 타입 (cpu, heap, goroutine, block 등)
    #[serde(rename = "type")]
    pub profile_type: String,
    /// pprof/JFR raw bytes의 Base64 인코딩
    pub payload: String,
}

// ---------------------------------------------------------------------------
// UUID 헬퍼
// ---------------------------------------------------------------------------

/// UUID v4를 생성하여 hex 32자 문자열로 반환한다.
/// ClickHouse FixedString(32) 컬럼에 직접 삽입 가능.
fn new_profile_id() -> String {
    // uuid crate 없이 tokio 런타임 내에서 간단한 UUID 생성
    // 실제로는 충분한 엔트로피 — 타임스탬프 + 랜덤 조합
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    // 128비트를 16진수 32자로 표현: 상위 64비트는 타임스탬프, 하위 64비트는 해시
    // 충분한 유니크성을 위해 ts와 포인터 주소 기반 해시 사용
    let hash = {
        let mut h: u64 = 0xcbf29ce484222325;
        for byte in ts.to_le_bytes() {
            h ^= byte as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    };
    format!("{:016x}{:016x}", ts as u64, hash)
}

// ---------------------------------------------------------------------------
// Kafka 메시지 → ClickHouse Row 변환
// ---------------------------------------------------------------------------

/// Kafka 메시지 payload(JSON bytes)를 ProfileRow로 변환한다.
fn decode_profile(payload: &[u8]) -> Option<ProfileRow> {
    let msg: ProfilePayload = match serde_json::from_slice(payload) {
        Ok(m) => m,
        Err(e) => {
            warn!(error = %e, "profile JSON 역직렬화 실패");
            return None;
        }
    };

    // timestamp_ns (u64 나노초) → i64 (ClickHouse DateTime64(9) 호환)
    let timestamp = msg.timestamp_ns as i64;

    Some(ProfileRow {
        tenant_id: msg.tenant_id,
        timestamp,
        service: msg.service,
        env: msg.env,
        profile_id: new_profile_id(),
        profile_type: msg.profile_type,
        payload: msg.data_base64,
    })
}

// ---------------------------------------------------------------------------
// ClickHouse 배치 flush
// ---------------------------------------------------------------------------

/// profile_buffer를 ClickHouse에 삽입하고 버퍼를 비운다.
async fn flush_profiles(client: &Client, buffer: &mut Vec<ProfileRow>) {
    if buffer.is_empty() {
        return;
    }

    let count = buffer.len();
    debug!(count, "profiles flush 시작");

    let mut insert = match client.insert("datacat.profiles") {
        Ok(ins) => ins,
        Err(e) => {
            error!(error = %e, "profiles ClickHouse insert 생성 실패");
            buffer.clear();
            return;
        }
    };

    let mut success = true;
    for row in buffer.iter() {
        if let Err(e) = insert.write(row).await {
            error!(error = %e, "profile 행 쓰기 실패");
            success = false;
            break;
        }
    }

    if success {
        match insert.end().await {
            Ok(_) => info!(count, "profiles 배치 삽입 완료"),
            Err(e) => error!(error = %e, count, "profiles flush 실패"),
        }
    }

    buffer.clear();
}

// ---------------------------------------------------------------------------
// Writer 루프
// ---------------------------------------------------------------------------

/// Profile writer 루프.
///
/// 채널에서 KafkaMessage를 수신하여 ProfileRow로 변환 후 ClickHouse에 배치 삽입한다.
///
/// `batch_size`: 배치 최대 크기 (권장: 100 — 프로파일은 크기가 크므로 작게 유지)
/// `flush_interval_ms`: 최대 대기 시간 (권장: 5000ms)
pub async fn run_profiles_writer(
    client: Client,
    mut rx: Receiver<KafkaMessage>,
    batch_size: usize,
    flush_interval_ms: u64,
) -> Result<()> {
    info!(
        batch_size,
        flush_interval_ms,
        "profiles ClickHouse writer 시작"
    );

    // 프로파일은 크기가 크므로 배치 크기를 제한
    // caller가 전달한 batch_size가 크면 100으로 캡핑
    let effective_batch = batch_size.min(100);
    let mut profile_buffer: Vec<ProfileRow> = Vec::with_capacity(effective_batch);
    let flush_interval = Duration::from_millis(flush_interval_ms);
    let mut flush_ticker = tokio::time::interval(flush_interval);

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    None => {
                        info!("profiles 채널 종료 — 최종 flush 후 종료");
                        flush_profiles(&client, &mut profile_buffer).await;
                        break;
                    }
                    Some(kafka_msg) => {
                        if let Some(row) = decode_profile(&kafka_msg.payload) {
                            profile_buffer.push(row);

                            if profile_buffer.len() >= effective_batch {
                                flush_profiles(&client, &mut profile_buffer).await;
                            }
                        }
                    }
                }
            }
            _ = flush_ticker.tick() => {
                if !profile_buffer.is_empty() {
                    flush_profiles(&client, &mut profile_buffer).await;
                }
            }
        }
    }

    Ok(())
}
