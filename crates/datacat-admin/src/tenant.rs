//! Tenant 도메인 모델
//!
//! 테넌트는 datacat의 최상위 격리 단위다.
//! ClickHouse의 모든 테이블에 `tenant_id` 컬럼이 있으며,
//! 쿼리 실행 시 반드시 이 값으로 필터링해야 한다.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Plan / Limits
// ---------------------------------------------------------------------------

/// 구독 플랜 — 각 플랜은 TenantLimits로 제한이 결정된다.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum Plan {
    Free,
    Pro,
    Enterprise,
}

impl Plan {
    pub fn as_str(&self) -> &'static str {
        match self {
            Plan::Free => "Free",
            Plan::Pro => "Pro",
            Plan::Enterprise => "Enterprise",
        }
    }
}

impl std::fmt::Display for Plan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Plan {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "Free" => Ok(Plan::Free),
            "Pro" => Ok(Plan::Pro),
            "Enterprise" => Ok(Plan::Enterprise),
            other => Err(anyhow::anyhow!("unknown plan: {}", other)),
        }
    }
}

/// 플랜별 사용 제한.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TenantLimits {
    /// 데이터 보존 일수
    pub retention_days: u32,
    /// 일별 최대 span 수신량
    pub max_spans_per_day: u64,
    /// 최대 서비스 수
    pub max_services: u32,
}

impl TenantLimits {
    pub fn for_plan(plan: &Plan) -> Self {
        match plan {
            Plan::Free => TenantLimits {
                retention_days: 7,
                max_spans_per_day: 1_000_000,
                max_services: 5,
            },
            Plan::Pro => TenantLimits {
                retention_days: 30,
                max_spans_per_day: 100_000_000,
                max_services: 50,
            },
            Plan::Enterprise => TenantLimits {
                retention_days: 365,
                max_spans_per_day: u64::MAX,
                max_services: u32::MAX,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// Tenant
// ---------------------------------------------------------------------------

/// 테넌트 엔티티.
///
/// `api_key` 필드는 저장소에서 SHA-256 해시로만 보관한다.
/// 평문 키는 생성/교체 시 단 한 번만 반환되며 이후 복구 불가.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tenant {
    /// UUID v4
    pub id: String,
    pub name: String,
    pub plan: Plan,
    /// SHA-256(plain_key) — hex-encoded, 저장소에는 이 값만 유지
    pub api_key_hash: String,
    /// Unix timestamp, 밀리초
    pub created_at: i64,
    pub active: bool,
    pub limits: TenantLimits,
}

impl Tenant {
    /// 새 테넌트를 생성한다. 평문 API 키를 함께 반환한다 (단 한 번).
    pub fn new(name: String, plan: Plan) -> (Tenant, String) {
        let plain_key = Uuid::new_v4().to_string().replace('-', "");
        let key_hash = hash_api_key(&plain_key);
        let tenant = Tenant {
            id: Uuid::new_v4().to_string(),
            name,
            limits: TenantLimits::for_plan(&plan),
            plan,
            api_key_hash: key_hash,
            created_at: Utc::now().timestamp_millis(),
            active: true,
        };
        (tenant, plain_key)
    }

    /// API 키를 교체한다. 새 평문 키를 반환한다 (단 한 번).
    pub fn rotate_key(&mut self) -> String {
        let plain_key = Uuid::new_v4().to_string().replace('-', "");
        self.api_key_hash = hash_api_key(&plain_key);
        plain_key
    }

    /// 플랜을 변경하고 limits를 재계산한다.
    pub fn update_plan(&mut self, plan: Plan) {
        self.limits = TenantLimits::for_plan(&plan);
        self.plan = plan;
    }
}

/// SHA-256 해시 — hex-encoded lowercase.
pub fn hash_api_key(plain: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(plain.as_bytes());
    hex::encode(hasher.finalize())
}

// ---------------------------------------------------------------------------
// API 응답 전용 DTO
// ---------------------------------------------------------------------------

/// GET/PUT 응답에서 api_key를 마스킹한 테넌트 표현.
#[derive(Debug, Serialize)]
pub struct TenantView {
    pub id: String,
    pub name: String,
    pub plan: Plan,
    /// 항상 "***" — 평문 키는 반환하지 않는다.
    pub api_key: &'static str,
    pub created_at: i64,
    pub active: bool,
    pub limits: TenantLimits,
}

impl From<&Tenant> for TenantView {
    fn from(t: &Tenant) -> Self {
        TenantView {
            id: t.id.clone(),
            name: t.name.clone(),
            plan: t.plan.clone(),
            api_key: "***",
            created_at: t.created_at,
            active: t.active,
            limits: t.limits.clone(),
        }
    }
}

/// POST /tenants 응답 — 생성 직후 한 번만 평문 키 포함.
#[derive(Debug, Serialize)]
pub struct TenantCreateResponse {
    pub tenant: TenantView,
    /// 이 응답 이후에는 복구 불가. 안전하게 보관할 것.
    pub api_key: String,
}
