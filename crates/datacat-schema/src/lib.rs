//! datacat-schema
//!
//! ClickHouse DDL 스키마를 Rust 상수로 정의한다.
//! 런타임에 `clickhouse` crate를 통해 이 DDL을 실행하여
//! 테이블과 인덱스를 초기화한다.
//!
//! 스키마 설계 원칙:
//! - MergeTree 엔진: 고처리량 삽입과 효율적인 범위 쿼리
//! - PARTITION BY: 테넌트 + 날짜 조합으로 데이터 격리 및 TTL 관리
//! - ORDER BY: 가장 빈번한 쿼리 패턴에 맞는 정렬키 설계
//! - TTL: 30일 자동 만료로 스토리지 비용 제어
//! - Bloom filter index: trace_id 포인트 조회 최적화

// ---------------------------------------------------------------------------
// 데이터베이스
// ---------------------------------------------------------------------------

/// datacat 전용 데이터베이스 생성 DDL.
pub const CREATE_DATABASE: &str = r#"
CREATE DATABASE IF NOT EXISTS datacat
"#;

// ---------------------------------------------------------------------------
// Spans 테이블
// ---------------------------------------------------------------------------

/// 분산 추적 Span 저장 테이블 DDL.
///
/// - trace_id: FixedString(32) — 128비트를 32자 hex로 표현
/// - span_id: FixedString(16) — 64비트를 16자 hex로 표현
/// - attrs_keys/attrs_values: 병렬 배열 구조로 유연한 속성 저장
/// - idx_trace_id: Bloom filter로 trace_id 포인트 조회 O(1) 근사
/// - idx_duration: MinMax 인덱스로 slow span 범위 쿼리 최적화
pub const CREATE_SPANS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS datacat.spans
(
    tenant_id         LowCardinality(String),
    trace_id          String,
    span_id           String,
    parent_span_id    String,
    name              LowCardinality(String),
    service           LowCardinality(String),
    env               LowCardinality(String),
    kind              UInt8,
    start_time        Int64,
    end_time          Int64,
    duration_ns       UInt64,
    status_code       UInt8,
    status_msg        String,
    attrs_keys        Array(LowCardinality(String)),
    attrs_values      Array(String),
    resource_keys     Array(LowCardinality(String)),
    resource_values   Array(String),
    INDEX idx_trace_id  trace_id    TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_duration  duration_ns TYPE minmax             GRANULARITY 1
)
ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMM(toDateTime(start_time / 1000000000)))
ORDER BY (tenant_id, service, start_time, trace_id)
SETTINGS index_granularity = 8192
"#;

/// X-View를 위한 Projection 추가 DDL.
///
/// Projection은 동일 데이터를 다른 정렬 순서로 미리 집계해 두어
/// 응답시간 분포(히트맵) 쿼리의 성능을 극대화한다.
pub const ADD_XVIEW_PROJECTION: &str = r#"
ALTER TABLE datacat.spans ADD PROJECTION IF NOT EXISTS xview_proj
(
    SELECT
        tenant_id,
        service,
        start_time,
        duration_ns,
        status_code,
        trace_id,
        span_id
    ORDER BY (tenant_id, service, start_time)
)
"#;

/// Projection 빌드 DDL (기존 데이터에 소급 적용).
pub const MATERIALIZE_XVIEW_PROJECTION: &str = r#"
ALTER TABLE datacat.spans MATERIALIZE PROJECTION xview_proj
"#;

// ---------------------------------------------------------------------------
// Logs 테이블
// ---------------------------------------------------------------------------

/// 구조화 로그 저장 테이블 DDL.
///
/// - idx_body: tokenbf_v1 인덱스로 전문 검색(full-text search) 지원
/// - idx_trace_id: trace와 log 상관분석을 위한 Bloom filter
pub const CREATE_LOGS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS datacat.logs
(
    tenant_id      LowCardinality(String),
    timestamp      Int64,
    trace_id       String,
    span_id        String,
    severity_number UInt8,
    severity_text  LowCardinality(String),
    service        LowCardinality(String),
    env            LowCardinality(String),
    body           String,
    attrs_keys     Array(LowCardinality(String)),
    attrs_values   Array(String),
    INDEX idx_trace_id trace_id TYPE bloom_filter(0.001)       GRANULARITY 1,
    INDEX idx_body     body     TYPE tokenbf_v1(32768, 3, 0)   GRANULARITY 1
)
ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMM(toDateTime(timestamp / 1000000000)))
ORDER BY (tenant_id, service, timestamp)
"#;

// ---------------------------------------------------------------------------
// Metrics 테이블
// ---------------------------------------------------------------------------

/// 시계열 메트릭 저장 테이블 DDL.
///
/// - type: 0=gauge, 1=sum(counter), 2=histogram
/// - timestamp: DateTime64(3) — 밀리초 정밀도 (메트릭은 나노초 불필요)
/// - ORDER BY에 name 포함: 특정 메트릭 시계열 range scan 최적화
pub const CREATE_METRICS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS datacat.metrics
(
    tenant_id    LowCardinality(String),
    timestamp    Int64,
    name         LowCardinality(String),
    type         UInt8,
    value        Float64,
    service      LowCardinality(String),
    env          LowCardinality(String),
    attrs_keys   Array(LowCardinality(String)),
    attrs_values Array(String)
)
ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMM(toDateTime(timestamp / 1000)))
ORDER BY (tenant_id, name, service, timestamp)
"#;

// ---------------------------------------------------------------------------
// Profiles 테이블
// ---------------------------------------------------------------------------

/// 연속 프로파일링 데이터 저장 테이블 DDL.
///
/// - profile_id: FixedString(32) — 32자 hex UUID
/// - type: LowCardinality(String) — cpu, heap, goroutine 등 프로파일 종류
/// - payload: String — pprof/Speedscope 원시 바이트 (base64 or raw)
/// - PARTITION BY tenant_id + 월별: 테넌트 격리 및 TTL 관리 용이
/// - TTL 30일: 프로파일 데이터는 단기 분석 용도
pub const CREATE_PROFILES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS datacat.profiles
(
    tenant_id    LowCardinality(String),
    timestamp    DateTime64(9, 'UTC'),
    service      LowCardinality(String),
    env          LowCardinality(String),
    profile_id   FixedString(32),
    type         LowCardinality(String),
    payload      String
)
ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMM(toDateTime(timestamp)))
ORDER BY (tenant_id, service, timestamp)
TTL toDateTime(timestamp) + INTERVAL 30 DAY
"#;

// ---------------------------------------------------------------------------
// Log Metric Rules 테이블
// ---------------------------------------------------------------------------

/// 로그 기반 메트릭 파생 규칙 저장 테이블 DDL.
///
/// - filter_type: keyword | severity | service | body_regex
/// - value_field: 비어있으면 count, 설정되면 해당 attrs 키에서 값 추출
/// - metric_type: 0=gauge, 1=counter
/// - group_by: 쉼표 구분 그룹화 키 (e.g. "service,env")
pub const CREATE_LOG_METRIC_RULES_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS datacat.log_metric_rules
(
    tenant_id    LowCardinality(String),
    rule_id      String,
    metric_name  LowCardinality(String),
    description  String,
    filter_type  LowCardinality(String),
    filter_value String,
    value_field  String,
    metric_type  UInt8,
    group_by     String,
    enabled      UInt8,
    created_at   DateTime64(3, 'UTC')
)
ENGINE = MergeTree()
ORDER BY (tenant_id, rule_id)
"#;

// ---------------------------------------------------------------------------
// 마이그레이션 헬퍼
// ---------------------------------------------------------------------------

/// 초기화 순서대로 실행해야 하는 DDL 목록.
/// `datacat-ingester` 또는 별도의 migration CLI가 이 순서로 실행한다.
pub const INIT_DDL: &[&str] = &[
    CREATE_DATABASE,
    CREATE_SPANS_TABLE,
    CREATE_LOGS_TABLE,
    CREATE_METRICS_TABLE,
    ADD_XVIEW_PROJECTION,
    MATERIALIZE_XVIEW_PROJECTION,
    CREATE_PROFILES_TABLE,
    CREATE_LOG_METRIC_RULES_TABLE,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_ddl_non_empty() {
        for ddl in INIT_DDL {
            assert!(!ddl.trim().is_empty(), "DDL 상수가 비어 있으면 안 됩니다");
        }
    }

    #[test]
    fn spans_table_has_required_columns() {
        assert!(CREATE_SPANS_TABLE.contains("trace_id"));
        assert!(CREATE_SPANS_TABLE.contains("span_id"));
        assert!(CREATE_SPANS_TABLE.contains("duration_ns"));
        assert!(CREATE_SPANS_TABLE.contains("bloom_filter"));
    }

    #[test]
    fn logs_table_has_fulltext_index() {
        assert!(CREATE_LOGS_TABLE.contains("tokenbf_v1"));
    }
}
