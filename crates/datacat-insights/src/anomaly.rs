//! 이상 탐지 모듈
//!
//! Sliding-window Z-score 알고리즘으로 error_rate와 p99 레이턴시 이상을 감지한다.
//!
//! 알고리즘:
//! 1. ClickHouse에서 분(minute) 버킷별 error_count/total = error_rate, quantile(0.99)(duration_ns) = p99 조회
//! 2. 최근 60버킷의 평균과 표준편차 계산
//! 3. 현재 버킷의 z-score > 3.0이면 이상 판정
//! 4. 최소 5개 데이터 포인트 미만이면 빈 결과 반환

use chrono::Utc;
use clickhouse::Row;
use serde::{Deserialize, Serialize};
use tracing::error;

/// 이상 탐지 결과.
#[derive(Debug, Serialize, Clone)]
pub struct AnomalyReport {
    /// 서비스 이름 (현재는 tenant_id 범위 내 전체)
    pub service: String,
    /// 이상 메트릭 종류: "error_rate" 또는 "p99_latency_ms"
    pub metric: String,
    /// z-score (이상 점수)
    pub score: f64,
    /// 윈도우 기간 평균값 (baseline)
    pub baseline: f64,
    /// 현재 버킷 값
    pub current: f64,
    /// 탐지 시각 (Unix 밀리초)
    pub detected_at: i64,
}

/// ClickHouse에서 조회한 분별 집계 행.
#[derive(Debug, Deserialize, Row)]
#[allow(dead_code)]
struct MetricBucket {
    /// 분 버킷 (toStartOfMinute 결과, Unix 초)
    #[serde(rename = "minute")]
    pub minute_ts: i64,
    /// error_rate = countIf(status_code=2) / count()
    pub error_rate: f64,
    /// p99 레이턴시 (밀리초)
    pub p99_ms: f64,
    /// 총 요청 수
    pub total: u64,
}

/// SQL 인젝션 방지용 문자열 이스케이프.
///
/// ClickHouse 문자열 리터럴에 삽입하기 전 항상 적용한다.
fn escape_sql(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// 슬라이딩 윈도우에서 평균과 표준편차를 계산한다.
///
/// 표준편차가 0이면 (모두 동일값) z-score를 0으로 취급한다.
fn z_score(values: &[f64], current: f64) -> (f64, f64, f64) {
    if values.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    let n = values.len() as f64;
    let mean = values.iter().sum::<f64>() / n;
    let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
    let stddev = variance.sqrt();

    let score = if stddev == 0.0 {
        0.0
    } else {
        (current - mean).abs() / stddev
    };
    (score, mean, stddev)
}

/// 지정된 시간 윈도우에서 이상을 탐지한다.
///
/// # Arguments
/// * `client` - ClickHouse 클라이언트
/// * `tenant_id` - 테넌트 식별자 (SQL 이스케이프 적용)
/// * `window_minutes` - 분석할 시간 윈도우 (분 단위, 최대 1440)
///
/// # Returns
/// 감지된 이상 목록. 데이터 포인트가 5개 미만이면 빈 Vec 반환.
pub async fn detect_anomalies(
    client: &clickhouse::Client,
    tenant_id: &str,
    window_minutes: u32,
) -> Vec<AnomalyReport> {
    let safe_tenant = escape_sql(tenant_id);
    // window_minutes는 u32이므로 SQL 인젝션 위험 없음
    let window = window_minutes.min(1440);

    let query = format!(
        r#"
        SELECT
            toUnixTimestamp(toStartOfMinute(start_time)) AS minute,
            countIf(status_code = 2) / count()           AS error_rate,
            quantile(0.99)(duration_ns) / 1000000.0      AS p99_ms,
            count()                                       AS total
        FROM datacat.spans
        WHERE tenant_id = '{safe_tenant}'
          AND start_time >= now() - INTERVAL {window} MINUTE
        GROUP BY minute
        ORDER BY minute ASC
        "#
    );

    let rows: Vec<MetricBucket> = match client
        .query(&query)
        .fetch_all::<MetricBucket>()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, tenant_id, "이상 탐지 ClickHouse 쿼리 실패");
            return Vec::new();
        }
    };

    // 최소 5개 데이터 포인트 필요
    if rows.len() < 5 {
        return Vec::new();
    }

    let now_ms = Utc::now().timestamp_millis();
    let mut reports = Vec::new();

    // 마지막 버킷을 현재 값으로 사용하고, 나머지를 윈도우로 사용
    let (current_row, history) = rows.split_last().unwrap();

    // --- error_rate 이상 탐지 ---
    {
        let hist_values: Vec<f64> = history.iter().map(|r| r.error_rate).collect();
        let (score, mean, _) = z_score(&hist_values, current_row.error_rate);
        if score > 3.0 {
            reports.push(AnomalyReport {
                service: format!("tenant:{}", tenant_id),
                metric: "error_rate".to_string(),
                score,
                baseline: mean,
                current: current_row.error_rate,
                detected_at: now_ms,
            });
        }
    }

    // --- p99 레이턴시 이상 탐지 ---
    {
        let hist_values: Vec<f64> = history.iter().map(|r| r.p99_ms).collect();
        let (score, mean, _) = z_score(&hist_values, current_row.p99_ms);
        if score > 3.0 {
            reports.push(AnomalyReport {
                service: format!("tenant:{}", tenant_id),
                metric: "p99_latency_ms".to_string(),
                score,
                baseline: mean,
                current: current_row.p99_ms,
                detected_at: now_ms,
            });
        }
    }

    reports
}
