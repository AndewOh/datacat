//! X-View 쿼리 핸들러
//!
//! Jennifer APM의 X-View와 동일: 각 트랜잭션을 하나의 점(scatter)으로 표현한다.
//! - X축: 시간 (start_time, Unix ms)
//! - Y축: 응답시간 (duration_ns)
//! - 색상: 0=성공(파랑), 1=에러(빨강)
//!
//! ClickHouse proj_xview projection을 활용하여 (tenant_id, service, start_time) 순으로
//! 빠르게 읽는다. 최대 500,000 포인트 반환.

use anyhow::Result;
use clickhouse::Client;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 요청 파라미터
// ---------------------------------------------------------------------------

/// GET /api/v1/xview 쿼리 파라미터.
#[derive(Debug, Deserialize)]
pub struct XViewParams {
    /// 조회 시작 시각 (Unix 타임스탬프, 밀리초)
    pub start: i64,
    /// 조회 종료 시각 (Unix 타임스탬프, 밀리초)
    pub end: i64,
    /// 서비스 필터 (없으면 전체)
    pub service: Option<String>,
    /// 환경 필터 (없으면 전체)
    pub env: Option<String>,
    /// 테넌트 ID (없으면 "default")
    pub tenant_id: Option<String>,
    /// 최대 포인트 수 (기본 500,000)
    pub limit: Option<u32>,
}

// ---------------------------------------------------------------------------
// 응답 타입 — 프론트엔드 wire 포맷과 일치
// ---------------------------------------------------------------------------

/// X-View 응답.
#[derive(Debug, Serialize)]
pub struct XViewResponse {
    /// 산점도 포인트 목록 (wire 포맷: {t, d, s})
    pub points: Vec<XViewPoint>,
    /// 집계 통계
    pub stats: XViewStats,
}

/// 산점도의 단일 포인트 — 프론트엔드 XViewPointWire {t, d, s}와 1:1 대응.
#[derive(Debug, Serialize, clickhouse::Row, Deserialize)]
pub struct XViewPoint {
    /// 요청 시작 시각 (Unix ms)
    pub t: i64,
    /// 응답시간 (나노초)
    pub d: u64,
    /// 상태: 0=성공, 1=에러
    pub s: u8,
}

/// 전체 집계 통계.
#[derive(Debug, Serialize)]
pub struct XViewStats {
    pub total: u64,
    pub errors: u64,
    pub p50_ns: u64,
    pub p95_ns: u64,
    pub p99_ns: u64,
}

// ---------------------------------------------------------------------------
// 쿼리 구현
// ---------------------------------------------------------------------------

/// X-View 산점도 데이터를 ClickHouse에서 조회한다.
pub async fn query_xview(client: &Client, params: &XViewParams) -> Result<XViewResponse> {
    let tenant_id = params.tenant_id.as_deref().unwrap_or("default");
    let limit = params.limit.unwrap_or(500_000);

    // SQL 인젝션 방어: 모든 string 값에 single-quote 이스케이프 적용
    let tenant_escaped = tenant_id.replace('\'', "\\'");

    let mut conditions = vec![
        format!("tenant_id = '{}'", tenant_escaped),
        format!("start_time >= fromUnixTimestamp64Milli({})", params.start),
        format!("start_time <  fromUnixTimestamp64Milli({})", params.end),
    ];

    if let Some(svc) = &params.service {
        conditions.push(format!("service = '{}'", svc.replace('\'', "\\'")));
    }
    if let Some(env) = &params.env {
        conditions.push(format!("env = '{}'", env.replace('\'', "\\'")));
    }

    let where_clause = conditions.join(" AND ");

    // 산점도 쿼리: proj_xview projection 활용 (ORDER BY tenant_id, service, start_time)
    let scatter_sql = format!(
        r#"
        SELECT
            toUnixTimestamp64Milli(start_time) AS t,
            duration_ns                         AS d,
            if(status_code = 2, 1, 0)           AS s
        FROM datacat.spans
        WHERE {where_clause}
        ORDER BY start_time
        LIMIT {limit}
        "#,
        where_clause = where_clause,
        limit = limit,
    );

    // 통계 쿼리
    let stats_sql = format!(
        r#"
        SELECT
            count()                       AS total,
            countIf(status_code = 2)      AS errors,
            quantile(0.50)(duration_ns)   AS p50_ns,
            quantile(0.95)(duration_ns)   AS p95_ns,
            quantile(0.99)(duration_ns)   AS p99_ns
        FROM datacat.spans
        WHERE {where_clause}
        "#,
        where_clause = where_clause,
    );

    // 산점도 포인트 조회
    let points: Vec<XViewPoint> = client
        .query(&scatter_sql)
        .fetch_all()
        .await
        .unwrap_or_default();

    // 통계 조회
    #[derive(clickhouse::Row, Deserialize)]
    struct StatsRow {
        total: u64,
        errors: u64,
        p50_ns: u64,
        p95_ns: u64,
        p99_ns: u64,
    }

    let stats = client
        .query(&stats_sql)
        .fetch_optional::<StatsRow>()
        .await
        .unwrap_or(None)
        .map(|r| XViewStats {
            total: r.total,
            errors: r.errors,
            p50_ns: r.p50_ns,
            p95_ns: r.p95_ns,
            p99_ns: r.p99_ns,
        })
        .unwrap_or(XViewStats { total: 0, errors: 0, p50_ns: 0, p95_ns: 0, p99_ns: 0 });

    Ok(XViewResponse { points, stats })
}
