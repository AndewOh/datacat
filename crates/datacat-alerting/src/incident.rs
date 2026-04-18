//! Incident 모델 — Monitor 위반 시 생성되는 인시던트

use crate::monitor::Severity;
use serde::{Deserialize, Serialize};

/// Monitor 조건 위반으로 생성된 인시던트.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Incident {
    /// UUID v4 형식 식별자
    pub id: String,
    /// 이 인시던트를 발생시킨 Monitor ID
    pub monitor_id: String,
    /// 멀티테넌트 격리 키
    pub tenant_id: String,
    /// 심각도 (Monitor에서 복사)
    pub severity: Severity,
    /// 인시던트 제목 (Monitor 이름 + 트리거 값)
    pub title: String,
    /// 현재 상태
    pub status: IncidentStatus,
    /// 트리거 시각 (Unix timestamp, 초)
    pub triggered_at: i64,
    /// 해소 시각 (None = 미해소)
    pub resolved_at: Option<i64>,
    /// 트리거 당시 측정값
    pub trigger_value: f64,
}

/// 인시던트 상태 전이: Triggered → Acknowledged → Resolved
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum IncidentStatus {
    /// 트리거됨 (초기 상태)
    Triggered,
    /// 담당자가 인지함
    Acknowledged,
    /// 해소됨
    Resolved,
}

impl IncidentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            IncidentStatus::Triggered    => "triggered",
            IncidentStatus::Acknowledged => "acknowledged",
            IncidentStatus::Resolved     => "resolved",
        }
    }
}
