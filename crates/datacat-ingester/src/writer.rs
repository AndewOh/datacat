//! ClickHouse 배치 writer
//!
//! Kafka 메시지를 ClickHouse Row로 변환하여 배치 삽입한다.
//!
//! 성능 전략:
//! - inserter 사용: 배치를 누적하다가 임계값 도달 시 일괄 전송
//! - 최대 1초 또는 10k 행 도달 시 flush
//! - OTLP protobuf → Row 변환은 allocation을 최소화

use crate::consumer::KafkaMessage;
use anyhow::Result;
use clickhouse::{Client, Row};
use datacat_schema::INIT_DDL;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::common::v1::{any_value, AnyValue};
use prost::Message;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc::Receiver;
use tracing::{debug, error, info, warn};

// ---------------------------------------------------------------------------
// ClickHouse Row 타입
// ---------------------------------------------------------------------------

/// ClickHouse spans 테이블에 대응하는 Row.
#[derive(Debug, Clone, Serialize, Deserialize, Row)]
pub struct SpanRow {
    pub tenant_id: String,
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: String,
    pub name: String,
    pub service: String,
    pub env: String,
    pub kind: u8,
    /// Unix 나노초
    pub start_time: i64,
    pub end_time: i64,
    pub duration_ns: u64,
    pub status_code: u8,
    pub status_msg: String,
    pub attrs_keys: Vec<String>,
    pub attrs_values: Vec<String>,
    pub resource_keys: Vec<String>,
    pub resource_values: Vec<String>,
}

// ---------------------------------------------------------------------------
// AnyValue 추출 헬퍼
// ---------------------------------------------------------------------------

/// OTel AnyValue를 사람이 읽을 수 있는 String으로 변환한다.
/// 디버그 포맷({:?}) 대신 실제 값을 추출하여 ClickHouse에 저장한다.
fn extract_attr_value(value: &Option<AnyValue>) -> String {
    let Some(av) = value else { return String::new() };
    let Some(inner) = &av.value else { return String::new() };
    match inner {
        any_value::Value::StringValue(s) => s.clone(),
        any_value::Value::BoolValue(b) => b.to_string(),
        any_value::Value::IntValue(i) => i.to_string(),
        any_value::Value::DoubleValue(d) => d.to_string(),
        any_value::Value::BytesValue(b) => hex::encode(b),
        any_value::Value::ArrayValue(arr) => {
            let parts: Vec<String> = arr.values.iter()
                .map(|v| extract_attr_value(&Some(v.clone())))
                .collect();
            format!("[{}]", parts.join(","))
        }
        any_value::Value::KvlistValue(kv) => {
            let parts: Vec<String> = kv.values.iter()
                .map(|kv| format!("{}={}", kv.key, extract_attr_value(&kv.value)))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

// ---------------------------------------------------------------------------
// 스키마 초기화
// ---------------------------------------------------------------------------

/// INIT_DDL을 순서대로 실행하여 테이블을 생성한다.
/// 이미 존재하는 테이블은 `IF NOT EXISTS`로 무시된다.
pub async fn init_schema(client: &Client) -> Result<()> {
    info!("ClickHouse 스키마 초기화 시작");

    for ddl in INIT_DDL {
        if ddl.trim().is_empty() {
            continue;
        }
        match client.query(ddl).execute().await {
            Ok(_) => debug!("DDL 실행 성공"),
            Err(e) => warn!(error = %e, "DDL 실행 경고 (무시 가능)"),
        }
    }

    info!("ClickHouse 스키마 초기화 완료");
    Ok(())
}

// ---------------------------------------------------------------------------
// Writer 루프
// ---------------------------------------------------------------------------

/// OTLP ExportTraceServiceRequest를 SpanRow 목록으로 변환한다.
fn decode_spans(payload: &[u8], default_tenant: &str) -> Vec<SpanRow> {
    let req = match ExportTraceServiceRequest::decode(payload) {
        Ok(r) => r,
        Err(e) => {
            warn!(error = %e, "Trace 메시지 디코딩 실패");
            return Vec::new();
        }
    };

    let mut rows = Vec::new();

    for resource_span in &req.resource_spans {
        // resource attribute에서 service.name, deployment.environment, datacat.tenant 추출
        let mut service = String::new();
        let mut env = String::new();
        let mut tenant_id_override: Option<String> = None;
        let mut resource_keys = Vec::new();
        let mut resource_values = Vec::new();

        if let Some(resource) = &resource_span.resource {
            for attr in &resource.attributes {
                let val = extract_attr_value(&attr.value);

                match attr.key.as_str() {
                    "service.name" => service = val.clone(),
                    "deployment.environment" => env = val.clone(),
                    "datacat.tenant" => tenant_id_override = Some(val.clone()),
                    _ => {}
                }
                resource_keys.push(attr.key.clone());
                resource_values.push(val);
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

        for scope_span in &resource_span.scope_spans {
            for span in &scope_span.spans {
                let duration_ns = span.end_time_unix_nano.saturating_sub(span.start_time_unix_nano);

                // attrs 변환
                let mut attrs_keys = Vec::with_capacity(span.attributes.len());
                let mut attrs_values = Vec::with_capacity(span.attributes.len());
                for attr in &span.attributes {
                    attrs_keys.push(attr.key.clone());
                    let val = extract_attr_value(&attr.value);
                    attrs_values.push(val);
                }

                let trace_id = hex::encode(&span.trace_id);
                let span_id = hex::encode(&span.span_id);
                let parent_span_id = hex::encode(&span.parent_span_id);

                rows.push(SpanRow {
                    tenant_id: tenant_id.clone(),
                    trace_id,
                    span_id,
                    parent_span_id,
                    name: span.name.clone(),
                    service: service.clone(),
                    env: env.clone(),
                    kind: span.kind as u8,
                    start_time: span.start_time_unix_nano as i64,
                    end_time: span.end_time_unix_nano as i64,
                    duration_ns,
                    status_code: span.status.as_ref().map(|s| s.code as u8).unwrap_or(0),
                    status_msg: span.status.as_ref().map(|s| s.message.clone()).unwrap_or_default(),
                    attrs_keys,
                    attrs_values,
                    resource_keys: resource_keys.clone(),
                    resource_values: resource_values.clone(),
                });
            }
        }
    }

    rows
}

/// Writer 루프: 채널에서 메시지를 수신하여 ClickHouse에 배치 삽입한다.
pub async fn run_writer(
    client: Client,
    mut rx: Receiver<KafkaMessage>,
    batch_size: usize,
    flush_interval_ms: u64,
) -> Result<()> {
    info!(batch_size, flush_interval_ms, "ClickHouse writer 시작");

    let mut span_buffer: Vec<SpanRow> = Vec::with_capacity(batch_size);
    let flush_interval = Duration::from_millis(flush_interval_ms);
    let mut flush_ticker = tokio::time::interval(flush_interval);

    loop {
        tokio::select! {
            // 메시지 수신
            msg = rx.recv() => {
                match msg {
                    None => {
                        info!("채널 종료 — 최종 flush 후 종료");
                        flush_spans(&client, &mut span_buffer).await;
                        break;
                    }
                    Some(kafka_msg) => {
                        match kafka_msg.topic.as_str() {
                            t if t.contains("span") || t.contains("trace") => {
                                let rows = decode_spans(&kafka_msg.payload, "default");
                                span_buffer.extend(rows);

                                if span_buffer.len() >= batch_size {
                                    flush_spans(&client, &mut span_buffer).await;
                                }
                            }
                            // logs, metrics는 향후 구현
                            other => {
                                debug!(topic = other, "미지원 토픽 — 스킵");
                            }
                        }
                    }
                }
            }
            // 주기적 flush
            _ = flush_ticker.tick() => {
                if !span_buffer.is_empty() {
                    flush_spans(&client, &mut span_buffer).await;
                }
            }
        }
    }

    Ok(())
}

/// span_buffer를 ClickHouse에 삽입하고 버퍼를 비운다.
async fn flush_spans(client: &Client, buffer: &mut Vec<SpanRow>) {
    if buffer.is_empty() {
        return;
    }

    let count = buffer.len();
    debug!(count, "spans flush 시작");

    let mut insert = match client.insert("datacat.spans") {
        Ok(ins) => ins,
        Err(e) => {
            error!(error = %e, "ClickHouse insert 생성 실패");
            buffer.clear();
            return;
        }
    };

    let mut success = true;
    for row in buffer.iter() {
        if let Err(e) = insert.write(row).await {
            error!(error = %e, "행 쓰기 실패");
            success = false;
            break;
        }
    }

    if success {
        match insert.end().await {
            Ok(_) => info!(count, "spans 배치 삽입 완료"),
            Err(e) => error!(error = %e, count, "spans flush 실패"),
        }
    }

    buffer.clear();
}
