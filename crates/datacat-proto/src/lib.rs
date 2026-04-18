//! datacat-proto
//!
//! OTLP protobuf 타입을 opentelemetry-proto crate에서 re-export한다.
//! 직접 proto 파일을 번들링하지 않고 upstream crate를 의존성으로 사용하여
//! OTLP 스펙 업데이트 시 버전 범프만으로 대응 가능하도록 설계.

// Trace 관련 메시지 타입
pub use opentelemetry_proto::tonic::trace::v1 as trace_v1;

// Logs 관련 메시지 타입
pub use opentelemetry_proto::tonic::logs::v1 as logs_v1;

// Metrics 관련 메시지 타입
pub use opentelemetry_proto::tonic::metrics::v1 as metrics_v1;

// Collector service 정의 (gRPC 서비스 트레이트 포함)
pub use opentelemetry_proto::tonic::collector::trace::v1 as collector_trace_v1;
pub use opentelemetry_proto::tonic::collector::logs::v1 as collector_logs_v1;
pub use opentelemetry_proto::tonic::collector::metrics::v1 as collector_metrics_v1;

// 공통 타입 (AnyValue, KeyValue 등)
pub use opentelemetry_proto::tonic::common::v1 as common_v1;

// Resource 타입
pub use opentelemetry_proto::tonic::resource::v1 as resource_v1;
