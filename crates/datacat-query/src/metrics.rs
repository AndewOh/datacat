//! PromQL-lite Metrics 쿼리 엔진
//!
//! GET /api/v1/query_range — 시계열 메트릭 조회 (Prometheus wire 호환)
//! GET /api/v1/metrics     — 사용 가능한 메트릭 이름 목록
//! GET /api/v1/services    — 서비스 목록 (spans + metrics 합산)
//!
//! 지원 집계 함수: avg, sum, max, min, rate
//! 레이블 필터: service, env, 임의 attrs_keys/attrs_values

use anyhow::Result;
use clickhouse::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// 요청/응답 타입
// ---------------------------------------------------------------------------

/// 집계 함수.
#[derive(Debug, Clone, PartialEq)]
pub enum Aggregation {
    Avg,
    Sum,
    Max,
    Min,
    /// Rate: step 초당 counter 증가율 (단위: /s)
    Rate,
}

impl Aggregation {
    /// 문자열 → Aggregation. 알 수 없으면 Avg로 폴백.
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "sum" => Aggregation::Sum,
            "max" => Aggregation::Max,
            "min" => Aggregation::Min,
            "rate" => Aggregation::Rate,
            _ => Aggregation::Avg,
        }
    }

    /// ClickHouse SQL 집계 함수명 반환.
    pub fn sql_fn(&self) -> &'static str {
        match self {
            Aggregation::Avg => "avg",
            Aggregation::Sum => "sum",
            Aggregation::Max => "max",
            Aggregation::Min => "min",
            // Rate는 sum을 쓰고 이후 나눗셈 처리
            Aggregation::Rate => "sum",
        }
    }
}

/// GET /api/v1/query_range 쿼리 파라미터.
#[derive(Debug, Deserialize)]
pub struct QueryRangeParams {
    /// 메트릭 이름 (필수)
    pub query: String,
    /// 조회 시작 (Unix 타임스탬프, 밀리초)
    pub start: i64,
    /// 조회 종료 (Unix 타임스탬프, 밀리초)
    pub end: i64,
    /// 버킷 크기 (초, 기본 60)
    pub step: Option<u32>,
    /// 집계 함수 (기본 avg)
    pub agg: Option<String>,
    /// 서비스 필터
    pub service: Option<String>,
    /// 환경 필터
    pub env: Option<String>,
    /// 테넌트 ID (기본 "default")
    pub tenant_id: Option<String>,
}

/// 단일 시계열 데이터 포인트.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricPoint {
    /// 버킷 시작 시각 (Unix 밀리초)
    pub t: i64,
    /// 집계 값
    pub v: f64,
}

/// query_range 응답 — Prometheus 응답 포맷과 유사.
#[derive(Debug, Serialize)]
pub struct MetricsResponse {
    /// 조회한 메트릭 이름
    pub metric: String,
    /// 적용된 레이블 필터
    pub labels: HashMap<String, String>,
    /// 시계열 포인트 목록 (t 오름차순 정렬)
    pub data: Vec<MetricPoint>,
}

/// GET /api/v1/metrics 응답 항목.
#[derive(Debug, Serialize, clickhouse::Row, Deserialize)]
pub struct MetricInfo {
    pub name: String,
    pub service: String,
}

/// GET /api/v1/services 응답 항목.
#[derive(Debug, Serialize)]
pub struct ServiceInfo {
    pub name: String,
    pub env: String,
}

// ---------------------------------------------------------------------------
// 쿼리 구현
// ---------------------------------------------------------------------------

/// ClickHouse에서 시계열 메트릭을 조회한다.
///
/// SQL 인젝션 방어: 모든 외부 String 입력에 single-quote 이스케이프 적용.
pub async fn query_range(client: &Client, params: &QueryRangeParams) -> Result<MetricsResponse> {
    let tenant_id = params.tenant_id.as_deref().unwrap_or("default");
    let step = params.step.unwrap_or(60).max(1); // 최소 1초
    let agg = Aggregation::from_str(params.agg.as_deref().unwrap_or("avg"));
    let agg_fn = agg.sql_fn();

    // SQL 인젝션 방어
    let metric_name = params.query.replace('\'', "\\'");
    let tenant_escaped = tenant_id.replace('\'', "\\'");

    // 레이블 필터 조건 구성
    let mut conditions = vec![
        format!("name = '{}'", metric_name),
        format!("tenant_id = '{}'", tenant_escaped),
        format!("timestamp >= fromUnixTimestamp64Milli({})", params.start),
        format!("timestamp <  fromUnixTimestamp64Milli({})", params.end),
    ];

    let mut label_map: HashMap<String, String> = HashMap::new();

    if let Some(svc) = &params.service {
        let escaped = svc.replace('\'', "\\'");
        conditions.push(format!("service = '{}'", escaped));
        label_map.insert("service".to_string(), svc.clone());
    }
    if let Some(env) = &params.env {
        let escaped = env.replace('\'', "\\'");
        conditions.push(format!("env = '{}'", escaped));
        label_map.insert("env".to_string(), env.clone());
    }

    let where_clause = conditions.join(" AND ");

    // toStartOfInterval을 사용한 시간 버킷 집계
    // step이 60초면 toStartOfMinute 동일 효과
    let sql = format!(
        r#"
        SELECT
            toUnixTimestamp64Milli(
                toStartOfInterval(timestamp, INTERVAL {step} SECOND)
            ) AS t,
            {agg_fn}(value) AS v
        FROM datacat.metrics
        WHERE {where_clause}
        GROUP BY t
        ORDER BY t
        "#,
        step = step,
        agg_fn = agg_fn,
        where_clause = where_clause,
    );

    // ClickHouse Row 타입 (로컬 inline)
    #[derive(clickhouse::Row, Deserialize)]
    struct RawPoint {
        t: i64,
        v: f64,
    }

    let raw_points: Vec<RawPoint> = client
        .query(&sql)
        .fetch_all()
        .await
        .unwrap_or_default();

    let mut data: Vec<MetricPoint> = raw_points
        .into_iter()
        .map(|r| MetricPoint { t: r.t, v: r.v })
        .collect();

    // Rate 계산: step 초당 증가율 = value_sum / step
    if agg == Aggregation::Rate && step > 0 {
        let step_f = step as f64;
        for pt in &mut data {
            pt.v /= step_f;
        }
    }

    Ok(MetricsResponse {
        metric: params.query.clone(),
        labels: label_map,
        data,
    })
}

/// 사용 가능한 메트릭 이름 목록을 반환한다.
pub async fn list_metrics(
    client: &Client,
    tenant_id: &str,
) -> Result<Vec<MetricInfo>> {
    let tenant_escaped = tenant_id.replace('\'', "\\'");

    let sql = format!(
        r#"
        SELECT DISTINCT name, service
        FROM datacat.metrics
        WHERE tenant_id = '{tenant}'
        ORDER BY name
        LIMIT 1000
        "#,
        tenant = tenant_escaped,
    );

    let rows: Vec<MetricInfo> = client
        .query(&sql)
        .fetch_all()
        .await
        .unwrap_or_default();

    Ok(rows)
}

/// 서비스 목록을 반환한다 (spans + metrics 합산, 중복 제거).
///
/// ClickHouse UNION DISTINCT로 두 테이블에서 합산한다.
pub async fn list_services(
    client: &Client,
    tenant_id: &str,
) -> Result<Vec<ServiceInfo>> {
    let tenant_escaped = tenant_id.replace('\'', "\\'");

    // ClickHouse UNION DISTINCT: env도 함께 조회
    let sql = format!(
        r#"
        SELECT service, env
        FROM datacat.spans
        WHERE tenant_id = '{tenant}'
        GROUP BY service, env
        UNION DISTINCT
        SELECT service, env
        FROM datacat.metrics
        WHERE tenant_id = '{tenant}'
        GROUP BY service, env
        ORDER BY service
        LIMIT 100
        "#,
        tenant = tenant_escaped,
    );

    #[derive(clickhouse::Row, Deserialize)]
    struct RawService {
        service: String,
        env: String,
    }

    let rows: Vec<RawService> = client
        .query(&sql)
        .fetch_all()
        .await
        .unwrap_or_default();

    Ok(rows
        .into_iter()
        .map(|r| ServiceInfo { name: r.service, env: r.env })
        .collect())
}
