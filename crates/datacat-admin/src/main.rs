//! datacat-admin — 테넌트 관리 & 라이선스 서비스 (port 9093)
//!
//! 환경변수:
//!   DATACAT_LISTEN_ADDR       — 바인딩 주소 (기본: 0.0.0.0:9093)
//!   DATACAT_LICENSE_SECRET    — HMAC-SHA256 서명 키 (기본: dev_secret_change_in_prod)
//!
//! SECURITY NOTE:
//!   이 서비스는 테넌트 메타데이터와 라이선스 발급을 담당한다.
//!   프로덕션 환경에서는 반드시 프라이빗 네트워크 또는 VPN 내부에서만
//!   접근 가능하도록 네트워크 레벨 보호가 필요하다.
//!   퍼블릭 인터넷에 직접 노출해서는 안 된다.

mod api;
mod license;
mod state;
mod tenant;

use anyhow::Result;
use tower_http::{cors::{Any, CorsLayer}, trace::TraceLayer};
use tracing::{info, warn};
use tracing_subscriber::{EnvFilter, fmt};

use api::tenant_router;
use state::AppState;
use tenant::{Plan, Tenant};

fn default_listen_addr() -> String {
    std::env::var("DATACAT_LISTEN_ADDR").unwrap_or_else(|_| "0.0.0.0:9093".to_string())
}

fn default_license_secret() -> String {
    let secret = std::env::var("DATACAT_LICENSE_SECRET")
        .unwrap_or_else(|_| "dev_secret_change_in_prod".to_string());
    if secret == "dev_secret_change_in_prod" {
        warn!("DATACAT_LICENSE_SECRET is using the default dev value — change before production!");
    }
    secret
}

/// "default" 테넌트를 사전 시드한다.
/// Phase 8에서 영속화 레이어로 교체될 때 제거 예정.
async fn seed_default_tenant(state: &AppState) {
    let (tenant, plain_key) = Tenant::new("default".to_string(), Plan::Enterprise);
    let tenant_id = tenant.id.clone();

    {
        let mut store = state.tenants.write().await;
        store.insert(tenant.id.clone(), tenant);
    }

    // 개발 환경에서 기본 키를 로그로 확인할 수 있도록 출력.
    // 프로덕션에서는 이 로그가 노출되지 않도록 로그 레벨을 관리해야 한다.
    info!(
        tenant_id = %tenant_id,
        api_key = %plain_key,
        "기본 'default' 테넌트 시드 완료 — 이 키를 안전하게 보관하세요"
    );
}

#[tokio::main]
async fn main() -> Result<()> {
    fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .json()
        .init();

    info!(
        version = env!("CARGO_PKG_VERSION"),
        "datacat-admin 시작"
    );

    let listen_addr = default_listen_addr();
    let license_secret = default_license_secret();

    let state = AppState::new(license_secret);

    // 기본 테넌트 시드
    seed_default_tenant(&state).await;

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = tenant_router()
        .layer(TraceLayer::new_for_http())
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&listen_addr).await?;
    info!(addr = %listen_addr, "datacat-admin 대기 중");

    axum::serve(listener, app).await?;

    Ok(())
}
