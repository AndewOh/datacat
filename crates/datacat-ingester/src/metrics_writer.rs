//! Metrics Writer — Kafka "datacat.metrics" 토픽 → ClickHouse
//!
//! OTLP ExportMetricsServiceRequest를 디코딩하여 datacat.metrics 테이블에 배치 삽입한다.
//!
//! 처리 흐름:
//!   Kafka 메시지 수신 → prost 디코딩 → MetricRow 변환 → ClickHouse inserter flush
//!
//! Flush 조건: 10,000 rows 누적 또는 1초 경과

use anyhow::Result;
use clickhouse::{Client, Row};
use opentelemetry_proto::tonic::{
    collector::metrics::v1::ExportMetricsServiceRequest,
    common::v1::{any_value, AnyValue},
    metrics::v1::metric::Data,
};
use prost::Message;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc::Receiver;
use tracing::{debug, error, info, warn};

use crate::consumer::KafkaMessage;

// ---------------------------------------------------------------------------
// ClickHouse Row 타입
// ---------------------------------------------------------------------------

/// datacat.metrics 테이블 스키마와 1:1 대응하는 Row.
///
/// timestamp: i64 unix ms. clickhouse-rs는 i64를 DateTime64(3)에 직접 매핑한다.
#[derive(Debug, Clone, Serialize, Deserialize, Row)]
pub struct MetricRow {
    pub tenant_id: String,
    /// Unix 밀리초. ClickHouse DateTime64(3, 'UTC')에 대응.
    pub timestamp: i64,
    pub name: String,
    /// 0=gauge, 1=sum(counter), 2=histogram, 3=summary
    #[serde(rename = "type")]
    pub type_: u8,
    pub value: f64,
    pub service: String,
    pub env: String,
    pub attrs_keys: Vec<String>,
    pub attrs_values: Vec<String>,
}

// ---------------------------------------------------------------------------
// 헬퍼: Unix 나노초 → Unix 밀리초 (i64)
// ---------------------------------------------------------------------------

/// Unix 나노초를 i64 밀리초로 변환한다 (DateTime64(3) 직접 대응).
#[inline]
fn nanos_to_ms(unix_ns: u64) -> i64 {
    (unix_ns / 1_000_000) as i64
}

/// AnyValue를 String으로 변환한다 (writer.rs의 extract_attr_value와 동일 로직).
fn extract_str(value: &Option<AnyValue>) -> String {
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
                .map(|v| extract_str(&Some(v.clone())))
                .collect();
            format!("[{}]", parts.join(","))
        }
        any_value::Value::KvlistValue(kv) => {
            let parts: Vec<String> = kv.values.iter()
                .map(|kv| format!("{}={}", kv.key, extract_str(&kv.value)))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
    }
}

// ---------------------------------------------------------------------------
// OTLP 디코딩 → MetricRow 변환
// ---------------------------------------------------------------------------

/// OTLP ExportMetricsServiceRequest payload → MetricRow 목록으로 변환한다.
pub fn decode_metrics(payload: &[u8], default_tenant: &str) -> Vec<MetricRow> {
    let req = match ExportMetricsServiceRequest::decode(payload) {
        Ok(r) => r,
        Err(e) => {
            warn!(error = %e, "Metrics 메시지 디코딩 실패");
            return Vec::new();
        }
    };

    let mut rows = Vec::new();

    for resource_metric in &req.resource_metrics {
        // resource attribute에서 service, env, tenant 추출
        let mut service = String::new();
        let mut env = String::new();
        let mut tenant_id_override: Option<String> = None;

        if let Some(resource) = &resource_metric.resource {
            for attr in &resource.attributes {
                let val = extract_str(&attr.value);
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

        for scope_metric in &resource_metric.scope_metrics {
            for metric in &scope_metric.metrics {
                let name = metric.name.clone();

                let Some(data) = &metric.data else { continue };

                match data {
                    Data::Gauge(gauge) => {
                        for dp in &gauge.data_points {
                            let value = match &dp.value {
                                Some(opentelemetry_proto::tonic::metrics::v1::number_data_point::Value::AsDouble(v)) => *v,
                                Some(opentelemetry_proto::tonic::metrics::v1::number_data_point::Value::AsInt(v)) => *v as f64,
                                None => 0.0,
                            };

                            let (attrs_keys, attrs_values) = extract_kv_attrs(&dp.attributes);
                            rows.push(MetricRow {
                                tenant_id: tenant_id.clone(),
                                timestamp: nanos_to_ms(dp.time_unix_nano),
                                name: name.clone(),
                                type_: 0, // gauge
                                value,
                                service: service.clone(),
                                env: env.clone(),
                                attrs_keys,
                                attrs_values,
                            });
                        }
                    }
                    Data::Sum(sum) => {
                        for dp in &sum.data_points {
                            let value = match &dp.value {
                                Some(opentelemetry_proto::tonic::metrics::v1::number_data_point::Value::AsDouble(v)) => *v,
                                Some(opentelemetry_proto::tonic::metrics::v1::number_data_point::Value::AsInt(v)) => *v as f64,
                                None => 0.0,
                            };

                            let (attrs_keys, attrs_values) = extract_kv_attrs(&dp.attributes);
                            rows.push(MetricRow {
                                tenant_id: tenant_id.clone(),
                                timestamp: nanos_to_ms(dp.time_unix_nano),
                                name: name.clone(),
                                type_: 1, // sum/counter
                                value,
                                service: service.clone(),
                                env: env.clone(),
                                attrs_keys,
                                attrs_values,
                            });
                        }
                    }
                    Data::Histogram(hist) => {
                        for dp in &hist.data_points {
                            // histogram은 sum을 대표 값으로 사용
                            let value = dp.sum.unwrap_or(0.0);

                            let (attrs_keys, attrs_values) = extract_kv_attrs(&dp.attributes);
                            rows.push(MetricRow {
                                tenant_id: tenant_id.clone(),
                                timestamp: nanos_to_ms(dp.time_unix_nano),
                                name: name.clone(),
                                type_: 2, // histogram
                                value,
                                service: service.clone(),
                                env: env.clone(),
                                attrs_keys,
                                attrs_values,
                            });
                        }
                    }
                    Data::Summary(summary) => {
                        for dp in &summary.data_points {
                            let value = dp.sum;

                            let (attrs_keys, attrs_values) = extract_kv_attrs(&dp.attributes);
                            rows.push(MetricRow {
                                tenant_id: tenant_id.clone(),
                                timestamp: nanos_to_ms(dp.time_unix_nano),
                                name: name.clone(),
                                type_: 3, // summary
                                value,
                                service: service.clone(),
                                env: env.clone(),
                                attrs_keys,
                                attrs_values,
                            });
                        }
                    }
                    // ExponentialHistogram은 Phase 3에서 처리
                    Data::ExponentialHistogram(_) => {
                        debug!(name = %name, "ExponentialHistogram — Phase 3에서 처리 예정");
                    }
                }
            }
        }
    }

    rows
}

/// KeyValue 목록을 (keys, values) 두 Vec으로 분리한다.
fn extract_kv_attrs(
    attrs: &[opentelemetry_proto::tonic::common::v1::KeyValue],
) -> (Vec<String>, Vec<String>) {
    let mut keys = Vec::with_capacity(attrs.len());
    let mut vals = Vec::with_capacity(attrs.len());
    for attr in attrs {
        keys.push(attr.key.clone());
        vals.push(extract_str(&attr.value));
    }
    (keys, vals)
}

// ---------------------------------------------------------------------------
// Writer 루프
// ---------------------------------------------------------------------------

/// Metrics writer 루프.
///
/// KafkaMessage 채널에서 metrics 토픽 메시지만 필터링하여
/// ClickHouse에 배치 삽입한다.
pub async fn run_metrics_writer(
    client: Client,
    mut rx: Receiver<KafkaMessage>,
    batch_size: usize,
    flush_interval_ms: u64,
) -> Result<()> {
    info!(batch_size, flush_interval_ms, "Metrics writer 시작");

    let mut buffer: Vec<MetricRow> = Vec::with_capacity(batch_size);
    let flush_interval = Duration::from_millis(flush_interval_ms);
    let mut flush_ticker = tokio::time::interval(flush_interval);

    loop {
        tokio::select! {
            msg = rx.recv() => {
                match msg {
                    None => {
                        info!("Metrics writer 채널 종료 — 최종 flush");
                        flush_metrics(&client, &mut buffer).await;
                        break;
                    }
                    Some(kafka_msg) => {
                        // metrics 토픽 필터 (이미 metrics-전용 consumer에서 받지만
                        // 방어적으로 확인)
                        if !kafka_msg.topic.contains("metric") {
                            debug!(topic = %kafka_msg.topic, "비-metrics 토픽 — 스킵");
                            continue;
                        }

                        let rows = decode_metrics(&kafka_msg.payload, "default");
                        if rows.is_empty() {
                            continue;
                        }

                        debug!(count = rows.len(), "MetricRow 변환 완료");
                        buffer.extend(rows);

                        if buffer.len() >= batch_size {
                            flush_metrics(&client, &mut buffer).await;
                        }
                    }
                }
            }
            _ = flush_ticker.tick() => {
                if !buffer.is_empty() {
                    flush_metrics(&client, &mut buffer).await;
                }
            }
        }
    }

    Ok(())
}

/// buffer를 ClickHouse에 삽입하고 비운다.
async fn flush_metrics(client: &Client, buffer: &mut Vec<MetricRow>) {
    if buffer.is_empty() {
        return;
    }

    let count = buffer.len();
    debug!(count, "metrics flush 시작");

    let mut insert = match client.insert("datacat.metrics") {
        Ok(ins) => ins,
        Err(e) => {
            error!(error = %e, "ClickHouse metrics insert 생성 실패");
            buffer.clear();
            return;
        }
    };

    let mut success = true;
    for row in buffer.iter() {
        if let Err(e) = insert.write(row).await {
            error!(error = %e, "metrics 행 쓰기 실패");
            success = false;
            break;
        }
    }

    if success {
        match insert.end().await {
            Ok(_) => info!(count, "metrics 배치 삽입 완료"),
            Err(e) => error!(error = %e, count, "metrics flush 실패"),
        }
    }

    buffer.clear();
}
