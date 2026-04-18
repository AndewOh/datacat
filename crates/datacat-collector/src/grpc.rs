//! OTLP gRPC 수신기 (tonic 기반)
//!
//! OTel Collector 호환 gRPC 엔드포인트를 제공한다.
//! - TraceService: POST /opentelemetry.proto.collector.trace.v1.TraceService/Export
//! - LogsService: POST /opentelemetry.proto.collector.logs.v1.LogsService/Export
//! - MetricsService: POST /opentelemetry.proto.collector.metrics.v1.MetricsService/Export

use crate::producer::KafkaProducer;
use anyhow::Result;
use opentelemetry_proto::tonic::collector::{
    logs::v1::{
        logs_service_server::{LogsService, LogsServiceServer},
        ExportLogsServiceRequest, ExportLogsServiceResponse,
    },
    metrics::v1::{
        metrics_service_server::{MetricsService, MetricsServiceServer},
        ExportMetricsServiceRequest, ExportMetricsServiceResponse,
    },
    trace::v1::{
        trace_service_server::{TraceService, TraceServiceServer},
        ExportTraceServiceRequest, ExportTraceServiceResponse,
    },
};
use prost::Message;
use std::net::SocketAddr;
use tonic::{Request, Response, Status};
use tracing::{debug, error, info};

// ---------------------------------------------------------------------------
// TraceService 구현
// ---------------------------------------------------------------------------

pub struct TraceServiceImpl {
    producer: KafkaProducer,
    spans_topic: String,
}

#[tonic::async_trait]
impl TraceService for TraceServiceImpl {
    async fn export(
        &self,
        request: Request<ExportTraceServiceRequest>,
    ) -> std::result::Result<Response<ExportTraceServiceResponse>, Status> {
        let req = request.into_inner();
        let span_count: usize = req
            .resource_spans
            .iter()
            .flat_map(|rs| &rs.scope_spans)
            .map(|ss| ss.spans.len())
            .sum();

        debug!(span_count, "TraceService::export 수신");

        // 프로토버프 직렬화 후 Kafka로 전송
        let payload = req.encode_to_vec();
        self.producer
            .send_best_effort(&self.spans_topic, "trace", &payload)
            .await;

        Ok(Response::new(ExportTraceServiceResponse {
            partial_success: None,
        }))
    }
}

// ---------------------------------------------------------------------------
// LogsService 구현
// ---------------------------------------------------------------------------

pub struct LogsServiceImpl {
    producer: KafkaProducer,
    logs_topic: String,
}

#[tonic::async_trait]
impl LogsService for LogsServiceImpl {
    async fn export(
        &self,
        request: Request<ExportLogsServiceRequest>,
    ) -> std::result::Result<Response<ExportLogsServiceResponse>, Status> {
        let req = request.into_inner();
        let log_count: usize = req
            .resource_logs
            .iter()
            .flat_map(|rl| &rl.scope_logs)
            .map(|sl| sl.log_records.len())
            .sum();

        debug!(log_count, "LogsService::export 수신");

        let payload = req.encode_to_vec();
        self.producer
            .send_best_effort(&self.logs_topic, "logs", &payload)
            .await;

        Ok(Response::new(ExportLogsServiceResponse {
            partial_success: None,
        }))
    }
}

// ---------------------------------------------------------------------------
// MetricsService 구현
// ---------------------------------------------------------------------------

pub struct MetricsServiceImpl {
    producer: KafkaProducer,
    metrics_topic: String,
}

#[tonic::async_trait]
impl MetricsService for MetricsServiceImpl {
    async fn export(
        &self,
        request: Request<ExportMetricsServiceRequest>,
    ) -> std::result::Result<Response<ExportMetricsServiceResponse>, Status> {
        let req = request.into_inner();
        let metric_count: usize = req
            .resource_metrics
            .iter()
            .flat_map(|rm| &rm.scope_metrics)
            .map(|sm| sm.metrics.len())
            .sum();

        debug!(metric_count, "MetricsService::export 수신");

        let payload = req.encode_to_vec();
        self.producer
            .send_best_effort(&self.metrics_topic, "metrics", &payload)
            .await;

        Ok(Response::new(ExportMetricsServiceResponse {
            partial_success: None,
        }))
    }
}

// ---------------------------------------------------------------------------
// 서버 기동
// ---------------------------------------------------------------------------

/// gRPC 서버를 주어진 주소에 바인딩하고 서비스를 등록한다.
pub async fn serve(addr: SocketAddr, producer: KafkaProducer) -> Result<()> {
    info!(%addr, "gRPC 서버 시작");

    let trace_svc = TraceServiceServer::new(TraceServiceImpl {
        producer: producer.clone(),
        spans_topic: "datacat.spans".to_string(),
    });

    let logs_svc = LogsServiceServer::new(LogsServiceImpl {
        producer: producer.clone(),
        logs_topic: "datacat.logs".to_string(),
    });

    let metrics_svc = MetricsServiceServer::new(MetricsServiceImpl {
        producer: producer.clone(),
        metrics_topic: "datacat.metrics".to_string(),
    });

    tonic::transport::Server::builder()
        .add_service(trace_svc)
        .add_service(logs_svc)
        .add_service(metrics_svc)
        .serve(addr)
        .await
        .map_err(|e| {
            error!(%e, "gRPC 서버 오류");
            anyhow::anyhow!("gRPC 서버 오류: {}", e)
        })?;

    Ok(())
}
