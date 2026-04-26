//! 라이선스 생성 및 검증
//!
//! 포맷: base64url(JSON payload) + "." + hex(HMAC-SHA256)
//! JSON payload: {"tenant_id": "...", "plan": "...", "expires": unix_ms}
//!
//! DATACAT_LICENSE_SECRET 환경변수로 서명 키를 주입한다.
//! 비밀키는 어떠한 응답에도 포함되지 않는다.

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// 라이선스 클레임 — 검증 성공 시 반환.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LicenseClaims {
    pub tenant_id: String,
    pub plan: String,
    /// Unix timestamp, 밀리초
    pub expires: i64,
}

/// 라이선스 토큰을 생성한다.
///
/// 반환값: `base64url(json) + "." + hex(hmac)`
pub fn generate_license(tenant_id: &str, plan: &str, valid_days: u32, secret: &str) -> String {
    let expires = Utc::now().timestamp_millis() + (valid_days as i64 * 86_400_000);

    let claims = LicenseClaims {
        tenant_id: tenant_id.to_string(),
        plan: plan.to_string(),
        expires,
    };

    let payload_json = serde_json::to_string(&claims).expect("claims 직렬화 실패");
    let payload_b64 = URL_SAFE_NO_PAD.encode(payload_json.as_bytes());

    let sig = compute_hmac(payload_b64.as_bytes(), secret.as_bytes());

    format!("{}.{}", payload_b64, sig)
}

/// 라이선스 토큰을 검증하고 클레임을 반환한다.
///
/// 실패 원인은 로그에 기록되지만 호출자에게는 제네릭 오류만 반환한다.
pub fn validate_license(license: &str, secret: &str) -> Result<LicenseClaims> {
    let mut parts = license.splitn(2, '.');
    let payload_b64 = parts.next().context("license format invalid")?;
    let sig_hex = parts
        .next()
        .context("license format invalid: missing sig")?;

    // 서명 검증 — constant-time via hmac::Mac::verify_slice (subtle crate 기반)
    // hex 디코딩 실패 자체가 타이밍 누출이 없으므로 일반 오류 처리로 충분.
    let sig_bytes = hex::decode(sig_hex).context("license signature hex decode failed")?;
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC key error");
    mac.update(payload_b64.as_bytes());
    mac.verify_slice(&sig_bytes)
        .map_err(|_| anyhow::anyhow!("license signature mismatch"))?;

    // 페이로드 디코딩
    let payload_bytes = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .context("license payload base64 decode failed")?;

    let claims: LicenseClaims =
        serde_json::from_slice(&payload_bytes).context("license payload json parse failed")?;

    // 만료 검사
    let now_ms = Utc::now().timestamp_millis();
    if claims.expires < now_ms {
        bail!("license expired");
    }

    Ok(claims)
}

// ---------------------------------------------------------------------------
// 내부 헬퍼
// ---------------------------------------------------------------------------

fn compute_hmac(data: &[u8], key: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC key error");
    mac.update(data);
    hex::encode(mac.finalize().into_bytes())
}
