//! Logs ClickHouse 배치 writer
//!
//! Kafka "datacat.logs" 토픽에서 OTLP ExportLogsServiceRequest를 소비하여
//! ClickHouse datacat.logs 테이블에 배치 삽입한다.
//!
//! 성능 전략:
//! - 10k 행 또는 1초 flush 주기 (writer.rs와 동일 패턴)
//! - OTLP protobuf → LogRow 변환 시 panic 없이 warn + skip

use crate::consumer::KafkaMessage;
use anyhow::Result;
use clickhouse::{Client, Row};
use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue};
use prost::Message;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc::Receiver;
use tracing::{debug, error, info, warn};

// ---------------------------------------------------------------------------
// ClickHouse Row 타입
// ---------------------------------------------------------------------------

/// ClickHouse datacat.logs 테이블에 대응하는 Row.
///
/// timestamp: DateTime64(9) — 나노초 Unix 타임스탬프
/// trace_id:  FixedString(32) — 32자 hex string
/// span_id:   FixedString(16) — 16자 hex string
#[derive(Debug, Clone, Serialize, Deserialize, Row)]
pub struct LogRow {
    pub tenant_id: String,
    /// Unix 나노초 (DateTime64(9) 매핑)
    pub timestamp: i64,
    /// 32자 hex string (FixedString(32))
    pub trace_id: String,
    /// 16자 hex string (FixedString(16))
    pub span_id: String,
    pub severity_number: u8,
    pub severity_text: String,
    pub service: String,
    pub env: String,
    pub body: String,
    pub attrs_keys: Vec<String>,
    pub attrs_values: Vec<String>,
}

// ---------------------------------------------------------------------------
// AnyValue 추출 헬퍼
// ---------------------------------------------------------------------------

/// OTel AnyValue를 String으로 변환한다.
/// writer.rs의 extract_attr_value와 동일한 로직을 logs_writer 내에서 독립적으로 유지한다.
fn extract_any_value(value: &Option<AnyValue>) -> String {
    let Some(av) = value else { return String::new() };
    let Some(inner) = &av.value else { return String::new() };
    match inner {
        any_value::Value::StringValue(s) => s.clone(),
        any_value::Value::BoolValue(b) => b.to_string(),
        any_value::Value::IntValue(i) => i.to_string(),
        any_value::Value::DoubleValue(d) => d.to_string(),
        any_value::Value::BytesValue(b) => hex::encode(b),
        any_value::Value::ArrayValue(arr) => {
            let parts: Vec<String> = arr
                .values
                .iter()
                .map(|v| extract_any_value(&Some(v.clone())))
                .collect();
            format!("[{}]", parts.join(","))
        }
        any_value::Value::KvlistValue(kv) => {
            let parts: Vec<String> = kv
                .values
                .iter()
                .map(|pair| {
                    format!("{}={}", pair.key, extract_any_value(&pair.value))
                })
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

// ---------------------------------------------------------------------------
// 디코딩
// ---------------------------------------------------------------------------

/// OTLP ExportLogsServiceRequest payload를 LogRow 목록으로 변환한다.
///
/// - panic 없이 모든 에러를 warn! 로깅 후 빈 Vec 반환
/// - resource에서 service.name, deployment.environment, datacat.tenant 추출
/// - body: AnyValue::StringValue 우선, 없으면 format!("{:?}")
/// - trace_id, span_id: bytes → hex::encode → FixedString(32/16) 패딩/트림
pub fn decode_logs(payload: &[u8], default_tenant: &str) -> Vec<LogRow> {
    let req = match ExportLogsServiceRequest::decode(payload) {
        Ok(r) => r,
        Err(e) => {
            warn!(error = %e, "Logs 메시지 디코딩 실패");
            return Vec::new();
        }
    };

    let mut rows = Vec::new();

    for resource_log in &req.resource_logs {
        // resource attribute에서 핵심 필드 추출
        let mut service = String::new();
        let mut env = String::new();
        let mut tenant_id_override: Option<String> = None;

        if let Some(resource) = &resource_log.resource {
            for attr in &resource.attributes {
                let val = extract_any_value(&attr.value);
                match attr.key.as_str() {
                    "service.name" => service = val,
                    "deployment.environment" => env = val,
                    "datacat.tenant" => tenant_id_override = Some(val),
                    _ => {}
                }
            }
        }

        let tenant_id = tenant_id_override
            .as_deref()
            .unwrap_or(default_tenant)
            .to_string();

        if service.is_empty() {
            service = "unknown".to_string();
        }
        if env.is_empty() {
            env = "production".to_string();
        }

        for scope_log in &resource_log.scope_logs {
            for record in &scope_log.log_records {
                // body: StringValue 우선, 그 외 debug 포맷
                let body = match &record.body {
                    Some(av) => match &av.value {
                        Some(any_value::Value::StringValue(s)) => s.clone(),
                        Some(other) => format!("{:?}", other),
                        None => String::new(),
                    },
                    None => String::new(),
                };

                // attrs 변환
                let mut attrs_keys = Vec::with_capacity(record.attributes.len());
                let mut attrs_values = Vec::with_capacity(record.attributes.len());
                for attr in &record.attributes {
                    attrs_keys.push(attr.key.clone());
                    attrs_values.push(extract_any_value(&attr.value));
                }

                // trace_id: bytes → hex, FixedString(32) 맞춤 (32자 0-pad 또는 trim)
                let trace_id = pad_or_trim_hex(&hex::encode(&record.trace_id), 32);
                // span_id: bytes → hex, FixedString(16) 맞춤 (16자 0-pad 또는 trim)
                let span_id = pad_or_trim_hex(&hex::encode(&record.span_id), 16);

                // timestamp_unix_nano → i64 (DateTime64(9) 나노초)
                let timestamp = record.time_unix_nano as i64;

                rows.push(LogRow {
                    tenant_id: tenant_id.clone(),
                    timestamp,
                    trace_id,
                    span_id,
                    severity_number: record.severity_number as u8,
                    severity_text: record.severity_text.clone(),
                    service: service.clone(),
                    env: env.clone(),
                    body,
                    attrs_keys,
                    attrs_values,
                });
            }
        }
    }

    rows
}

/// hex string을 target_len 글자로 맞춘다.
/// - 짧으면 우측 0-pad (ClickHouse FixedString은 우측 0-fill)
/// - 길면 target_len 글자로 trim
fn pad_or_trim_hex(hex: &str, target_len: usize) -> String {
    if hex.len() >= target_len {
        hex[..target_len].to_string()
    } else {
        format!("{:0<width$}", hex, width = target_len)
    }
}

// ---------------------------------------------------------------------------
// flush 헬퍼
// ---------------------------------------------------------------------------

/// log_buffer를 ClickHouse에 삽입하고 버퍼를 비운다.
async fn flush_logs(client: &Client, buffer: &mut Vec<LogRow>) {
    if buffer.is_empty() {
        return;
    }

    let count = buffer.len();
    debug!(count, "logs flush 시작");

    let mut insert = match client.insert("datacat.logs") {
        Ok(ins) => ins,
        Err(e) => {
            error!(error = %e, "ClickHouse logs insert 생성 실패");
            buffer.clear();
            return;
        }
    };

    let mut success = true;
    for row in buffer.iter() {
        if let Err(e) = insert.write(row).await {
            error!(error = %e, "logs 행 쓰기 실패");
            success = false;
            break;
        }
    }

    if success {
        match insert.end().await {
            Ok(_) => info!(count, "logs 배치 삽입 완료"),
            Err(e) => error!(error = %e, count, "logs flush 실패"),
        }
    }

    buffer.clear();
}

// ---------------------------------------------------------------------------
// Writer 루프
// ---------------------------------------------------------------------------

/// Logs writer 루프: 채널에서 logs 메시지를 수신하여 ClickHouse에 배치 삽입한다.
///
/// - 10k 행 또는 flush_interval_ms마다 flush
/// - 채널 종료 시 최종 flush 후 정상 종료
pub async fn run_logs_writer(
    client: Client,
    mut rx: Receiver<KafkaMessage>,
    batch_size: usize,
    flush_interval_ms: u64,
) -> Result<()> {
    info!(batch_size, flush_interval_ms, "Logs ClickHouse writer 시작");

    let mut log_buffer: Vec<LogRow> = Vec::with_capacity(batch_size);
    let flush_interval = Duration::from_millis(flush_interval_ms);
    let mut flush_ticker = tokio::time::interval(flush_interval);

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    None => {
                        info!("logs 채널 종료 — 최종 flush 후 종료");
                        flush_logs(&client, &mut log_buffer).await;
                        break;
                    }
                    Some(kafka_msg) => {
                        let rows = decode_logs(&kafka_msg.payload, "default");
                        log_buffer.extend(rows);

                        if log_buffer.len() >= batch_size {
                            flush_logs(&client, &mut log_buffer).await;
                        }
                    }
                }
            }
            _ = flush_ticker.tick() => {
                if !log_buffer.is_empty() {
                    flush_logs(&client, &mut log_buffer).await;
                }
            }
        }
    }

    Ok(())
}
