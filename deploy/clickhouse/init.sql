CREATE DATABASE IF NOT EXISTS datacat;

-- ===========================
-- SPANS TABLE (트랜잭션/트레이스)
-- ===========================
CREATE TABLE IF NOT EXISTS datacat.spans (
    tenant_id        LowCardinality(String),
    trace_id         FixedString(32),
    span_id          FixedString(16),
    parent_span_id   FixedString(16),
    name             LowCardinality(String),
    service          LowCardinality(String),
    env              LowCardinality(String),
    kind             UInt8,         -- SpanKind
    start_time       DateTime64(9, 'UTC'),
    end_time         DateTime64(9, 'UTC'),
    duration_ns      UInt64,
    status_code      UInt8,         -- 0:unset, 1:ok, 2:error
    status_msg       String,
    attrs_keys       Array(LowCardinality(String)),
    attrs_values     Array(String),
    resource_keys    Array(LowCardinality(String)),
    resource_values  Array(String),
    -- Bloom filter index: trace_id 조회 가속
    INDEX idx_trace_id  trace_id  TYPE bloom_filter(0.001) GRANULARITY 1,
    -- MinMax: 응답시간 범위 필터
    INDEX idx_duration  duration_ns TYPE minmax GRANULARITY 1,
    -- 에러 스팬 빠른 필터
    INDEX idx_status    status_code TYPE set(4) GRANULARITY 1
) ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMMDD(start_time))
ORDER BY (tenant_id, service, start_time, trace_id)
TTL start_time + INTERVAL 30 DAY DELETE
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 3600;

-- X-View Projection: (tenant, service, time) → 응답시간 분포 빠른 조회
ALTER TABLE datacat.spans
    ADD PROJECTION IF NOT EXISTS proj_xview (
        SELECT
            tenant_id, service, env,
            start_time, duration_ns, status_code,
            trace_id, span_id
        ORDER BY (tenant_id, service, start_time)
    );

ALTER TABLE datacat.spans MATERIALIZE PROJECTION proj_xview;

-- ===========================
-- LOGS TABLE
-- ===========================
CREATE TABLE IF NOT EXISTS datacat.logs (
    tenant_id        LowCardinality(String),
    timestamp        DateTime64(9, 'UTC'),
    trace_id         FixedString(32),
    span_id          FixedString(16),
    severity_number  UInt8,
    severity_text    LowCardinality(String),
    service          LowCardinality(String),
    env              LowCardinality(String),
    body             String,
    attrs_keys       Array(LowCardinality(String)),
    attrs_values     Array(String),
    resource_keys    Array(LowCardinality(String)),
    resource_values  Array(String),
    INDEX idx_trace_id trace_id  TYPE bloom_filter(0.001) GRANULARITY 1,
    -- 전문 검색 가속
    INDEX idx_body     body      TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1,
    INDEX idx_severity severity_number TYPE set(8) GRANULARITY 1
) ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMMDD(timestamp))
ORDER BY (tenant_id, service, timestamp, trace_id)
TTL timestamp + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;

-- ===========================
-- METRICS TABLE
-- ===========================
CREATE TABLE IF NOT EXISTS datacat.metrics (
    tenant_id    LowCardinality(String),
    timestamp    DateTime64(3, 'UTC'),
    name         LowCardinality(String),
    type         UInt8,    -- 0:gauge, 1:sum, 2:histogram, 3:summary
    value        Float64,
    service      LowCardinality(String),
    env          LowCardinality(String),
    attrs_keys   Array(LowCardinality(String)),
    attrs_values Array(String),
    INDEX idx_name name TYPE set(100) GRANULARITY 1
) ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMMDD(timestamp))
ORDER BY (tenant_id, name, service, timestamp)
TTL timestamp + INTERVAL 30 DAY DELETE
SETTINGS index_granularity = 8192;

-- ===========================
-- PROFILES TABLE (Phase 4 대비)
-- ===========================
CREATE TABLE IF NOT EXISTS datacat.profiles (
    tenant_id    LowCardinality(String),
    timestamp    DateTime64(9, 'UTC'),
    service      LowCardinality(String),
    env          LowCardinality(String),
    profile_id   FixedString(32),
    type         LowCardinality(String),  -- cpu, heap, goroutine
    payload      String   -- pprof/jfr base64 (Phase 4에서 실제 파싱)
) ENGINE = MergeTree()
PARTITION BY (tenant_id, toYYYYMMDD(timestamp))
ORDER BY (tenant_id, service, timestamp)
TTL timestamp + INTERVAL 7 DAY DELETE;

-- ===========================
-- MATERIALIZED VIEW: 서비스별 분당 통계 (대시보드 가속)
-- ===========================
CREATE TABLE IF NOT EXISTS datacat.span_stats_1m (
    tenant_id    LowCardinality(String),
    service      LowCardinality(String),
    env          LowCardinality(String),
    window       DateTime,             -- 1분 버킷
    count        UInt64,
    error_count  UInt64,
    p50_ns       UInt64,
    p95_ns       UInt64,
    p99_ns       UInt64,
    avg_ns       Float64
) ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(window)
ORDER BY (tenant_id, service, window)
TTL window + INTERVAL 90 DAY;

CREATE MATERIALIZED VIEW IF NOT EXISTS datacat.mv_span_stats_1m
TO datacat.span_stats_1m AS
SELECT
    tenant_id,
    service,
    env,
    toStartOfMinute(start_time) AS window,
    count()        AS count,
    countIf(status_code = 2) AS error_count,
    quantile(0.50)(duration_ns) AS p50_ns,
    quantile(0.95)(duration_ns) AS p95_ns,
    quantile(0.99)(duration_ns) AS p99_ns,
    avg(duration_ns) AS avg_ns
FROM datacat.spans
GROUP BY tenant_id, service, env, window;
