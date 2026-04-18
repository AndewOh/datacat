//! REST API 핸들러
//!
//! 라우트 목록:
//! - POST   /api/v1/monitors          — Monitor 생성
//! - GET    /api/v1/monitors          — 목록 (tenant_id 필터)
//! - GET    /api/v1/monitors/:id      — 상세
//! - PUT    /api/v1/monitors/:id      — 수정
//! - DELETE /api/v1/monitors/:id      — 삭제
//! - GET    /api/v1/incidents         — Incident 목록 (tenant_id 필터)
//! - POST   /api/v1/incidents/:id/acknowledge — 인지
//! - POST   /api/v1/incidents/:id/resolve     — 해소

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::incident::{Incident, IncidentStatus};
use crate::monitor::{CreateMonitorRequest, Monitor, UpdateMonitorRequest};

// ---------------------------------------------------------------------------
// 공유 상태
// ---------------------------------------------------------------------------

/// Alerting 서비스 공유 상태.
#[derive(Clone)]
pub struct AlertingState {
    pub monitors: Arc<RwLock<Vec<Monitor>>>,
    pub incidents: Arc<RwLock<Vec<Incident>>>,
    /// 알림 발송용 HTTP 클라이언트 (Phase 7에서 직접 사용 예정)
    #[allow(dead_code)]
    pub http_client: reqwest::Client,
}

// ---------------------------------------------------------------------------
// 응답 헬퍼
// ---------------------------------------------------------------------------

/// 표준 API 에러 응답.
#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: String,
}

fn error_response(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(ErrorResponse { error: msg.into() })).into_response()
}

// ---------------------------------------------------------------------------
// Monitor 핸들러
// ---------------------------------------------------------------------------

/// POST /api/v1/monitors — Monitor 생성
pub async fn create_monitor(
    State(state): State<Arc<AlertingState>>,
    Json(req): Json<CreateMonitorRequest>,
) -> Response {
    let now = Utc::now().timestamp();

    let monitor = Monitor {
        id:           Uuid::new_v4().to_string(),
        name:         req.name,
        tenant_id:    req.tenant_id,
        query:        req.query,
        condition:    req.condition,
        severity:     req.severity,
        channels:     req.channels,
        enabled:      req.enabled,
        interval_secs: req.interval_secs,
        created_at:   now,
        updated_at:   now,
    };

    let id = monitor.id.clone();
    {
        let mut lock = state.monitors.write().await;
        lock.push(monitor.clone());
    }

    tracing::info!(monitor_id = %id, "Monitor 생성");
    (StatusCode::CREATED, Json(monitor)).into_response()
}

/// GET /api/v1/monitors — Monitor 목록 조회 (tenant_id 필터)
pub async fn list_monitors(
    State(state): State<Arc<AlertingState>>,
    Query(params): Query<TenantFilter>,
) -> Response {
    let lock = state.monitors.read().await;

    let list: Vec<&Monitor> = match &params.tenant_id {
        Some(tid) => lock.iter().filter(|m| &m.tenant_id == tid).collect(),
        None      => lock.iter().collect(),
    };

    Json(serde_json::json!({ "monitors": list, "total": list.len() })).into_response()
}

/// GET /api/v1/monitors/:id — Monitor 상세 조회
pub async fn get_monitor(
    State(state): State<Arc<AlertingState>>,
    Path(id): Path<String>,
) -> Response {
    let lock = state.monitors.read().await;

    match lock.iter().find(|m| m.id == id) {
        Some(monitor) => Json(monitor).into_response(),
        None          => error_response(StatusCode::NOT_FOUND, format!("Monitor not found: {id}")),
    }
}

/// PUT /api/v1/monitors/:id — Monitor 수정
pub async fn update_monitor(
    State(state): State<Arc<AlertingState>>,
    Path(id): Path<String>,
    Json(req): Json<UpdateMonitorRequest>,
) -> Response {
    let mut lock = state.monitors.write().await;

    match lock.iter_mut().find(|m| m.id == id) {
        None => {
            error_response(StatusCode::NOT_FOUND, format!("Monitor not found: {id}"))
        }
        Some(monitor) => {
            if let Some(name)         = req.name         { monitor.name         = name; }
            if let Some(query)        = req.query        { monitor.query        = query; }
            if let Some(condition)    = req.condition    { monitor.condition    = condition; }
            if let Some(severity)     = req.severity     { monitor.severity     = severity; }
            if let Some(channels)     = req.channels     { monitor.channels     = channels; }
            if let Some(enabled)      = req.enabled      { monitor.enabled      = enabled; }
            if let Some(interval_secs) = req.interval_secs { monitor.interval_secs = interval_secs; }
            monitor.updated_at = Utc::now().timestamp();

            tracing::info!(monitor_id = %id, "Monitor 수정");
            Json(monitor.clone()).into_response()
        }
    }
}

/// DELETE /api/v1/monitors/:id — Monitor 삭제
pub async fn delete_monitor(
    State(state): State<Arc<AlertingState>>,
    Path(id): Path<String>,
) -> Response {
    let mut lock = state.monitors.write().await;
    let before = lock.len();
    lock.retain(|m| m.id != id);

    if lock.len() < before {
        tracing::info!(monitor_id = %id, "Monitor 삭제");
        StatusCode::NO_CONTENT.into_response()
    } else {
        error_response(StatusCode::NOT_FOUND, format!("Monitor not found: {id}"))
    }
}

// ---------------------------------------------------------------------------
// Incident 핸들러
// ---------------------------------------------------------------------------

/// GET /api/v1/incidents — Incident 목록 (tenant_id + status 필터)
pub async fn list_incidents(
    State(state): State<Arc<AlertingState>>,
    Query(params): Query<IncidentFilter>,
) -> Response {
    let lock = state.incidents.read().await;

    let list: Vec<&Incident> = lock
        .iter()
        .filter(|i| {
            let tenant_ok = params.tenant_id.as_ref()
                .map(|tid| &i.tenant_id == tid)
                .unwrap_or(true);
            let status_ok = params.status.as_ref()
                .map(|s| i.status.as_str() == s.as_str())
                .unwrap_or(true);
            tenant_ok && status_ok
        })
        .collect();

    Json(serde_json::json!({ "incidents": list, "total": list.len() })).into_response()
}

/// POST /api/v1/incidents/:id/acknowledge — Incident 인지
pub async fn acknowledge_incident(
    State(state): State<Arc<AlertingState>>,
    Path(id): Path<String>,
) -> Response {
    let mut lock = state.incidents.write().await;

    match lock.iter_mut().find(|i| i.id == id) {
        None => error_response(StatusCode::NOT_FOUND, format!("Incident not found: {id}")),
        Some(incident) => {
            if incident.status != IncidentStatus::Triggered {
                return error_response(
                    StatusCode::CONFLICT,
                    format!("Incident is already {}", incident.status.as_str()),
                );
            }
            incident.status = IncidentStatus::Acknowledged;
            tracing::info!(incident_id = %id, "Incident acknowledged");
            Json(incident.clone()).into_response()
        }
    }
}

/// POST /api/v1/incidents/:id/resolve — Incident 수동 해소
pub async fn resolve_incident(
    State(state): State<Arc<AlertingState>>,
    Path(id): Path<String>,
) -> Response {
    let mut lock = state.incidents.write().await;

    match lock.iter_mut().find(|i| i.id == id) {
        None => error_response(StatusCode::NOT_FOUND, format!("Incident not found: {id}")),
        Some(incident) => {
            if incident.status == IncidentStatus::Resolved {
                return error_response(StatusCode::CONFLICT, "Incident is already resolved");
            }
            incident.status      = IncidentStatus::Resolved;
            incident.resolved_at = Some(Utc::now().timestamp());
            tracing::info!(incident_id = %id, "Incident resolved");
            Json(incident.clone()).into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// 쿼리 파라미터 DTO
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct TenantFilter {
    pub tenant_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct IncidentFilter {
    pub tenant_id: Option<String>,
    /// "triggered" | "acknowledged" | "resolved"
    pub status: Option<String>,
}

// ---------------------------------------------------------------------------
// 라우터 빌더
// ---------------------------------------------------------------------------

/// Alerting API 라우터를 구성한다.
pub fn build_router(state: Arc<AlertingState>) -> Router {
    use tower_http::{
        cors::{Any, CorsLayer},
        trace::TraceLayer,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // Monitor CRUD
        .route("/api/v1/monitors",     post(create_monitor).get(list_monitors))
        .route("/api/v1/monitors/:id", get(get_monitor)
            .put(update_monitor)
            .delete(delete_monitor))
        // Incident 조회 + 상태 변경
        .route("/api/v1/incidents",               get(list_incidents))
        .route("/api/v1/incidents/:id/acknowledge", post(acknowledge_incident))
        .route("/api/v1/incidents/:id/resolve",     post(resolve_incident))
        // 헬스체크
        .route("/health", get(health_handler))
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state)
}

/// GET /health
async fn health_handler() -> impl IntoResponse {
    #[derive(Serialize)]
    struct HealthResponse {
        status: &'static str,
        version: &'static str,
    }
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}
