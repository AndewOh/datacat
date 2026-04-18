//! API 키 인증 미들웨어
//!
//! 환경변수:
//!   DATACAT_AUTH_ENABLED   — "true" 이면 인증 활성화, 그 외는 개발 모드(pass-through)
//!   DATACAT_ADMIN_URL      — datacat-admin 서비스 URL (기본: http://localhost:9092)
//!
//! 인증 흐름:
//!   1. X-API-Key 헤더에서 키를 추출한다.
//!   2. datacat-admin의 POST /api/v1/admin/auth/verify 를 호출한다.
//!   3. 성공 시 X-Tenant-ID 헤더를 요청에 추가하고 다음 핸들러로 진행한다.
//!   4. 실패 시 401 Unauthorized 를 반환한다 (상세 오류 미노출).
//!
//! SECURITY NOTE:
//!   - 401 응답에는 실패 원인을 포함하지 않는다 (정보 누출 방지).
//!   - admin 서비스와의 내부 통신은 프라이빗 네트워크에서 이루어져야 한다.

use axum::{
    body::Body,
    extract::Request,
    http::{HeaderName, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use tracing::{error, warn};

/// 인증 미들웨어 설정.
#[derive(Clone, Debug)]
pub struct AuthConfig {
    /// datacat-admin 서비스 URL
    pub admin_url: String,
    /// 재사용 HTTP 클라이언트
    pub http_client: reqwest::Client,
}

impl AuthConfig {
    pub fn from_env() -> Self {
        let admin_url = std::env::var("DATACAT_ADMIN_URL")
            .unwrap_or_else(|_| "http://localhost:9093".to_string());
        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        AuthConfig { admin_url, http_client }
    }
}

/// datacat-admin verify 응답 DTO.
#[derive(Debug, Deserialize)]
struct VerifyResponse {
    tenant_id: String,
    #[allow(dead_code)]
    plan: String,
}

#[derive(Debug, Serialize)]
struct VerifyRequest<'a> {
    api_key: &'a str,
}

/// axum 미들웨어: X-API-Key 헤더를 검증한다.
///
/// DATACAT_AUTH_ENABLED=true 일 때만 실제 검증을 수행한다.
/// 그 외 환경(개발/테스트)에서는 즉시 pass-through한다.
pub async fn auth_middleware(
    axum::extract::State(config): axum::extract::State<AuthConfig>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let auth_enabled = std::env::var("DATACAT_AUTH_ENABLED")
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if !auth_enabled {
        return next.run(req).await;
    }

    // X-API-Key 헤더 추출
    let api_key = match req.headers().get("x-api-key").and_then(|v| v.to_str().ok()) {
        Some(k) if !k.is_empty() => k.to_string(),
        _ => {
            warn!("API 키 없이 인증이 필요한 요청 수신");
            return unauthorized();
        }
    };

    // datacat-admin 으로 검증 요청
    let verify_url = format!("{}/api/v1/admin/auth/verify", config.admin_url);
    let body = VerifyRequest { api_key: &api_key };

    match config
        .http_client
        .post(&verify_url)
        .json(&body)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<VerifyResponse>().await {
                Ok(verified) => {
                    // 검증된 tenant_id 를 다음 핸들러에 헤더로 전달
                    match HeaderValue::from_str(&verified.tenant_id) {
                        Ok(hv) => {
                            req.headers_mut()
                                .insert(HeaderName::from_static("x-tenant-id"), hv);
                        }
                        Err(e) => {
                            error!(error = %e, "tenant_id 헤더 변환 실패");
                            return internal_error();
                        }
                    }
                    next.run(req).await
                }
                Err(e) => {
                    error!(error = %e, "admin 검증 응답 파싱 실패");
                    internal_error()
                }
            }
        }
        Ok(resp) => {
            warn!(status = %resp.status(), "API 키 검증 거부");
            unauthorized()
        }
        Err(e) => {
            error!(error = %e, url = %verify_url, "admin 서비스 연결 실패");
            internal_error()
        }
    }
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        axum::Json(serde_json::json!({"error": "unauthorized"})),
    )
        .into_response()
}

fn internal_error() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        axum::Json(serde_json::json!({"error": "internal server error"})),
    )
        .into_response()
}
