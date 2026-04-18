//! AI Ops 챗봇 모듈
//!
//! OLLAMA_URL 환경변수가 설정된 경우 Ollama의 /api/generate로 프록시하여
//! LLM 기반 응답을 반환한다.
//!
//! Ollama를 사용할 수 없는 경우(env 미설정 또는 연결 실패)에는
//! 규칙 기반 인사이트 엔진으로 fallback한다:
//! 1. 메시지 키워드로 intent 파악 (slow, error, spike, service)
//! 2. ClickHouse에서 관련 메트릭 조회
//! 3. 구조화된 응답 반환

use clickhouse::Row;
use serde::{Deserialize, Serialize};
use tracing::{error, info};

// ---------------------------------------------------------------------------
// 요청 / 응답 타입
// ---------------------------------------------------------------------------

/// 챗봇 요청.
#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    /// 사용자 메시지
    pub message: String,
    /// 테넌트 ID (미설정 시 "default")
    pub tenant_id: Option<String>,
    /// 컨텍스트 힌트 (서비스 이름, 시간 범위 등)
    pub context: Option<ChatContext>,
}

/// 챗봇 컨텍스트 힌트.
#[derive(Debug, Deserialize)]
pub struct ChatContext {
    /// 대상 서비스 이름
    pub service: Option<String>,
    /// 조회 시작 (Unix 밀리초)
    pub start: Option<i64>,
    /// 조회 종료 (Unix 밀리초)
    pub end: Option<i64>,
}

/// 챗봇 응답.
#[derive(Debug, Serialize)]
pub struct ChatResponse {
    /// 자연어 응답 텍스트
    pub reply: String,
    /// 발견된 이슈 목록
    pub findings: Vec<Finding>,
    /// 권장 조치 사항
    pub suggested_actions: Vec<String>,
}

/// 개별 발견 이슈.
#[derive(Debug, Serialize)]
pub struct Finding {
    /// 심각도: "info", "warning", "critical"
    pub severity: String,
    /// 메시지
    pub message: String,
    /// 관련 서비스
    pub service: Option<String>,
    /// 관련 메트릭
    pub metric: Option<String>,
    /// 메트릭 값
    pub value: Option<f64>,
}

// ---------------------------------------------------------------------------
// 내부 헬퍼
// ---------------------------------------------------------------------------

/// SQL 인젝션 방지용 이스케이프.
fn escape_sql(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// 메시지 키워드로 intent를 파악한다.
///
/// 반환값: ("slow" | "error" | "spike" | "service" | "general", 대상 서비스 힌트)
fn parse_intent(message: &str, ctx_service: Option<&str>) -> (String, Option<String>) {
    let lower = message.to_lowercase();

    let intent = if lower.contains("slow") || lower.contains("느리") || lower.contains("latenc") || lower.contains("레이턴시") {
        "slow"
    } else if lower.contains("error") || lower.contains("에러") || lower.contains("fail") || lower.contains("실패") || lower.contains("5xx") {
        "error"
    } else if lower.contains("spike") || lower.contains("급증") || lower.contains("traffic") || lower.contains("트래픽") {
        "spike"
    } else if lower.contains("service") || lower.contains("서비스") {
        "service"
    } else {
        "general"
    };

    // 메시지에서 서비스 힌트 추출 시도 (ctx_service 우선)
    let service_hint = ctx_service.map(|s| s.to_string());

    (intent.to_string(), service_hint)
}

// ---------------------------------------------------------------------------
// ClickHouse Row 타입 (규칙 기반 엔진용)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Row)]
struct ServiceErrorRow {
    pub service: String,
    pub error_rate: f64,
    pub total: u64,
}

#[derive(Debug, Deserialize, Row)]
struct ServiceLatencyRow {
    pub service: String,
    pub p99_ms: f64,
    pub avg_ms: f64,
}

#[derive(Debug, Deserialize, Row)]
struct ServiceCountRow {
    pub service: String,
    pub cnt: u64,
}

// ---------------------------------------------------------------------------
// 규칙 기반 엔진
// ---------------------------------------------------------------------------

/// 규칙 기반 챗봇 응답 생성.
///
/// intent에 따라 ClickHouse를 조회하고 인사이트를 구성한다.
async fn rule_based_response(
    client: &clickhouse::Client,
    request: &ChatRequest,
    intent: &str,
    service_hint: Option<&str>,
) -> ChatResponse {
    let tenant_id = request
        .tenant_id
        .as_deref()
        .unwrap_or("default");
    let safe_tenant = escape_sql(tenant_id);

    // 기본 시간 범위: 최근 30분
    let (start_ms, end_ms) = if let Some(ctx) = &request.context {
        let now_ms = chrono::Utc::now().timestamp_millis();
        (
            ctx.start.unwrap_or(now_ms - 1_800_000),
            ctx.end.unwrap_or(now_ms),
        )
    } else {
        let now_ms = chrono::Utc::now().timestamp_millis();
        (now_ms - 1_800_000, now_ms)
    };

    match intent {
        "error" => build_error_response(client, &safe_tenant, service_hint, start_ms, end_ms).await,
        "slow" => build_latency_response(client, &safe_tenant, service_hint, start_ms, end_ms).await,
        "spike" => build_spike_response(client, &safe_tenant, start_ms, end_ms).await,
        "service" => build_service_overview(client, &safe_tenant, service_hint, start_ms, end_ms).await,
        _ => build_general_response(client, &safe_tenant, start_ms, end_ms).await,
    }
}

async fn build_error_response(
    client: &clickhouse::Client,
    safe_tenant: &str,
    service_hint: Option<&str>,
    start_ms: i64,
    end_ms: i64,
) -> ChatResponse {
    let service_filter = if let Some(svc) = service_hint {
        format!("AND service = '{}'", escape_sql(svc))
    } else {
        String::new()
    };

    let query = format!(
        r#"
        SELECT
            service,
            countIf(status_code = 2) / count() AS error_rate,
            count() AS total
        FROM datacat.spans
        WHERE tenant_id = '{safe_tenant}'
          AND start_time >= fromUnixTimestamp64Milli({start_ms})
          AND start_time <  fromUnixTimestamp64Milli({end_ms})
          {service_filter}
        GROUP BY service
        ORDER BY error_rate DESC
        LIMIT 5
        "#
    );

    let rows: Vec<ServiceErrorRow> = match client.query(&query).fetch_all().await {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "에러율 조회 실패");
            return ChatResponse {
                reply: "에러율 데이터를 조회할 수 없습니다. ClickHouse 연결을 확인해주세요.".to_string(),
                findings: Vec::new(),
                suggested_actions: vec!["ClickHouse 연결 상태를 확인하세요.".to_string()],
            };
        }
    };

    let mut findings = Vec::new();
    let mut reply_parts = Vec::new();

    for row in &rows {
        let severity = if row.error_rate > 0.1 {
            "critical"
        } else if row.error_rate > 0.01 {
            "warning"
        } else {
            "info"
        };

        if row.error_rate > 0.0 {
            reply_parts.push(format!(
                "[{}] 에러율 {:.1}% ({}건 중 에러)",
                row.service,
                row.error_rate * 100.0,
                row.total
            ));
            findings.push(Finding {
                severity: severity.to_string(),
                message: format!(
                    "[{}] 서비스 에러율 {:.2}%",
                    row.service,
                    row.error_rate * 100.0
                ),
                service: Some(row.service.clone()),
                metric: Some("error_rate".to_string()),
                value: Some(row.error_rate),
            });
        }
    }

    let reply = if reply_parts.is_empty() {
        "분석 기간 내 에러가 감지되지 않았습니다. 서비스가 정상적으로 동작 중입니다.".to_string()
    } else {
        format!("에러율 분석 결과:\n{}", reply_parts.join("\n"))
    };

    let suggested_actions = if findings.iter().any(|f| f.severity == "critical") {
        vec![
            "즉시 에러 로그를 확인하고 원인을 파악하세요.".to_string(),
            "트래픽을 헬시 인스턴스로 우회하는 것을 고려하세요.".to_string(),
            "의존 서비스(DB, 외부 API)의 상태를 확인하세요.".to_string(),
        ]
    } else if findings.iter().any(|f| f.severity == "warning") {
        vec![
            "에러 로그를 모니터링하고 패턴을 파악하세요.".to_string(),
            "알림 임계값이 적절한지 검토하세요.".to_string(),
        ]
    } else {
        vec!["현재 서비스는 정상 범위 내에서 운영 중입니다.".to_string()]
    };

    ChatResponse { reply, findings, suggested_actions }
}

async fn build_latency_response(
    client: &clickhouse::Client,
    safe_tenant: &str,
    service_hint: Option<&str>,
    start_ms: i64,
    end_ms: i64,
) -> ChatResponse {
    let service_filter = if let Some(svc) = service_hint {
        format!("AND service = '{}'", escape_sql(svc))
    } else {
        String::new()
    };

    let query = format!(
        r#"
        SELECT
            service,
            quantile(0.99)(duration_ns) / 1000000.0 AS p99_ms,
            avg(duration_ns) / 1000000.0            AS avg_ms
        FROM datacat.spans
        WHERE tenant_id = '{safe_tenant}'
          AND start_time >= fromUnixTimestamp64Milli({start_ms})
          AND start_time <  fromUnixTimestamp64Milli({end_ms})
          {service_filter}
        GROUP BY service
        ORDER BY p99_ms DESC
        LIMIT 5
        "#
    );

    let rows: Vec<ServiceLatencyRow> = match client.query(&query).fetch_all().await {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "레이턴시 조회 실패");
            return ChatResponse {
                reply: "레이턴시 데이터를 조회할 수 없습니다.".to_string(),
                findings: Vec::new(),
                suggested_actions: Vec::new(),
            };
        }
    };

    let mut findings = Vec::new();
    let mut reply_parts = Vec::new();

    for row in &rows {
        let severity = if row.p99_ms > 5000.0 {
            "critical"
        } else if row.p99_ms > 1000.0 {
            "warning"
        } else {
            "info"
        };

        reply_parts.push(format!(
            "[{}] p99={:.1}ms, avg={:.1}ms",
            row.service, row.p99_ms, row.avg_ms
        ));
        findings.push(Finding {
            severity: severity.to_string(),
            message: format!("[{}] p99 레이턴시 {:.1}ms", row.service, row.p99_ms),
            service: Some(row.service.clone()),
            metric: Some("p99_latency_ms".to_string()),
            value: Some(row.p99_ms),
        });
    }

    let reply = if reply_parts.is_empty() {
        "분석 기간 내 레이턴시 데이터가 없습니다.".to_string()
    } else {
        format!("레이턴시 분석 결과 (p99 기준 상위 5개 서비스):\n{}", reply_parts.join("\n"))
    };

    let suggested_actions = if findings.iter().any(|f| f.severity == "critical") {
        vec![
            "p99 레이턴시가 임계치를 초과했습니다. 즉시 프로파일링을 실행하세요.".to_string(),
            "DB 슬로우 쿼리 로그를 확인하세요.".to_string(),
            "GC 일시 정지 여부를 확인하세요.".to_string(),
        ]
    } else if findings.iter().any(|f| f.severity == "warning") {
        vec![
            "레이턴시가 증가 추세입니다. 프로파일링으로 병목을 찾아보세요.".to_string(),
            "캐시 히트율을 확인하세요.".to_string(),
        ]
    } else {
        vec!["레이턴시는 정상 범위입니다.".to_string()]
    };

    ChatResponse { reply, findings, suggested_actions }
}

async fn build_spike_response(
    client: &clickhouse::Client,
    safe_tenant: &str,
    start_ms: i64,
    end_ms: i64,
) -> ChatResponse {
    let query = format!(
        r#"
        SELECT
            service,
            count() AS cnt
        FROM datacat.spans
        WHERE tenant_id = '{safe_tenant}'
          AND start_time >= fromUnixTimestamp64Milli({start_ms})
          AND start_time <  fromUnixTimestamp64Milli({end_ms})
        GROUP BY service
        ORDER BY cnt DESC
        LIMIT 10
        "#
    );

    let rows: Vec<ServiceCountRow> = match client.query(&query).fetch_all().await {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "트래픽 스파이크 조회 실패");
            return ChatResponse {
                reply: "트래픽 데이터를 조회할 수 없습니다.".to_string(),
                findings: Vec::new(),
                suggested_actions: Vec::new(),
            };
        }
    };

    let mut findings = Vec::new();
    let mut reply_parts = Vec::new();

    for row in &rows {
        reply_parts.push(format!("[{}] {}건", row.service, row.cnt));
        findings.push(Finding {
            severity: "info".to_string(),
            message: format!("[{}] 분석 기간 총 요청 {}건", row.service, row.cnt),
            service: Some(row.service.clone()),
            metric: Some("request_count".to_string()),
            value: Some(row.cnt as f64),
        });
    }

    let reply = if reply_parts.is_empty() {
        "분석 기간 내 트래픽 데이터가 없습니다.".to_string()
    } else {
        format!("트래픽 분석 결과 (서비스별 요청 수):\n{}", reply_parts.join("\n"))
    };

    ChatResponse {
        reply,
        findings,
        suggested_actions: vec![
            "패턴 탐지 엔드포인트(/api/v1/insights/patterns)에서 Surge 패턴을 확인하세요.".to_string(),
            "오토스케일링 설정을 검토하세요.".to_string(),
        ],
    }
}

async fn build_service_overview(
    client: &clickhouse::Client,
    safe_tenant: &str,
    service_hint: Option<&str>,
    start_ms: i64,
    end_ms: i64,
) -> ChatResponse {
    let service_filter = if let Some(svc) = service_hint {
        format!("AND service = '{}'", escape_sql(svc))
    } else {
        String::new()
    };

    let query = format!(
        r#"
        SELECT
            service,
            countIf(status_code = 2) / count() AS error_rate,
            count() AS total
        FROM datacat.spans
        WHERE tenant_id = '{safe_tenant}'
          AND start_time >= fromUnixTimestamp64Milli({start_ms})
          AND start_time <  fromUnixTimestamp64Milli({end_ms})
          {service_filter}
        GROUP BY service
        ORDER BY total DESC
        LIMIT 10
        "#
    );

    let rows: Vec<ServiceErrorRow> = match client.query(&query).fetch_all().await {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "서비스 목록 조회 실패");
            return ChatResponse {
                reply: "서비스 데이터를 조회할 수 없습니다.".to_string(),
                findings: Vec::new(),
                suggested_actions: Vec::new(),
            };
        }
    };

    let mut findings = Vec::new();
    let mut reply_parts = Vec::new();

    for row in &rows {
        reply_parts.push(format!(
            "[{}] 요청{}건, 에러율{:.1}%",
            row.service, row.total, row.error_rate * 100.0
        ));
        let severity = if row.error_rate > 0.05 { "warning" } else { "info" };
        findings.push(Finding {
            severity: severity.to_string(),
            message: format!("[{}] 총 {}건, 에러율 {:.2}%", row.service, row.total, row.error_rate * 100.0),
            service: Some(row.service.clone()),
            metric: Some("error_rate".to_string()),
            value: Some(row.error_rate),
        });
    }

    let reply = if reply_parts.is_empty() {
        "분석 기간 내 서비스 데이터가 없습니다.".to_string()
    } else {
        format!("서비스 현황:\n{}", reply_parts.join("\n"))
    };

    ChatResponse {
        reply,
        findings,
        suggested_actions: vec!["에러율이 높은 서비스의 로그를 확인하세요.".to_string()],
    }
}

async fn build_general_response(
    client: &clickhouse::Client,
    safe_tenant: &str,
    start_ms: i64,
    end_ms: i64,
) -> ChatResponse {
    // 전체 서비스 요약
    let query = format!(
        r#"
        SELECT
            service,
            countIf(status_code = 2) / count() AS error_rate,
            count() AS total
        FROM datacat.spans
        WHERE tenant_id = '{safe_tenant}'
          AND start_time >= fromUnixTimestamp64Milli({start_ms})
          AND start_time <  fromUnixTimestamp64Milli({end_ms})
        GROUP BY service
        ORDER BY total DESC
        LIMIT 5
        "#
    );

    let rows: Vec<ServiceErrorRow> = match client.query(&query).fetch_all().await {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, "일반 조회 실패");
            return ChatResponse {
                reply: "현재 시스템 상태를 조회할 수 없습니다.".to_string(),
                findings: Vec::new(),
                suggested_actions: Vec::new(),
            };
        }
    };

    let total_requests: u64 = rows.iter().map(|r| r.total).sum();
    let has_errors = rows.iter().any(|r| r.error_rate > 0.01);

    let reply = if rows.is_empty() {
        "분석 기간 내 데이터가 없습니다. 에이전트가 데이터를 수집 중인지 확인하세요.".to_string()
    } else if has_errors {
        format!(
            "현재 시스템 현황: 총 {}건 요청 처리 중. 일부 서비스에서 에러가 감지됩니다.\n\n다음 질문을 시도해보세요:\n- \"에러가 많은 서비스는?\"\n- \"가장 느린 서비스는?\"\n- \"트래픽 급증이 있었나?\"",
            total_requests
        )
    } else {
        format!(
            "현재 시스템은 정상적으로 운영 중입니다. 총 {}건의 요청을 처리했으며 에러가 감지되지 않았습니다.",
            total_requests
        )
    };

    let findings: Vec<Finding> = rows
        .iter()
        .filter(|r| r.error_rate > 0.01)
        .map(|r| Finding {
            severity: "warning".to_string(),
            message: format!("[{}] 에러율 {:.2}%", r.service, r.error_rate * 100.0),
            service: Some(r.service.clone()),
            metric: Some("error_rate".to_string()),
            value: Some(r.error_rate),
        })
        .collect();

    ChatResponse {
        reply,
        findings,
        suggested_actions: vec![
            "이상 탐지: POST /api/v1/insights/analyze".to_string(),
            "패턴 탐지: GET /api/v1/insights/patterns".to_string(),
        ],
    }
}

// ---------------------------------------------------------------------------
// Ollama 프록시
// ---------------------------------------------------------------------------

/// Ollama /api/generate 요청 형식.
#[derive(Serialize)]
struct OllamaRequest {
    model: String,
    prompt: String,
    stream: bool,
}

/// Ollama /api/generate 응답 형식 (stream=false).
#[derive(Deserialize)]
struct OllamaResponse {
    response: String,
}

/// Ollama로 요청을 프록시하고 ChatResponse를 반환한다.
///
/// 실패 시 None을 반환하고 호출자가 rule-based fallback을 사용한다.
async fn try_ollama(
    http_client: &reqwest::Client,
    ollama_url: &str,
    request: &ChatRequest,
) -> Option<ChatResponse> {
    let context_desc = request
        .context
        .as_ref()
        .and_then(|c| c.service.as_ref())
        .map(|s| format!(" (서비스: {})", s))
        .unwrap_or_default();

    let prompt = format!(
        "당신은 관측가능성(Observability) 플랫폼 datacat의 AI Ops 어시스턴트입니다.\
        사용자 질문: {}{}\
        \n간결하고 실용적인 운영 인사이트를 한국어로 답변하세요.",
        request.message, context_desc
    );

    let ollama_req = OllamaRequest {
        model: "llama3".to_string(),
        prompt,
        stream: false,
    };

    let url = format!("{}/api/generate", ollama_url.trim_end_matches('/'));

    match http_client
        .post(&url)
        .json(&ollama_req)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<OllamaResponse>().await {
                Ok(ollama_resp) => {
                    info!("Ollama 응답 수신 성공");
                    Some(ChatResponse {
                        reply: ollama_resp.response,
                        findings: Vec::new(),
                        suggested_actions: Vec::new(),
                    })
                }
                Err(e) => {
                    error!(error = %e, "Ollama 응답 역직렬화 실패");
                    None
                }
            }
        }
        Ok(resp) => {
            error!(status = %resp.status(), "Ollama 비정상 응답");
            None
        }
        Err(e) => {
            error!(error = %e, "Ollama 연결 실패, 규칙 기반 엔진으로 fallback");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// 공개 진입점
// ---------------------------------------------------------------------------

/// 챗봇 요청을 처리한다.
///
/// Ollama가 설정되어 있으면 LLM으로 프록시하고,
/// 그렇지 않으면 규칙 기반 엔진을 사용한다.
pub async fn handle_chat(
    client: &clickhouse::Client,
    http_client: &reqwest::Client,
    ollama_url: Option<&str>,
    request: ChatRequest,
) -> ChatResponse {
    // Ollama 시도
    if let Some(url) = ollama_url {
        if let Some(response) = try_ollama(http_client, url, &request).await {
            return response;
        }
    }

    // 규칙 기반 fallback
    let ctx_service = request
        .context
        .as_ref()
        .and_then(|c| c.service.as_deref());
    let (intent, service_hint) = parse_intent(&request.message, ctx_service);
    rule_based_response(client, &request, &intent, service_hint.as_deref()).await
}
