//! Monitor 모델 — 알림 조건 정의
//!
//! Monitor는 주기적으로 평가되는 알림 규칙이다.
//! ClickHouse에서 쿼리를 실행하여 임계값 위반 시 Incident를 생성한다.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 알림 규칙 정의.
/// 특정 주기(interval_secs)마다 query를 실행하고 condition에 따라 평가한다.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Monitor {
    /// UUID v4 형식 식별자
    pub id: String,
    /// 사람이 읽기 쉬운 이름
    pub name: String,
    /// 멀티테넌트 격리 키
    pub tenant_id: String,
    /// 평가할 쿼리 정의
    pub query: MonitorQuery,
    /// 임계값 조건
    pub condition: Condition,
    /// 심각도 수준
    pub severity: Severity,
    /// 알림을 보낼 채널 목록
    pub channels: Vec<NotificationChannel>,
    /// 활성화 여부 (false이면 평가 건너뜀)
    pub enabled: bool,
    /// 평가 주기 (초, 기본 60)
    pub interval_secs: u32,
    /// 생성 시각 (Unix timestamp, 초)
    pub created_at: i64,
    /// 수정 시각 (Unix timestamp, 초)
    pub updated_at: i64,
}

/// Monitor 쿼리 정의.
/// 어떤 데이터 소스에서 어떤 방식으로 집계할지 지정한다.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MonitorQuery {
    /// 데이터 소스 종류
    pub kind: QueryKind,
    /// 서비스 이름 (필터)
    pub expr: String,
    /// 집계 함수 (avg, p99, count, error_rate 등)
    pub aggregation: String,
    /// 평가 윈도우 (초)
    pub window_secs: u32,
}

/// 쿼리 데이터 소스 종류.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum QueryKind {
    /// spans 테이블 기반 (응답시간, 에러율)
    Metric,
    /// spans 테이블 기반 (트레이스 품질)
    Trace,
    /// logs 테이블 기반 (에러 로그 건수)
    Log,
}

/// 임계값 비교 조건.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Condition {
    /// 비교 연산자
    pub op: CompareOp,
    /// 임계값
    pub threshold: f64,
}

impl Condition {
    /// value가 조건을 위반하는지 확인한다.
    pub fn is_violated(&self, value: f64) -> bool {
        match self.op {
            CompareOp::Gt  => value >  self.threshold,
            CompareOp::Gte => value >= self.threshold,
            CompareOp::Lt  => value <  self.threshold,
            CompareOp::Lte => value <= self.threshold,
            CompareOp::Eq  => (value - self.threshold).abs() < f64::EPSILON,
        }
    }
}

/// 비교 연산자.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub enum CompareOp {
    /// 초과 (>)
    Gt,
    /// 이상 (>=)
    Gte,
    /// 미만 (<)
    Lt,
    /// 이하 (<=)
    Lte,
    /// 같음 (==)
    Eq,
}

/// 알림 심각도.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum Severity {
    Critical,
    Warning,
    Info,
}

impl Severity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Severity::Critical => "CRITICAL",
            Severity::Warning  => "WARNING",
            Severity::Info     => "INFO",
        }
    }

    /// Slack 메시지 이모지 (Slack API에서 쓰이는 텍스트 이모지)
    pub fn emoji(&self) -> &'static str {
        match self {
            Severity::Critical => ":red_circle:",
            Severity::Warning  => ":large_yellow_circle:",
            Severity::Info     => ":large_blue_circle:",
        }
    }
}

/// 알림을 보낼 채널.
/// `#[serde(tag = "type")]`으로 JSON 직렬화 시 type 필드가 추가된다.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum NotificationChannel {
    /// Slack Incoming Webhook
    Slack {
        webhook_url: String,
    },
    /// 임의 HTTP Webhook (커스텀 헤더 지원)
    Webhook {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    },
    /// 이메일 (Phase 7에서 SMTP 연동 예정)
    Email {
        addresses: Vec<String>,
    },
}

/// Monitor 생성 요청 DTO.
#[derive(Debug, Deserialize)]
pub struct CreateMonitorRequest {
    pub name: String,
    pub tenant_id: String,
    pub query: MonitorQuery,
    pub condition: Condition,
    pub severity: Severity,
    #[serde(default)]
    pub channels: Vec<NotificationChannel>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default = "default_interval_secs")]
    pub interval_secs: u32,
}

/// Monitor 수정 요청 DTO.
#[derive(Debug, Deserialize)]
pub struct UpdateMonitorRequest {
    pub name: Option<String>,
    pub query: Option<MonitorQuery>,
    pub condition: Option<Condition>,
    pub severity: Option<Severity>,
    pub channels: Option<Vec<NotificationChannel>>,
    pub enabled: Option<bool>,
    pub interval_secs: Option<u32>,
}

fn default_enabled() -> bool { true }
fn default_interval_secs() -> u32 { 60 }
