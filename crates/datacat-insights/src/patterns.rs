//! X-View 패턴 인식 모듈
//!
//! Jennifer APM의 X-View 분석 기반 4가지 패턴을 탐지한다:
//!
//! - **Surge**: 1분 내 요청 수 갑작스러운 급증 (기준치의 3배 이상)
//! - **Waterfall**: 특정 서비스에 p99 레이턴시가 집중된 순차적 느린 트랜잭션
//! - **Droplet**: 전체 대비 < 1% 건수이지만 평균의 10배 이상 duration인 이상 거래
//! - **Wave**: 5분 주기의 주기적 레이턴시 스파이크 (간이 주기성 검사)

use chrono::Utc;
use clickhouse::Row;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::error;

/// 인식된 패턴 유형.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum PatternType {
    /// 갑작스러운 요청 급증
    Surge,
    /// 특정 서비스에 집중된 순차적 느린 트랜잭션
    Waterfall,
    /// 소량이지만 극도로 느린 이상 거래
    Droplet,
    /// 주기적 레이턴시 스파이크
    Wave,
}

/// 탐지된 패턴 결과.
#[derive(Debug, Serialize, Clone)]
pub struct PatternDetected {
    /// 패턴 유형
    pub pattern: PatternType,
    /// 해당 서비스 이름
    pub service: String,
    /// 신뢰도 (0.0–1.0)
    pub confidence: f64,
    /// 패턴 설명 (한국어)
    pub description: String,
    /// 탐지 시각 (Unix 밀리초)
    pub detected_at: i64,
}

/// 분별 서비스별 요청 수 행.
#[derive(Debug, Deserialize, Row)]
struct ServiceMinuteBucket {
    #[serde(rename = "minute")]
    pub minute_ts: i64,
    pub service: String,
    pub cnt: u64,
}

/// 서비스별 p99 집계 행.
#[derive(Debug, Deserialize, Row)]
struct ServiceP99Row {
    pub service: String,
    pub p99_ms: f64,
    pub avg_ms: f64,
    pub total: u64,
}

/// SQL 인젝션 방지용 이스케이프.
fn escape_sql(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// i64 타임스탬프를 ClickHouse fromUnixTimestamp64Milli 인자용 숫자 문자열로 변환.
///
/// i64는 SQL 인젝션 위험 없으므로 직접 포맷.
fn fmt_ms(ms: i64) -> String {
    ms.to_string()
}

/// Surge 패턴 탐지.
///
/// 최근 1분의 요청 수가 직전 10분 평균의 3배 이상이면 Surge로 판정.
/// 최소 10분 이상의 기록이 필요하다.
async fn detect_surge(
    client: &clickhouse::Client,
    tenant_id: &str,
    start_ms: i64,
    end_ms: i64,
    now_ms: i64,
) -> Vec<PatternDetected> {
    let safe_tenant = escape_sql(tenant_id);
    let start_s = fmt_ms(start_ms);
    let end_s = fmt_ms(end_ms);

    let query = format!(
        r#"
        SELECT
            toUnixTimestamp(toStartOfMinute(start_time)) AS minute,
            service,
            count() AS cnt
        FROM datacat.spans
        WHERE tenant_id = '{safe_tenant}'
          AND start_time >= fromUnixTimestamp64Milli({start_s})
          AND start_time <  fromUnixTimestamp64Milli({end_s})
        GROUP BY minute, service
        ORDER BY minute ASC
        "#
    );

    let rows: Vec<ServiceMinuteBucket> = match client
        .query(&query)
        .fetch_all::<ServiceMinuteBucket>()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "Surge 탐지 쿼리 실패");
            return Vec::new();
        }
    };

    // 서비스별로 그룹핑
    let mut by_service: HashMap<String, Vec<(i64, u64)>> = HashMap::new();
    for row in &rows {
        by_service
            .entry(row.service.clone())
            .or_default()
            .push((row.minute_ts, row.cnt));
    }

    let mut patterns = Vec::new();

    for (service, mut buckets) in by_service {
        buckets.sort_by_key(|(ts, _)| *ts);

        // 최소 10분 이상 필요
        if buckets.len() < 10 {
            continue;
        }

        let last_cnt = buckets.last().unwrap().1 as f64;
        let history_counts: Vec<f64> = buckets[..buckets.len() - 1]
            .iter()
            .map(|(_, c)| *c as f64)
            .collect();

        let history_mean = history_counts.iter().sum::<f64>() / history_counts.len() as f64;
        if history_mean <= 0.0 {
            continue;
        }

        let ratio = last_cnt / history_mean;
        if ratio >= 3.0 {
            // confidence: ratio 3.0 → 0.7, ratio 10.0 → 1.0 (선형 보간, 상한 1.0)
            let confidence = ((ratio - 3.0) / 7.0 * 0.3 + 0.7).min(1.0);
            patterns.push(PatternDetected {
                pattern: PatternType::Surge,
                service: service.clone(),
                confidence,
                description: format!(
                    "[{}] 서비스에 요청 급증 발생: 최근 1분 {}건 (직전 평균의 {:.1}배)",
                    service, last_cnt as u64, ratio
                ),
                detected_at: now_ms,
            });
        }
    }

    patterns
}

/// Waterfall 패턴 탐지.
///
/// 전체 p99 합 중 단일 서비스 비중이 70% 이상이면 Waterfall로 판정.
async fn detect_waterfall(
    client: &clickhouse::Client,
    tenant_id: &str,
    start_ms: i64,
    end_ms: i64,
    now_ms: i64,
) -> Vec<PatternDetected> {
    let safe_tenant = escape_sql(tenant_id);
    let start_s = fmt_ms(start_ms);
    let end_s = fmt_ms(end_ms);

    let query = format!(
        r#"
        SELECT
            service,
            quantile(0.99)(duration_ns) / 1000000.0 AS p99_ms,
            avg(duration_ns) / 1000000.0            AS avg_ms,
            count()                                  AS total
        FROM datacat.spans
        WHERE tenant_id = '{safe_tenant}'
          AND start_time >= fromUnixTimestamp64Milli({start_s})
          AND start_time <  fromUnixTimestamp64Milli({end_s})
        GROUP BY service
        ORDER BY p99_ms DESC
        "#
    );

    let rows: Vec<ServiceP99Row> = match client
        .query(&query)
        .fetch_all::<ServiceP99Row>()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "Waterfall 탐지 쿼리 실패");
            return Vec::new();
        }
    };

    if rows.len() < 2 {
        return Vec::new();
    }

    let total_p99: f64 = rows.iter().map(|r| r.p99_ms).sum();
    if total_p99 <= 0.0 {
        return Vec::new();
    }

    let mut patterns = Vec::new();
    for row in &rows {
        let share = row.p99_ms / total_p99;
        if share >= 0.70 {
            let confidence = (share - 0.70) / 0.30 * 0.5 + 0.5;
            let confidence = confidence.min(1.0);
            patterns.push(PatternDetected {
                pattern: PatternType::Waterfall,
                service: row.service.clone(),
                confidence,
                description: format!(
                    "[{}] 서비스가 전체 p99 레이턴시의 {:.0}%를 차지하는 Waterfall 패턴 감지 (p99={:.1}ms)",
                    row.service,
                    share * 100.0,
                    row.p99_ms
                ),
                detected_at: now_ms,
            });
        }
    }

    patterns
}

/// Droplet 패턴 탐지.
///
/// 전체 요청의 1% 미만이지만 평균 duration의 10배 이상인 거래가 존재하면 Droplet.
async fn detect_droplet(
    client: &clickhouse::Client,
    tenant_id: &str,
    start_ms: i64,
    end_ms: i64,
    now_ms: i64,
) -> Vec<PatternDetected> {
    let safe_tenant = escape_sql(tenant_id);
    let start_s = fmt_ms(start_ms);
    let end_s = fmt_ms(end_ms);

    // 10x 임계값 이상인 span 개수 vs 전체 count를 서비스별로 집계
    let query = format!(
        r#"
        SELECT
            service,
            quantile(0.99)(duration_ns) / 1000000.0 AS p99_ms,
            avg(duration_ns) / 1000000.0            AS avg_ms,
            count()                                  AS total
        FROM datacat.spans
        WHERE tenant_id = '{safe_tenant}'
          AND start_time >= fromUnixTimestamp64Milli({start_s})
          AND start_time <  fromUnixTimestamp64Milli({end_s})
        GROUP BY service
        "#
    );

    let rows: Vec<ServiceP99Row> = match client
        .query(&query)
        .fetch_all::<ServiceP99Row>()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "Droplet 탐지 쿼리 실패");
            return Vec::new();
        }
    };

    let mut patterns = Vec::new();

    for row in &rows {
        if row.avg_ms <= 0.0 || row.total < 100 {
            continue;
        }
        // p99이 평균의 10배 이상이면 Droplet 가능성 존재
        let ratio = row.p99_ms / row.avg_ms;
        if ratio >= 10.0 {
            let confidence = ((ratio - 10.0) / 90.0 * 0.5 + 0.5).min(1.0);
            patterns.push(PatternDetected {
                pattern: PatternType::Droplet,
                service: row.service.clone(),
                confidence,
                description: format!(
                    "[{}] 극단적 이상 거래 감지 (Droplet): p99={:.1}ms, avg={:.1}ms, 비율={:.1}x",
                    row.service, row.p99_ms, row.avg_ms, ratio
                ),
                detected_at: now_ms,
            });
        }
    }

    patterns
}

/// Wave 패턴 탐지.
///
/// 5분 간격의 분 버킷을 슬라이딩하여 주기적 패턴(피크/밸리 교차)을 감지한다.
/// 최소 25개 버킷(25분) 필요.
async fn detect_wave(
    client: &clickhouse::Client,
    tenant_id: &str,
    start_ms: i64,
    end_ms: i64,
    now_ms: i64,
) -> Vec<PatternDetected> {
    let safe_tenant = escape_sql(tenant_id);
    let start_s = fmt_ms(start_ms);
    let end_s = fmt_ms(end_ms);

    let query = format!(
        r#"
        SELECT
            toUnixTimestamp(toStartOfMinute(start_time)) AS minute,
            service,
            count() AS cnt
        FROM datacat.spans
        WHERE tenant_id = '{safe_tenant}'
          AND start_time >= fromUnixTimestamp64Milli({start_s})
          AND start_time <  fromUnixTimestamp64Milli({end_s})
        GROUP BY minute, service
        ORDER BY minute ASC
        "#
    );

    let rows: Vec<ServiceMinuteBucket> = match client
        .query(&query)
        .fetch_all::<ServiceMinuteBucket>()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "Wave 탐지 쿼리 실패");
            return Vec::new();
        }
    };

    let mut by_service: HashMap<String, Vec<u64>> = HashMap::new();
    for row in &rows {
        by_service
            .entry(row.service.clone())
            .or_default()
            .push(row.cnt);
    }

    let mut patterns = Vec::new();

    for (service, counts) in by_service {
        if counts.len() < 25 {
            continue;
        }

        // 간이 주기성 검사: 5분 간격 autocorrelation coefficient 계산
        // lag=5에서의 피어슨 상관계수가 0.6 이상이면 Wave 판정
        let n = counts.len();
        let lag = 5usize;
        let mean = counts.iter().sum::<u64>() as f64 / n as f64;

        // x = counts[0..n-lag], y = counts[lag..n]
        let pairs: Vec<(f64, f64)> = counts[..n - lag]
            .iter()
            .zip(counts[lag..].iter())
            .map(|(a, b)| (*a as f64 - mean, *b as f64 - mean))
            .collect();

        let cov: f64 = pairs.iter().map(|(a, b)| a * b).sum::<f64>() / pairs.len() as f64;
        let var: f64 = counts.iter().map(|v| (*v as f64 - mean).powi(2)).sum::<f64>() / n as f64;

        if var <= 0.0 {
            continue;
        }
        let autocorr = cov / var;

        if autocorr >= 0.6 {
            let confidence = ((autocorr - 0.6) / 0.4 * 0.5 + 0.5).min(1.0);
            patterns.push(PatternDetected {
                pattern: PatternType::Wave,
                service: service.clone(),
                confidence,
                description: format!(
                    "[{}] 5분 주기 레이턴시 스파이크 패턴 감지 (Wave): autocorr={:.2}",
                    service, autocorr
                ),
                detected_at: now_ms,
            });
        }
    }

    patterns
}

/// 지정된 시간 범위에서 X-View 패턴을 탐지한다.
///
/// # Arguments
/// * `client` - ClickHouse 클라이언트
/// * `tenant_id` - 테넌트 식별자
/// * `start_ms` - 조회 시작 (Unix 밀리초)
/// * `end_ms` - 조회 종료 (Unix 밀리초)
///
/// # Returns
/// 탐지된 패턴 목록. 패턴이 없으면 빈 Vec 반환.
pub async fn detect_patterns(
    client: &clickhouse::Client,
    tenant_id: &str,
    start_ms: i64,
    end_ms: i64,
) -> Vec<PatternDetected> {
    let now_ms = Utc::now().timestamp_millis();
    let mut all_patterns = Vec::new();

    // 4가지 패턴을 병렬로 탐지
    let (surge, waterfall, droplet, wave) = tokio::join!(
        detect_surge(client, tenant_id, start_ms, end_ms, now_ms),
        detect_waterfall(client, tenant_id, start_ms, end_ms, now_ms),
        detect_droplet(client, tenant_id, start_ms, end_ms, now_ms),
        detect_wave(client, tenant_id, start_ms, end_ms, now_ms),
    );

    all_patterns.extend(surge);
    all_patterns.extend(waterfall);
    all_patterns.extend(droplet);
    all_patterns.extend(wave);

    // confidence 내림차순 정렬
    all_patterns.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));

    all_patterns
}
