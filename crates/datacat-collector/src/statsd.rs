//! StatsD UDP 수신기
//!
//! UDP 8125 포트에서 StatsD 패킷을 수신하고 OTel Metrics protobuf로 변환하여
//! Kafka "datacat.metrics" 토픽으로 전송한다.
//!
//! 지원 포맷:
//!   "metric.name:value|type[@sample_rate][|#tag:value,tag:value]"
//!
//! 지원 타입:
//!   g  — gauge    (절댓값)
//!   c  — counter  (누적 증가, sample_rate 적용)
//!   ms — timer    (밀리초, gauge로 저장)
//!   h  — histogram(gauge로 저장)
//!   s  — set      (gauge 1.0으로 저장)

use crate::producer::KafkaProducer;
use anyhow::Result;
use opentelemetry_proto::tonic::{
    collector::metrics::v1::ExportMetricsServiceRequest,
    common::v1::{AnyValue, KeyValue, any_value},
    metrics::v1::{
        Gauge, Metric, NumberDataPoint, ResourceMetrics, ScopeMetrics,
        metric::Data,
    },
    resource::v1::Resource,
};
use prost::Message;
use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::UdpSocket;
use tracing::{debug, info, warn};

// ---------------------------------------------------------------------------
// 파싱 타입
// ---------------------------------------------------------------------------

/// 파싱된 StatsD 메트릭 하나.
#[derive(Debug)]
struct StatsDMetric {
    name: String,
    value: f64,
    /// 0=gauge/timer/histogram, 1=counter
    metric_type: u8,
    tags: Vec<(String, String)>,
}

/// StatsD 패킷 한 줄을 파싱한다.
///
/// 포맷: "name:value|type[@sample_rate][|#tag:val,tag:val]"
/// - 여러 메트릭이 줄바꿈(\n)으로 구분될 수 있음
fn parse_statsd_line(line: &str) -> Option<StatsDMetric> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    // name:value 분리
    let colon_pos = line.find(':')?;
    let name = line[..colon_pos].trim().to_string();
    if name.is_empty() {
        return None;
    }

    let rest = &line[colon_pos + 1..];

    // value|type[@sample_rate][|#tags] 분리
    // 파이프 기준으로 분리
    let parts: Vec<&str> = rest.split('|').collect();
    if parts.len() < 2 {
        return None;
    }

    // value 파싱
    let raw_value: f64 = parts[0].trim().parse().ok()?;

    // type 파싱 (첫 번째 파이프 이후)
    let type_str = parts[1].trim();
    // @sample_rate가 붙어있을 수 있음 (e.g., "c@0.1")
    let type_char = type_str.split('@').next().unwrap_or("").trim();

    let (value, metric_type) = match type_char {
        "g" => (raw_value, 0u8),
        "c" => {
            // sample_rate 추출: "c@0.5" 형태
            let parsed_rate: f64 = type_str
                .split('@')
                .nth(1)
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(1.0_f64);
            let sample_rate = parsed_rate.max(0.0001_f64); // 0 나눗셈 방지
            (raw_value / sample_rate, 1u8)
        }
        "ms" | "h" => (raw_value, 0u8),
        "s" => (1.0, 0u8),
        _ => {
            debug!(type_char, "알 수 없는 StatsD 타입 — 무시");
            return None;
        }
    };

    // 태그 파싱: |#tag:val,tag:val
    let mut tags = Vec::new();
    for part in &parts[2..] {
        let part = part.trim();
        if let Some(tag_str) = part.strip_prefix('#') {
            for kv in tag_str.split(',') {
                let kv = kv.trim();
                if let Some(colon) = kv.find(':') {
                    let k = kv[..colon].trim().to_string();
                    let v = kv[colon + 1..].trim().to_string();
                    if !k.is_empty() {
                        tags.push((k, v));
                    }
                } else if !kv.is_empty() {
                    // 값 없는 태그: 빈 string으로 저장
                    tags.push((kv.to_string(), String::new()));
                }
            }
        }
    }

    Some(StatsDMetric { name, value, metric_type, tags })
}

// ---------------------------------------------------------------------------
// OTLP 변환
// ---------------------------------------------------------------------------

/// StatsDMetric을 OTLP ExportMetricsServiceRequest protobuf로 변환한다.
fn to_otlp_proto(metrics: &[StatsDMetric]) -> Vec<u8> {
    let now_ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;

    // service, env 태그를 resource attribute로, 나머지는 data point attribute로
    let otlp_metrics: Vec<Metric> = metrics
        .iter()
        .map(|m| {
            // 태그에서 service, env 추출 (resource 레벨)
            let attrs: Vec<KeyValue> = m
                .tags
                .iter()
                .map(|(k, v)| KeyValue {
                    key: k.clone(),
                    value: Some(AnyValue {
                        value: Some(any_value::Value::StringValue(v.clone())),
                    }),
                })
                .collect();

            let data_point = NumberDataPoint {
                attributes: attrs,
                start_time_unix_nano: now_ns,
                time_unix_nano: now_ns,
                value: Some(
                    opentelemetry_proto::tonic::metrics::v1::number_data_point::Value::AsDouble(
                        m.value,
                    ),
                ),
                ..Default::default()
            };

            // counter는 Sum, 나머지는 Gauge
            let data = if m.metric_type == 1 {
                // counter → Sum (monotonic, cumulative)
                Data::Sum(opentelemetry_proto::tonic::metrics::v1::Sum {
                    data_points: vec![data_point],
                    aggregation_temporality: 2, // AGGREGATION_TEMPORALITY_CUMULATIVE
                    is_monotonic: true,
                })
            } else {
                Data::Gauge(Gauge {
                    data_points: vec![data_point],
                })
            };

            Metric {
                name: m.name.clone(),
                description: String::new(),
                unit: String::new(),
                data: Some(data),
                metadata: vec![],
            }
        })
        .collect();

    // service 태그를 resource attribute로 올림
    // 배치 내 첫 번째 메트릭의 service/env 태그를 resource로 사용
    let resource_attrs: Vec<KeyValue> = metrics
        .first()
        .map(|m| {
            let mut attrs = Vec::new();
            for (k, v) in &m.tags {
                if k == "service" || k == "env" || k == "deployment.environment" {
                    attrs.push(KeyValue {
                        key: if k == "env" {
                            "deployment.environment".to_string()
                        } else {
                            k.clone()
                        },
                        value: Some(AnyValue {
                            value: Some(any_value::Value::StringValue(v.clone())),
                        }),
                    });
                }
            }
            attrs
        })
        .unwrap_or_default();

    let req = ExportMetricsServiceRequest {
        resource_metrics: vec![ResourceMetrics {
            resource: Some(Resource {
                attributes: resource_attrs,
                dropped_attributes_count: 0,
                entity_refs: vec![],
            }),
            scope_metrics: vec![ScopeMetrics {
                scope: None,
                metrics: otlp_metrics,
                schema_url: String::new(),
            }],
            schema_url: String::new(),
        }],
    };

    req.encode_to_vec()
}

// ---------------------------------------------------------------------------
// UDP 수신 루프
// ---------------------------------------------------------------------------

/// StatsD UDP 서버를 실행한다.
///
/// 패킷을 수신하면 파싱 후 OTLP protobuf로 변환하여 Kafka로 전송한다.
/// 30초마다 수신 통계를 INFO 로그로 출력한다.
pub async fn run_statsd(
    bind_addr: SocketAddr,
    producer: KafkaProducer,
    metrics_topic: String,
) -> Result<()> {
    let socket = UdpSocket::bind(bind_addr).await?;
    info!(addr = %bind_addr, "StatsD UDP 서버 시작");

    // 통계 카운터
    let mut total_packets: u64 = 0;
    let mut total_metrics: u64 = 0;
    let mut last_stats_at = tokio::time::Instant::now();
    let stats_interval = tokio::time::Duration::from_secs(30);

    // UDP max payload: 65535 - 28(IP+UDP 헤더) = 65507
    let mut buf = vec![0u8; 65535];

    loop {
        match socket.recv_from(&mut buf).await {
            Err(e) => {
                warn!(error = %e, "StatsD UDP 수신 오류");
                continue;
            }
            Ok((len, _peer)) => {
                let packet = &buf[..len];

                // UTF-8 변환 실패 시 무시
                let text = match std::str::from_utf8(packet) {
                    Ok(s) => s,
                    Err(_) => {
                        debug!("UTF-8 아닌 패킷 — 무시");
                        continue;
                    }
                };

                // 줄바꿈으로 구분된 여러 메트릭 처리
                let parsed: Vec<StatsDMetric> = text
                    .lines()
                    .filter_map(parse_statsd_line)
                    .collect();

                if parsed.is_empty() {
                    continue;
                }

                total_packets += 1;
                total_metrics += parsed.len() as u64;

                let payload = to_otlp_proto(&parsed);
                producer
                    .send_best_effort(&metrics_topic, "statsd", &payload)
                    .await;

                // 30초 통계 출력
                if last_stats_at.elapsed() >= stats_interval {
                    info!(
                        total_packets,
                        total_metrics,
                        "StatsD 수신 통계 (최근 30초)"
                    );
                    last_stats_at = tokio::time::Instant::now();
                }
            }
        }
    }
}
