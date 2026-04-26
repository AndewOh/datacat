//! Tenant CRUD & License REST 핸들러
//!
//! 보안 주의:
//!   - 이 엔드포인트들은 프로덕션 환경에서 반드시 프라이빗 네트워크 또는 VPN 내부에서만
//!     접근 가능하도록 네트워크 레벨 보호가 필요하다.
//!   - API 키는 생성/교체 응답에서만 평문으로 반환되며, 이후에는 절대 복구할 수 없다.
//!   - 라이선스 시크릿은 어떠한 응답에도 포함되지 않는다.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::{
    license::{generate_license, validate_license},
    state::AppState,
    tenant::{hash_api_key, Plan, Tenant, TenantCreateResponse, TenantView},
};

// ---------------------------------------------------------------------------
// 공통 응답 타입
// ---------------------------------------------------------------------------

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({"error": "tenant not found"})),
    )
        .into_response()
}

fn bad_request(msg: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": msg})),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /health, /healthz — liveness probe
// ---------------------------------------------------------------------------

pub async fn health_handler() -> impl IntoResponse {
    #[derive(Serialize)]
    struct HealthResponse {
        status: &'static str,
        service: &'static str,
        version: &'static str,
    }

    Json(HealthResponse {
        status: "ok",
        service: "datacat-admin",
        version: env!("CARGO_PKG_VERSION"),
    })
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/tenants — 테넌트 생성
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateTenantRequest {
    pub name: String,
    /// "Free" | "Pro" | "Enterprise"
    pub plan: Option<String>,
}

pub async fn create_tenant(
    State(state): State<AppState>,
    Json(req): Json<CreateTenantRequest>,
) -> Response {
    if req.name.trim().is_empty() {
        return bad_request("name must not be empty");
    }

    let plan: Plan = match req.plan.as_deref().unwrap_or("Free").parse::<Plan>() {
        Ok(p) => p,
        Err(_) => return bad_request("plan must be one of: Free, Pro, Enterprise"),
    };

    let (tenant, plain_key) = Tenant::new(req.name.clone(), plan);
    let view = TenantView::from(&tenant);

    {
        let mut store = state.tenants.write().await;
        store.insert(tenant.id.clone(), tenant);
    }

    info!(tenant_id = %view.id, name = %view.name, plan = ?view.plan, "테넌트 생성 완료");

    (
        StatusCode::CREATED,
        Json(TenantCreateResponse {
            tenant: view,
            api_key: plain_key,
        }),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/tenants — 전체 목록 조회
// ---------------------------------------------------------------------------

pub async fn list_tenants(State(state): State<AppState>) -> Response {
    let store = state.tenants.read().await;
    let list: Vec<TenantView> = store.values().map(TenantView::from).collect();
    Json(serde_json::json!({ "tenants": list })).into_response()
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/tenants/:id — 단건 조회
// ---------------------------------------------------------------------------

pub async fn get_tenant(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let store = state.tenants.read().await;
    match store.get(&id) {
        Some(t) => Json(TenantView::from(t)).into_response(),
        None => not_found(),
    }
}

// ---------------------------------------------------------------------------
// PUT /api/v1/admin/tenants/:id — 테넌트 수정
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct UpdateTenantRequest {
    pub name: Option<String>,
    pub plan: Option<String>,
    pub active: Option<bool>,
}

pub async fn update_tenant(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateTenantRequest>,
) -> Response {
    let mut store = state.tenants.write().await;
    match store.get_mut(&id) {
        None => not_found(),
        Some(tenant) => {
            if let Some(name) = req.name {
                if name.trim().is_empty() {
                    return bad_request("name must not be empty");
                }
                tenant.name = name;
            }
            if let Some(plan_str) = req.plan {
                match plan_str.parse::<Plan>() {
                    Ok(plan) => tenant.update_plan(plan),
                    Err(_) => return bad_request("plan must be one of: Free, Pro, Enterprise"),
                }
            }
            if let Some(active) = req.active {
                tenant.active = active;
            }

            info!(tenant_id = %id, "테넌트 업데이트 완료");
            Json(TenantView::from(tenant as &Tenant)).into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// DELETE /api/v1/admin/tenants/:id — 소프트 삭제 (active=false)
// ---------------------------------------------------------------------------

pub async fn delete_tenant(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let mut store = state.tenants.write().await;
    match store.get_mut(&id) {
        None => not_found(),
        Some(tenant) => {
            tenant.active = false;
            info!(tenant_id = %id, "테넌트 비활성화 (soft delete)");
            (
                StatusCode::OK,
                Json(serde_json::json!({ "deleted": true, "id": id })),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/tenants/:id/rotate-key — API 키 교체
// ---------------------------------------------------------------------------

pub async fn rotate_key(State(state): State<AppState>, Path(id): Path<String>) -> Response {
    let mut store = state.tenants.write().await;
    match store.get_mut(&id) {
        None => not_found(),
        Some(tenant) => {
            let plain_key = tenant.rotate_key();
            info!(tenant_id = %id, "API 키 교체 완료");
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "tenant_id": id,
                    "api_key": plain_key,
                    "message": "Store this key securely — it will not be shown again."
                })),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/auth/verify — API Key 검증 (datacat-api 미들웨어용)
//
// SECURITY NOTE: 프로덕션에서는 이 엔드포인트를 프라이빗 네트워크에서만
// 접근 가능하도록 제한해야 한다.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct VerifyKeyRequest {
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct VerifyKeyResponse {
    pub tenant_id: String,
    pub plan: String,
}

pub async fn verify_api_key(
    State(state): State<AppState>,
    Json(req): Json<VerifyKeyRequest>,
) -> Response {
    if req.api_key.is_empty() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "unauthorized"})),
        )
            .into_response();
    }

    let key_hash = hash_api_key(&req.api_key);
    let store = state.tenants.read().await;

    match store
        .values()
        .find(|t| t.active && t.api_key_hash == key_hash)
    {
        Some(tenant) => Json(VerifyKeyResponse {
            tenant_id: tenant.id.clone(),
            plan: tenant.plan.to_string(),
        })
        .into_response(),
        None => {
            warn!("API 키 검증 실패: 일치하는 활성 테넌트 없음");
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "unauthorized"})),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/license/generate
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct GenerateLicenseRequest {
    pub tenant_id: String,
    pub plan: String,
    pub valid_days: u32,
}

pub async fn generate_license_handler(
    State(state): State<AppState>,
    Json(req): Json<GenerateLicenseRequest>,
) -> Response {
    if req.tenant_id.is_empty() || req.plan.is_empty() {
        return bad_request("tenant_id and plan are required");
    }
    if req.valid_days == 0 || req.valid_days > 3650 {
        return bad_request("valid_days must be between 1 and 3650");
    }

    let license = generate_license(
        &req.tenant_id,
        &req.plan,
        req.valid_days,
        &state.license_secret,
    );

    info!(
        tenant_id = %req.tenant_id,
        plan = %req.plan,
        valid_days = req.valid_days,
        "라이선스 생성 완료"
    );

    Json(serde_json::json!({ "license": license })).into_response()
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/license/validate
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ValidateLicenseRequest {
    pub license: String,
}

pub async fn validate_license_handler(
    State(state): State<AppState>,
    Json(req): Json<ValidateLicenseRequest>,
) -> Response {
    match validate_license(&req.license, &state.license_secret) {
        Ok(claims) => Json(claims).into_response(),
        Err(e) => {
            // 상세 오류를 로그에만 기록, 외부에는 제네릭 메시지 반환
            warn!(error = %e, "라이선스 검증 실패");
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "invalid or expired license"})),
            )
                .into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// 라우터 빌더
// ---------------------------------------------------------------------------

pub fn tenant_router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health_handler))
        .route("/healthz", get(health_handler))
        .route("/api/v1/admin/tenants", post(create_tenant))
        .route("/api/v1/admin/tenants", get(list_tenants))
        .route("/api/v1/admin/tenants/:id", get(get_tenant))
        .route("/api/v1/admin/tenants/:id", put(update_tenant))
        .route("/api/v1/admin/tenants/:id", delete(delete_tenant))
        .route("/api/v1/admin/tenants/:id/rotate-key", post(rotate_key))
        .route("/api/v1/admin/auth/verify", post(verify_api_key))
        .route(
            "/api/v1/admin/license/generate",
            post(generate_license_handler),
        )
        .route(
            "/api/v1/admin/license/validate",
            post(validate_license_handler),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn health_handler_returns_admin_status_payload() {
        let response = health_handler().await.into_response();
        assert_eq!(response.status(), StatusCode::OK);

        let body = to_bytes(response.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["service"], "datacat-admin");
        assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
    }
}
