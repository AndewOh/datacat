//! 알림 발송 모듈
//!
//! Incident가 생성될 때 Monitor에 정의된 각 NotificationChannel로
//! 알림을 발송한다.
//!
//! 지원 채널:
//! - Slack Incoming Webhook (실제 Slack API 포맷 준수)
//! - Generic HTTP Webhook
//! - Email (Phase 7에서 SMTP 구현 예정, 현재는 로그만)

use anyhow::Result;
use std::collections::HashMap;
use tracing::{info, warn};

use crate::incident::Incident;
use crate::monitor::NotificationChannel;

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

/// Slack Incoming Webhook으로 인시던트 알림을 발송한다.
///
/// Slack Incoming Webhook API 포맷:
/// POST {webhook_url}
/// Content-Type: application/json
/// {"blocks": [...]} 또는 {"text": "..."}
pub async fn send_slack(
    client: &reqwest::Client,
    webhook_url: &str,
    incident: &Incident,
) -> Result<()> {
    // Slack Block Kit 포맷으로 가독성 높은 메시지 구성
    let color = match incident.severity {
        crate::monitor::Severity::Critical => "#FF0000",
        crate::monitor::Severity::Warning  => "#FFA500",
        crate::monitor::Severity::Info     => "#0000FF",
    };

    let status_text = match incident.status {
        crate::incident::IncidentStatus::Triggered    => "TRIGGERED",
        crate::incident::IncidentStatus::Acknowledged => "ACKNOWLEDGED",
        crate::incident::IncidentStatus::Resolved     => "RESOLVED",
    };

    // Slack Attachment 포맷 (Block Kit보다 색상 지원이 간단)
    let body = serde_json::json!({
        "text": format!(
            "{} [{}] {}",
            incident.severity.emoji(),
            incident.severity.as_str(),
            incident.title
        ),
        "attachments": [
            {
                "color": color,
                "fields": [
                    {
                        "title": "Status",
                        "value": status_text,
                        "short": true
                    },
                    {
                        "title": "Severity",
                        "value": incident.severity.as_str(),
                        "short": true
                    },
                    {
                        "title": "Trigger Value",
                        "value": format!("{:.4}", incident.trigger_value),
                        "short": true
                    },
                    {
                        "title": "Tenant",
                        "value": &incident.tenant_id,
                        "short": true
                    },
                    {
                        "title": "Incident ID",
                        "value": &incident.id,
                        "short": false
                    }
                ],
                "footer": "datacat-alerting",
                "ts": incident.triggered_at
            }
        ]
    });

    let resp = client
        .post(webhook_url)
        .json(&body)
        .send()
        .await?;

    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!(
            "Slack webhook 실패: HTTP {} — {}",
            status,
            body_text
        ));
    }

    info!(
        incident_id = %incident.id,
        "Slack 알림 발송 완료"
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Generic Webhook
// ---------------------------------------------------------------------------

/// 임의 HTTP Webhook으로 인시던트 JSON을 POST한다.
///
/// `headers`에 Authorization, X-API-Key 등 커스텀 헤더를 지정할 수 있다.
pub async fn send_webhook(
    client: &reqwest::Client,
    url: &str,
    headers: &HashMap<String, String>,
    incident: &Incident,
) -> Result<()> {
    let mut req = client.post(url).json(incident);

    for (key, value) in headers {
        req = req.header(key, value);
    }

    let resp = req.send().await?;

    let status = resp.status();
    if !status.is_success() {
        let body_text = resp.text().await.unwrap_or_default();
        return Err(anyhow::anyhow!(
            "Webhook 발송 실패: {} → HTTP {} — {}",
            url,
            status,
            body_text
        ));
    }

    info!(
        incident_id = %incident.id,
        url = %url,
        "Webhook 알림 발송 완료"
    );

    Ok(())
}

// ---------------------------------------------------------------------------
// Email (stub)
// ---------------------------------------------------------------------------

/// 이메일 알림 발송 (Phase 7에서 SMTP 구현 예정).
/// 현재는 발송 의도를 로그로 기록한다.
pub async fn send_email(addresses: &[String], incident: &Incident) -> Result<()> {
    warn!(
        incident_id = %incident.id,
        addresses = ?addresses,
        "Email 알림: Phase 7에서 SMTP 구현 예정 — 현재는 로그 기록만 수행"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// 라우팅
// ---------------------------------------------------------------------------

/// 채널 종류에 따라 적절한 발송 함수로 라우팅한다.
pub async fn notify(
    client: &reqwest::Client,
    channel: &NotificationChannel,
    incident: &Incident,
) -> Result<()> {
    match channel {
        NotificationChannel::Slack { webhook_url } => {
            send_slack(client, webhook_url, incident).await
        }
        NotificationChannel::Webhook { url, headers } => {
            send_webhook(client, url, headers, incident).await
        }
        NotificationChannel::Email { addresses } => {
            send_email(addresses, incident).await
        }
    }
}
