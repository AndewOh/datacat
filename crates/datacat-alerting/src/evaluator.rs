//! Monitor 평가 엔진
//!
//! 백그라운드 tokio 태스크로 실행되어, 활성화된 Monitor를 주기적으로 평가한다.
//!
//! 평가 흐름:
//! 1. 활성화된 Monitor 목록 스냅샷 획득
//! 2. 각 Monitor별 ClickHouse 쿼리 실행
//! 3. Condition과 비교
//! 4. 위반 시 → Incident 생성 + 알림 발송
//! 5. 기존 Incident가 회복되면 → Resolved 상태로 전이

use anyhow::Result;
use chrono::Utc;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{Duration, sleep};
use tracing::{info, warn};
use uuid::Uuid;

use crate::incident::{Incident, IncidentStatus};
use crate::monitor::{Monitor, QueryKind};
use crate::notifier;

// ---------------------------------------------------------------------------
// 평가 루프 진입점
// ---------------------------------------------------------------------------

/// 백그라운드 평가 루프.
///
/// panic 없이 에러는 warn! 으로만 처리하여 서비스 전체에 영향을 주지 않는다.
/// 각 Monitor의 interval_secs를 존중하기 위해 짧은 tick 주기(10초)로 순회한다.
pub async fn run_evaluator(
    ch_client: clickhouse::Client,
    monitors: Arc<RwLock<Vec<Monitor>>>,
    incidents: Arc<RwLock<Vec<Incident>>>,
    http_client: reqwest::Client,
) -> Result<()> {
    info!("평가 엔진 시작");

    // 각 Monitor의 마지막 평가 시각을 추적 (interval 준수)
    let mut last_evaluated: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();

    loop {
        // 10초 간격으로 전체 Monitor를 순회하여 interval이 지난 것만 평가
        sleep(Duration::from_secs(10)).await;

        let now = Utc::now().timestamp();

        // 스냅샷 획득 (읽기 락 최소화)
        let monitor_list: Vec<Monitor> = {
            let lock = monitors.read().await;
            lock.clone()
        };

        for monitor in &monitor_list {
            if !monitor.enabled {
                continue;
            }

            // 마지막 평가 후 interval_secs가 지났는지 확인
            let last = last_evaluated.get(&monitor.id).copied().unwrap_or(0);
            if now - last < monitor.interval_secs as i64 {
                continue;
            }
            last_evaluated.insert(monitor.id.clone(), now);

            // 평가 실행 (에러는 warn으로만 처리, panic 없음)
            match evaluate_monitor(&ch_client, monitor).await {
                Ok(Some(value)) => {
                    // 조건 위반 → Incident 생성 또는 기존 Incident 유지
                    handle_violation(
                        monitor,
                        value,
                        &incidents,
                        &http_client,
                    ).await;
                }
                Ok(None) => {
                    // 조건 정상 → 기존 Incident 해소
                    handle_recovery(monitor, &incidents).await;
                }
                Err(e) => {
                    warn!(
                        monitor_id = %monitor.id,
                        monitor_name = %monitor.name,
                        error = %e,
                        "Monitor 평가 실패 (건너뜀)"
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Monitor 평가
// ---------------------------------------------------------------------------

/// Monitor를 평가하여 조건 위반 시 측정값(Some(f64))을 반환한다.
/// 정상이면 None을 반환한다.
async fn evaluate_monitor(
    ch_client: &clickhouse::Client,
    monitor: &Monitor,
) -> Result<Option<f64>> {
    let value = query_value(ch_client, monitor).await?;

    if monitor.condition.is_violated(value) {
        info!(
            monitor_id = %monitor.id,
            value = value,
            threshold = monitor.condition.threshold,
            "Monitor 조건 위반 감지"
        );
        Ok(Some(value))
    } else {
        Ok(None)
    }
}

/// ClickHouse String literal 내 특수문자를 이스케이프한다.
/// `'`와 `\`를 이스케이프하여 SQL 인젝션을 방지한다.
fn escape_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// ClickHouse에서 Monitor 쿼리 종류에 따라 집계값을 조회한다.
async fn query_value(
    ch_client: &clickhouse::Client,
    monitor: &Monitor,
) -> Result<f64> {
    let window = monitor.query.window_secs;
    let service = escape_string(&monitor.query.expr);
    let tenant_id = escape_string(&monitor.tenant_id);

    let sql = match monitor.query.kind {
        QueryKind::Metric | QueryKind::Trace => {
            build_spans_query(&monitor.query.aggregation, &service, &tenant_id, window)
        }
        QueryKind::Log => {
            build_logs_query(&service, &tenant_id, window)
        }
    };

    // ClickHouse HTTP 인터페이스에서 단일 f64 값을 조회
    let result = ch_client
        .query(&sql)
        .fetch_one::<f64>()
        .await
        .unwrap_or(0.0);

    Ok(result)
}

/// spans 테이블에서 집계값을 조회하는 SQL을 생성한다.
///
/// 지원 aggregation:
/// - "error_rate" → countIf(status_code=2) / count()
/// - "p99"        → quantile(0.99)(duration_ns) / 1e6 (ms 변환)
/// - "avg"        → avg(duration_ns) / 1e6
/// - "count"      → count()
fn build_spans_query(aggregation: &str, service: &str, tenant_id: &str, window_secs: u32) -> String {
    let agg_expr = match aggregation {
        "error_rate" => "countIf(status_code = 2) / greatest(count(), 1)".to_string(),
        "p99"        => "quantile(0.99)(duration_ns) / 1000000.0".to_string(),
        "avg"        => "avg(duration_ns) / 1000000.0".to_string(),
        "count"      => "count()".to_string(),
        other        => {
            warn!(aggregation = %other, "알 수 없는 aggregation — count()로 대체");
            "count()".to_string()
        }
    };

    format!(
        "SELECT toFloat64({agg_expr}) FROM datacat.spans \
         WHERE tenant_id = '{tenant_id}' \
           AND service = '{service}' \
           AND start_time >= now() - INTERVAL {window_secs} SECOND",
    )
}

/// logs 테이블에서 에러 로그 건수를 조회하는 SQL을 생성한다.
fn build_logs_query(service: &str, tenant_id: &str, window_secs: u32) -> String {
    // severity_number 17-20 = ERROR, 21-24 = FATAL (OTel 표준)
    format!(
        "SELECT toFloat64(countIf(severity_number >= 17)) FROM datacat.logs \
         WHERE tenant_id = '{tenant_id}' \
           AND service = '{service}' \
           AND timestamp >= now() - INTERVAL {window_secs} SECOND",
    )
}

// ---------------------------------------------------------------------------
// Incident 관리
// ---------------------------------------------------------------------------

/// Monitor 조건 위반 시 Incident를 생성하거나 기존 것을 유지한다.
/// 알림은 신규 Incident에만 발송한다 (중복 알림 방지).
async fn handle_violation(
    monitor: &Monitor,
    value: f64,
    incidents: &Arc<RwLock<Vec<Incident>>>,
    http_client: &reqwest::Client,
) {
    let now = Utc::now().timestamp();

    // 동일 Monitor의 미해소 Incident가 있는지 확인
    let already_open = {
        let lock = incidents.read().await;
        lock.iter().any(|i| {
            i.monitor_id == monitor.id
                && i.status != IncidentStatus::Resolved
        })
    };

    if already_open {
        // 기존 Incident 유지 — 중복 알림 없음
        return;
    }

    // 신규 Incident 생성
    let incident = Incident {
        id:            Uuid::new_v4().to_string(),
        monitor_id:    monitor.id.clone(),
        tenant_id:     monitor.tenant_id.clone(),
        severity:      monitor.severity.clone(),
        title:         format!(
            "[{}] {} — 현재값 {:.4} (임계값 {} {:.4})",
            monitor.severity.as_str(),
            monitor.name,
            value,
            condition_op_str(&monitor.condition.op),
            monitor.condition.threshold,
        ),
        status:        IncidentStatus::Triggered,
        triggered_at:  now,
        resolved_at:   None,
        trigger_value: value,
    };

    info!(
        incident_id = %incident.id,
        monitor_id  = %monitor.id,
        value       = value,
        "신규 Incident 생성"
    );

    // Incident 저장
    {
        let mut lock = incidents.write().await;
        lock.push(incident.clone());
    }

    // 알림 발송 (실패해도 Incident 생성은 유지)
    for channel in &monitor.channels {
        if let Err(e) = notifier::notify(http_client, channel, &incident).await {
            warn!(
                incident_id = %incident.id,
                error = %e,
                "알림 발송 실패 (인시던트는 유지됨)"
            );
        }
    }
}

/// Monitor 조건이 회복되면 기존 Triggered 상태의 Incident를 Resolved로 전이한다.
async fn handle_recovery(
    monitor: &Monitor,
    incidents: &Arc<RwLock<Vec<Incident>>>,
) {
    let now = Utc::now().timestamp();
    let mut lock = incidents.write().await;

    for incident in lock.iter_mut() {
        if incident.monitor_id == monitor.id
            && incident.status == IncidentStatus::Triggered
        {
            incident.status      = IncidentStatus::Resolved;
            incident.resolved_at = Some(now);

            info!(
                incident_id = %incident.id,
                monitor_id  = %monitor.id,
                "Incident 자동 해소"
            );
        }
    }
}

/// Condition 연산자를 사람이 읽기 쉬운 문자열로 변환
fn condition_op_str(op: &crate::monitor::CompareOp) -> &'static str {
    use crate::monitor::CompareOp;
    match op {
        CompareOp::Gt  => ">",
        CompareOp::Gte => ">=",
        CompareOp::Lt  => "<",
        CompareOp::Lte => "<=",
        CompareOp::Eq  => "==",
    }
}
