//! Log Metric Rules API
//!
//! 로그 스트림을 필터링하여 ClickHouse Materialized View를 통해
//! 메트릭을 자동으로 파생시키는 규칙을 관리한다.
//!
//! 엔드포인트:
//! - POST   /api/v1/log-metric-rules        — 규칙 생성
//! - GET    /api/v1/log-metric-rules        — 규칙 목록 조회
//! - DELETE /api/v1/log-metric-rules/:rule_id — 규칙 삭제

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{error, info};

use crate::AppState;

// ---------------------------------------------------------------------------
// 요청/응답 타입
// ---------------------------------------------------------------------------

/// POST /api/v1/log-metric-rules 요청 본문.
#[derive(Debug, Deserialize)]
pub struct CreateLogMetricRuleRequest {
    pub metric_name: String,
    pub description: Option<String>,
    /// "keyword" | "severity" | "service" | "body_regex"
    pub filter_type: String,
    pub filter_value: String,
    /// None = count, Some = attrs 키로 값 추출
    pub value_field: Option<String>,
    /// "counter" | "gauge"
    pub metric_type: String,
    /// 쉼표 구분 그룹화 키 (e.g. "service,env")
    pub group_by: Option<String>,
    pub tenant_id: Option<String>,
}

/// GET /api/v1/log-metric-rules 쿼리 파라미터.
#[derive(Debug, Deserialize)]
pub struct ListRulesParams {
    pub tenant_id: Option<String>,
}

/// DELETE /api/v1/log-metric-rules/:rule_id 쿼리 파라미터.
#[derive(Debug, Deserialize)]
pub struct DeleteRuleParams {
    pub tenant_id: Option<String>,
}

/// Log Metric Rule 응답 타입.
#[derive(Debug, Serialize, Deserialize)]
pub struct LogMetricRule {
    pub rule_id: String,
    pub metric_name: String,
    pub description: String,
    pub filter_type: String,
    pub filter_value: String,
    pub value_field: String,
    pub metric_type: u8,
    pub group_by: String,
    pub enabled: bool,
    /// Unix 밀리초
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// ClickHouse Row 타입 (목록 조회용)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, clickhouse::Row)]
struct LogMetricRuleRow {
    rule_id: String,
    metric_name: String,
    description: String,
    filter_type: String,
    filter_value: String,
    value_field: String,
    metric_type: u8,
    group_by: String,
    enabled: u8,
    /// toUnixTimestamp64Milli로 변환하여 i64로 수신
    created_at: i64,
}

// ---------------------------------------------------------------------------
// SQL 인젝션 방어 헬퍼
// ---------------------------------------------------------------------------

/// String 파라미터에서 SQL 특수문자를 이스케이프한다.
fn escape_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

// ---------------------------------------------------------------------------
// Rule ID 생성 헬퍼
// ---------------------------------------------------------------------------

/// 16자 hex rule ID를 생성한다 (타임스탬프 + FNV 해시).
fn new_rule_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let hash = {
        let mut h: u64 = 0xcbf29ce484222325;
        for byte in ts.to_le_bytes() {
            h ^= byte as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        h
    };
    format!("lmr_{:016x}", hash)
}

// ---------------------------------------------------------------------------
// filter_type → ClickHouse 필터 표현식 변환
// ---------------------------------------------------------------------------

/// filter_type + filter_value → ClickHouse WHERE 조건 문자열.
///
/// SQL 인젝션 방어: filter_value에 escape_string 적용.
fn build_filter_expr(filter_type: &str, filter_value: &str) -> Result<String, String> {
    let v = escape_string(filter_value);
    let expr = match filter_type {
        "keyword" => format!("hasToken(body, '{}')", v),
        "severity" => format!("severity_text = '{}'", v),
        "service" => format!("service = '{}'", v),
        "body_regex" => format!("match(body, '{}')", v),
        unknown => {
            return Err(format!("지원하지 않는 filter_type: {}", unknown));
        }
    };
    Ok(expr)
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

/// POST /api/v1/log-metric-rules
///
/// 새 로그 메트릭 규칙을 생성하고 Materialized View를 등록한다.
pub async fn create_log_metric_rule_handler(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateLogMetricRuleRequest>,
) -> impl IntoResponse {
    let tenant_id = req.tenant_id.as_deref().unwrap_or("default");
    let rule_id = new_rule_id();

    info!(
        tenant_id = %tenant_id,
        rule_id = %rule_id,
        metric_name = %req.metric_name,
        filter_type = %req.filter_type,
        "log metric rule 생성 시작"
    );

    // filter 표현식 생성
    let filter_expr = match build_filter_expr(&req.filter_type, &req.filter_value) {
        Ok(expr) => expr,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({ "error": e })),
            )
                .into_response();
        }
    };

    let metric_type_u8: u8 = if req.metric_type == "gauge" { 0 } else { 1 };
    let description = req.description.as_deref().unwrap_or("").to_string();
    let value_field = req.value_field.as_deref().unwrap_or("").to_string();
    let group_by_str = req.group_by.as_deref().unwrap_or("").to_string();

    // ClickHouse 이스케이프
    let tenant_esc = escape_string(tenant_id);
    let metric_name_esc = escape_string(&req.metric_name);
    let description_esc = escape_string(&description);
    let filter_type_esc = escape_string(&req.filter_type);
    let filter_value_esc = escape_string(&req.filter_value);
    let value_field_esc = escape_string(&value_field);
    let group_by_esc = escape_string(&group_by_str);
    let rule_id_esc = escape_string(&rule_id);

    // 1. log_metric_rules 테이블에 규칙 삽입
    let insert_sql = format!(
        r#"INSERT INTO datacat.log_metric_rules
           (tenant_id, rule_id, metric_name, description, filter_type, filter_value, value_field, metric_type, group_by, enabled, created_at)
           VALUES ('{tenant}', '{rule_id}', '{metric_name}', '{description}', '{filter_type}', '{filter_value}', '{value_field}', {metric_type}, '{group_by}', 1, now64(3))"#,
        tenant = tenant_esc,
        rule_id = rule_id_esc,
        metric_name = metric_name_esc,
        description = description_esc,
        filter_type = filter_type_esc,
        filter_value = filter_value_esc,
        value_field = value_field_esc,
        metric_type = metric_type_u8,
        group_by = group_by_esc,
    );

    if let Err(e) = state.ch_client.query(&insert_sql).execute().await {
        error!(error = %e, rule_id = %rule_id, "log_metric_rules 삽입 실패");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({ "error": format!("규칙 저장 실패: {}", e) })),
        )
            .into_response();
    }

    // 2. Materialized View 생성
    let view_name = format!("datacat.lm_{}", rule_id_esc);
    let mv_sql = if value_field.is_empty() {
        // count 기반
        // logs.timestamp 는 나노초(Int64), metrics.timestamp 는 밀리초(Int64)이므로 변환 필요
        format!(
            r#"CREATE MATERIALIZED VIEW IF NOT EXISTS {view_name}
TO datacat.metrics AS
SELECT
    tenant_id,
    intDiv(timestamp, 1000000) AS timestamp,
    '{metric_name}' AS name,
    1 AS type,
    1.0 AS value,
    service,
    env,
    [] AS attrs_keys,
    [] AS attrs_values
FROM datacat.logs
WHERE tenant_id = '{tenant}'
  AND {filter_expr}"#,
            view_name = view_name,
            metric_name = metric_name_esc,
            tenant = tenant_esc,
            filter_expr = filter_expr,
        )
    } else {
        // 값 추출 기반
        let vf_esc = escape_string(&value_field);
        format!(
            r#"CREATE MATERIALIZED VIEW IF NOT EXISTS {view_name}
TO datacat.metrics AS
SELECT
    tenant_id,
    intDiv(timestamp, 1000000) AS timestamp,
    '{metric_name}' AS name,
    0 AS type,
    toFloat64OrDefault(attrs_values[indexOf(attrs_keys, '{value_field}')], 0.0) AS value,
    service,
    env,
    attrs_keys,
    attrs_values
FROM datacat.logs
WHERE tenant_id = '{tenant}'
  AND {filter_expr}
  AND has(attrs_keys, '{value_field}')"#,
            view_name = view_name,
            metric_name = metric_name_esc,
            tenant = tenant_esc,
            filter_expr = filter_expr,
            value_field = vf_esc,
        )
    };

    if let Err(e) = state.ch_client.query(&mv_sql).execute().await {
        error!(error = %e, rule_id = %rule_id, "Materialized View 생성 실패");
        // 규칙 삽입은 성공했으나 MV 생성 실패 — 정리 불필요 (멱등 CREATE IF NOT EXISTS 재시도 가능)
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({ "error": format!("Materialized View 생성 실패: {}", e) })),
        )
            .into_response();
    }

    info!(rule_id = %rule_id, view = %view_name, "log metric rule 생성 완료");

    // 생성된 규칙 반환
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    let rule = LogMetricRule {
        rule_id,
        metric_name: req.metric_name,
        description,
        filter_type: req.filter_type,
        filter_value: req.filter_value,
        value_field,
        metric_type: metric_type_u8,
        group_by: group_by_str,
        enabled: true,
        created_at: now_ms,
    };

    (StatusCode::CREATED, axum::Json(rule)).into_response()
}

/// GET /api/v1/log-metric-rules
///
/// 테넌트의 모든 로그 메트릭 규칙 목록을 반환한다.
pub async fn list_log_metric_rules_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ListRulesParams>,
) -> impl IntoResponse {
    let tenant_id = params.tenant_id.as_deref().unwrap_or("default");
    let tenant_esc = escape_string(tenant_id);

    let sql = format!(
        r#"SELECT
            rule_id,
            metric_name,
            description,
            filter_type,
            filter_value,
            value_field,
            metric_type,
            group_by,
            enabled,
            toUnixTimestamp64Milli(created_at) AS created_at
        FROM datacat.log_metric_rules
        WHERE tenant_id = '{tenant}'
        ORDER BY created_at DESC
        LIMIT 1000"#,
        tenant = tenant_esc,
    );

    match state
        .ch_client
        .query(&sql)
        .fetch_all::<LogMetricRuleRow>()
        .await
    {
        Ok(rows) => {
            let rules: Vec<LogMetricRule> = rows
                .into_iter()
                .map(|r| LogMetricRule {
                    rule_id: r.rule_id,
                    metric_name: r.metric_name,
                    description: r.description,
                    filter_type: r.filter_type,
                    filter_value: r.filter_value,
                    value_field: r.value_field,
                    metric_type: r.metric_type,
                    group_by: r.group_by,
                    enabled: r.enabled != 0,
                    created_at: r.created_at,
                })
                .collect();
            (StatusCode::OK, axum::Json(rules)).into_response()
        }
        Err(e) => {
            error!(error = %e, "log_metric_rules 목록 조회 실패");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "internal server error" })),
            )
                .into_response()
        }
    }
}

/// DELETE /api/v1/log-metric-rules/:rule_id
///
/// 규칙과 연결된 Materialized View를 삭제한다.
pub async fn delete_log_metric_rule_handler(
    State(state): State<Arc<AppState>>,
    Path(rule_id): Path<String>,
    Query(params): Query<DeleteRuleParams>,
) -> impl IntoResponse {
    let tenant_id = params.tenant_id.as_deref().unwrap_or("default");
    let rule_id_esc = escape_string(&rule_id);
    let tenant_esc = escape_string(tenant_id);

    info!(rule_id = %rule_id, tenant_id = %tenant_id, "log metric rule 삭제 시작");

    // 1. 규칙 존재 여부 확인
    let check_sql = format!(
        "SELECT count() AS cnt FROM datacat.log_metric_rules WHERE rule_id = '{rule_id}' AND tenant_id = '{tenant}'",
        rule_id = rule_id_esc,
        tenant = tenant_esc,
    );

    #[derive(clickhouse::Row, Deserialize)]
    struct CountRow {
        cnt: u64,
    }

    match state.ch_client.query(&check_sql).fetch_one::<CountRow>().await {
        Ok(row) if row.cnt == 0 => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(serde_json::json!({ "error": "rule not found" })),
            )
                .into_response();
        }
        Err(e) => {
            error!(error = %e, rule_id = %rule_id, "규칙 조회 실패");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "internal server error" })),
            )
                .into_response();
        }
        _ => {}
    }

    // 2. Materialized View 삭제
    let drop_view_sql = format!(
        "DROP VIEW IF EXISTS datacat.lm_{rule_id}",
        rule_id = rule_id_esc,
    );

    if let Err(e) = state.ch_client.query(&drop_view_sql).execute().await {
        error!(error = %e, rule_id = %rule_id, "Materialized View 삭제 실패");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({ "error": format!("View 삭제 실패: {}", e) })),
        )
            .into_response();
    }

    // 3. 규칙 레코드 삭제
    let delete_sql = format!(
        "ALTER TABLE datacat.log_metric_rules DELETE WHERE rule_id = '{rule_id}' AND tenant_id = '{tenant}'",
        rule_id = rule_id_esc,
        tenant = tenant_esc,
    );

    if let Err(e) = state.ch_client.query(&delete_sql).execute().await {
        error!(error = %e, rule_id = %rule_id, "log_metric_rules 삭제 실패");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({ "error": format!("규칙 삭제 실패: {}", e) })),
        )
            .into_response();
    }

    info!(rule_id = %rule_id, "log metric rule 삭제 완료");
    StatusCode::NO_CONTENT.into_response()
}

// ---------------------------------------------------------------------------
// 단위 테스트
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- escape_string ---

    #[test]
    fn escape_string_backslash_only() {
        assert_eq!(escape_string("a\\b"), "a\\\\b");
    }

    #[test]
    fn escape_string_single_quote_only() {
        assert_eq!(escape_string("a'b"), "a\\'b");
    }

    #[test]
    fn escape_string_combined_backslash_and_quote() {
        // Input: a\'b  (backslash then quote)
        // Expected: a\\\\'b  — backslash escaped first → a\\\'b, then quote escaped → a\\\'b
        // Rust string literal: backslash → "\\\\", quote → "\\'"
        assert_eq!(escape_string("a\\'b"), "a\\\\\\'b");
    }

    #[test]
    fn escape_string_empty() {
        assert_eq!(escape_string(""), "");
    }

    #[test]
    fn escape_string_no_special_chars() {
        assert_eq!(escape_string("hello_world"), "hello_world");
    }

    // --- build_filter_expr ---

    #[test]
    fn build_filter_expr_keyword() {
        let result = build_filter_expr("keyword", "error").unwrap();
        assert_eq!(result, "hasToken(body, 'error')");
    }

    #[test]
    fn build_filter_expr_severity() {
        let result = build_filter_expr("severity", "ERROR").unwrap();
        assert_eq!(result, "severity_text = 'ERROR'");
    }

    #[test]
    fn build_filter_expr_service() {
        let result = build_filter_expr("service", "api-gateway").unwrap();
        assert_eq!(result, "service = 'api-gateway'");
    }

    #[test]
    fn build_filter_expr_body_regex() {
        let result = build_filter_expr("body_regex", "^ERR.*").unwrap();
        assert_eq!(result, "match(body, '^ERR.*')");
    }

    #[test]
    fn build_filter_expr_unknown_type_returns_err() {
        let result = build_filter_expr("unsupported_type", "value");
        assert!(result.is_err());
        let msg = result.unwrap_err();
        assert!(
            msg.contains("unsupported_type"),
            "error message should include the unknown type name; got: {msg}"
        );
    }

    #[test]
    fn build_filter_expr_escapes_value_inside_expression() {
        // filter_value with a single quote must be escaped inside the generated SQL
        let result = build_filter_expr("keyword", "O'Brien").unwrap();
        assert_eq!(result, "hasToken(body, 'O\\'Brien')");
    }
}
