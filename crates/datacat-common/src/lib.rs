//! datacat-common
//!
//! 플랫폼 전체에서 공유되는 핵심 도메인 타입을 정의한다.
//! 이 crate는 외부 의존성을 최소화하여 컴파일 타임과 바이너리 크기를 줄인다.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use thiserror::Error;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// TenantId — 멀티테넌트 격리의 기본 단위
// ---------------------------------------------------------------------------

/// 테넌트를 식별하는 newtype wrapper.
/// String을 직접 사용하는 것보다 타입 안전성을 보장한다.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TenantId(pub String);

impl TenantId {
    pub fn new(id: impl Into<String>) -> Self {
        TenantId(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TenantId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

// ---------------------------------------------------------------------------
// Tag — 범용 키-값 쌍
// ---------------------------------------------------------------------------

/// Span, Log, Metric에 첨부되는 키-값 속성.
/// ClickHouse에서는 attrs_keys / attrs_values 배열로 저장된다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Tag {
    pub key: String,
    pub value: TagValue,
}

/// Tag 값의 가능한 타입.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TagValue {
    String(String),
    Int(i64),
    Float(f64),
    Bool(bool),
}

impl fmt::Display for TagValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TagValue::String(s) => write!(f, "{}", s),
            TagValue::Int(i) => write!(f, "{}", i),
            TagValue::Float(v) => write!(f, "{}", v),
            TagValue::Bool(b) => write!(f, "{}", b),
        }
    }
}

// ---------------------------------------------------------------------------
// SpanKind — OTel span kind
// ---------------------------------------------------------------------------

/// OTel SpanKind에 대응하는 열거형.
/// ClickHouse에는 UInt8로 저장한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum SpanKind {
    Unspecified = 0,
    Internal = 1,
    Server = 2,
    Client = 3,
    Producer = 4,
    Consumer = 5,
}

impl From<i32> for SpanKind {
    fn from(v: i32) -> Self {
        match v {
            1 => SpanKind::Internal,
            2 => SpanKind::Server,
            3 => SpanKind::Client,
            4 => SpanKind::Producer,
            5 => SpanKind::Consumer,
            _ => SpanKind::Unspecified,
        }
    }
}

// ---------------------------------------------------------------------------
// StatusCode — OTel span status
// ---------------------------------------------------------------------------

/// OTel StatusCode에 대응하는 열거형.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum StatusCode {
    Unset = 0,
    Ok = 1,
    Error = 2,
}

impl From<i32> for StatusCode {
    fn from(v: i32) -> Self {
        match v {
            1 => StatusCode::Ok,
            2 => StatusCode::Error,
            _ => StatusCode::Unset,
        }
    }
}

// ---------------------------------------------------------------------------
// Span — 분산 추적의 기본 단위
// ---------------------------------------------------------------------------

/// 단일 Span을 나타내는 도메인 모델.
/// OTel Span 스펙을 따르되, ClickHouse 저장에 최적화된 필드 구조를 갖는다.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Span {
    /// 이 Span이 속한 테넌트
    pub tenant_id: TenantId,
    /// 전체 trace를 식별하는 32자 hex 문자열 (128비트)
    pub trace_id: String,
    /// 이 Span을 식별하는 16자 hex 문자열 (64비트)
    pub span_id: String,
    /// 부모 Span의 ID. 루트 Span이면 빈 문자열
    pub parent_span_id: String,
    /// Span 이름 (예: "GET /api/users", "db.query")
    pub name: String,
    /// 서비스 이름 (resource attribute에서 추출)
    pub service: String,
    /// 배포 환경 (예: "production", "staging")
    pub env: String,
    /// Span 종류
    pub kind: SpanKind,
    /// Span 시작 시각 (UTC nanoseconds)
    pub start_time: DateTime<Utc>,
    /// Span 종료 시각 (UTC nanoseconds)
    pub end_time: DateTime<Utc>,
    /// 소요 시간 (나노초)
    pub duration_ns: u64,
    /// 상태 코드
    pub status_code: StatusCode,
    /// 상태 메시지 (에러 시 상세 정보)
    pub status_msg: String,
    /// Span 속성 키 목록 (attrs_keys 배열)
    pub attrs_keys: Vec<String>,
    /// Span 속성 값 목록 (attrs_values 배열, attrs_keys와 1:1 대응)
    pub attrs_values: Vec<String>,
    /// Resource 속성 키 목록
    pub resource_keys: Vec<String>,
    /// Resource 속성 값 목록
    pub resource_values: Vec<String>,
}

impl Span {
    /// 새 Span을 생성한다. trace_id와 span_id는 UUID v4 기반으로 자동 생성.
    pub fn new(tenant_id: TenantId, name: impl Into<String>, service: impl Into<String>) -> Self {
        let now = Utc::now();
        Span {
            tenant_id,
            trace_id: Uuid::new_v4().simple().to_string(),
            span_id: Uuid::new_v4().simple().to_string()[..16].to_string(),
            parent_span_id: String::new(),
            name: name.into(),
            service: service.into(),
            env: "unknown".to_string(),
            kind: SpanKind::Internal,
            start_time: now,
            end_time: now,
            duration_ns: 0,
            status_code: StatusCode::Unset,
            status_msg: String::new(),
            attrs_keys: Vec::new(),
            attrs_values: Vec::new(),
            resource_keys: Vec::new(),
            resource_values: Vec::new(),
        }
    }

    /// Tags 슬라이스로부터 attrs_keys / attrs_values를 채운다.
    pub fn set_attrs(&mut self, tags: &[Tag]) {
        self.attrs_keys = tags.iter().map(|t| t.key.clone()).collect();
        self.attrs_values = tags.iter().map(|t| t.value.to_string()).collect();
    }
}

// ---------------------------------------------------------------------------
// Log — 구조화된 로그 이벤트
// ---------------------------------------------------------------------------

/// 로그 심각도 수준 (OTel Severity 스펙 기반).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Severity {
    Trace = 1,
    Debug = 5,
    Info = 9,
    Warn = 13,
    Error = 17,
    Fatal = 21,
}

impl From<i32> for Severity {
    fn from(v: i32) -> Self {
        match v {
            1..=4 => Severity::Trace,
            5..=8 => Severity::Debug,
            9..=12 => Severity::Info,
            13..=16 => Severity::Warn,
            17..=20 => Severity::Error,
            21..=24 => Severity::Fatal,
            _ => Severity::Info,
        }
    }
}

/// 단일 로그 이벤트.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Log {
    pub tenant_id: TenantId,
    pub timestamp: DateTime<Utc>,
    /// 연관된 trace ID (없으면 빈 문자열)
    pub trace_id: String,
    /// 연관된 span ID (없으면 빈 문자열)
    pub span_id: String,
    pub severity: Severity,
    pub service: String,
    pub env: String,
    /// 로그 본문
    pub body: String,
    pub attrs_keys: Vec<String>,
    pub attrs_values: Vec<String>,
}

// ---------------------------------------------------------------------------
// Metric — 시계열 지표
// ---------------------------------------------------------------------------

/// 메트릭 타입.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum MetricType {
    Gauge = 0,
    Sum = 1,
    Histogram = 2,
}

/// 단일 메트릭 데이터 포인트.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metric {
    pub tenant_id: TenantId,
    pub timestamp: DateTime<Utc>,
    pub name: String,
    pub metric_type: MetricType,
    pub value: f64,
    pub service: String,
    pub env: String,
    pub attrs_keys: Vec<String>,
    pub attrs_values: Vec<String>,
}

// ---------------------------------------------------------------------------
// 공통 에러 타입
// ---------------------------------------------------------------------------

/// datacat 전체에서 공유하는 에러 타입.
#[derive(Debug, Error)]
pub enum DatacatError {
    #[error("invalid tenant id: {0}")]
    InvalidTenantId(String),

    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("invalid span: {0}")]
    InvalidSpan(String),

    #[error("invalid log: {0}")]
    InvalidLog(String),

    #[error("invalid metric: {0}")]
    InvalidMetric(String),

    #[error("storage error: {0}")]
    Storage(String),

    #[error("kafka error: {0}")]
    Kafka(String),

    #[error("internal error: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, DatacatError>;
