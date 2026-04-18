//! AppState — 공유 애플리케이션 상태
//!
//! Phase 8에서 ClickHouse 또는 SQLite 영속화 레이어로 교체 예정.
//! 현재는 in-memory HashMap + RwLock으로 구현한다.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::tenant::Tenant;

/// axum 핸들러 전체에서 공유되는 상태.
///
/// Clone은 Arc 내부를 복사하므로 비용이 없다.
#[derive(Clone)]
pub struct AppState {
    /// 테넌트 저장소: tenant_id → Tenant
    /// 읽기 작업이 압도적으로 많으므로 RwLock 선택.
    pub tenants: Arc<RwLock<HashMap<String, Tenant>>>,
    /// 라이선스 서명 비밀키 — 응답에 절대 포함하지 말 것.
    pub license_secret: String,
}

impl AppState {
    pub fn new(license_secret: String) -> Self {
        AppState {
            tenants: Arc::new(RwLock::new(HashMap::new())),
            license_secret,
        }
    }
}
