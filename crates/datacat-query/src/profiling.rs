//! Profiling Query API
//!
//! ClickHouse `datacat.profiles` 테이블에서 프로파일을 조회한다.
//!
//! 엔드포인트:
//! - GET /api/v1/profiles          — 프로파일 목록 조회
//! - GET /api/v1/profiles/:id/flamegraph — pprof 파싱 → folded 포맷 반환
//!
//! 플레임그래프 응답 전략 (Phase 4 단순화):
//! pprof protobuf 완전 파싱은 Phase 5로 미루고,
//! Phase 4에서는 두 가지 경로로 처리한다:
//! 1. 헤더 파싱으로 pprof 여부를 판단 (magic bytes: 0x1f 0x8b — gzip)
//! 2. gzip 해제 후 protobuf 헤더 검사
//! 3. 성공 시 folded 포맷으로 변환 시도, 실패 시 raw base64 반환
//!
//! 응답 < 300ms SLO를 위해:
//! - ClickHouse 인덱스 활용: (tenant_id, service, timestamp) 정렬 키 사용
//! - payload는 flamegraph 요청 시에만 로드 (목록 조회에서는 제외)

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use clickhouse::Row;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::{debug, error, info};

use crate::AppState;

// ---------------------------------------------------------------------------
// 쿼리 파라미터
// ---------------------------------------------------------------------------

/// GET /api/v1/profiles 쿼리 파라미터
#[derive(Debug, Deserialize)]
pub struct ProfilesListParams {
    /// 서비스 이름 필터 (필수)
    pub service: String,
    /// 조회 시작 (Unix ms)
    pub start: i64,
    /// 조회 종료 (Unix ms)
    pub end: i64,
    /// 프로파일 타입 필터 (cpu, heap, goroutine, block)
    #[serde(rename = "type")]
    pub profile_type: Option<String>,
    /// 테넌트 ID (선택, 기본: "default")
    pub tenant_id: Option<String>,
    /// 반환 최대 개수 (기본: 10)
    pub limit: Option<u32>,
}

// ---------------------------------------------------------------------------
// 응답 타입
// ---------------------------------------------------------------------------

/// GET /api/v1/profiles 응답
#[derive(Debug, Serialize)]
pub struct ProfilesListResponse {
    pub profiles: Vec<ProfileSummary>,
}

/// 프로파일 요약 정보 (API 응답용)
#[derive(Debug, Serialize)]
pub struct ProfileSummary {
    pub id: String,
    pub service: String,
    #[serde(rename = "type")]
    pub profile_type: String,
    /// Unix ms (프론트엔드 호환)
    pub timestamp: i64,
    /// payload 추정 bytes
    pub size_bytes: u64,
}

/// GET /api/v1/profiles/:id/flamegraph 응답
#[derive(Debug, Serialize)]
pub struct FlamegraphResponse {
    pub profile_id: String,
    pub service: String,
    #[serde(rename = "type")]
    pub profile_type: String,
    /// Unix ms
    pub timestamp: i64,
    /// 응답 포맷 식별자
    pub format: FlamegraphFormat,
    /// folded format 프레임 목록 (format = "folded" 일 때)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folded: Option<Vec<FoldedFrame>>,
    /// raw base64 payload (format = "pprof" 일 때 — 프론트에서 직접 파싱)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_base64: Option<String>,
}

/// 플레임그래프 응답 포맷
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FlamegraphFormat {
    /// Brendan Gregg folded 포맷으로 서버 측 변환 성공
    Folded,
    /// raw pprof base64 — 프론트엔드에서 @pyroscope/pprof 등으로 파싱
    Pprof,
}

/// Brendan Gregg folded format의 단일 프레임
#[derive(Debug, Serialize)]
pub struct FoldedFrame {
    /// 세미콜론으로 구분된 콜 스택 (루트 → 리프 순)
    pub stack: String,
    /// 샘플 수 또는 메모리 bytes
    pub value: i64,
}

// ---------------------------------------------------------------------------
// ClickHouse 조회용 내부 Row 타입
// ---------------------------------------------------------------------------

/// 목록 조회용 Row — payload 제외
#[derive(Debug, Deserialize, Row)]
struct ProfileListRow {
    pub profile_id: String,
    pub service: String,
    #[serde(rename = "type")]
    pub profile_type: String,
    pub timestamp: i64,
    /// length(payload) — base64 문자 수
    pub payload_size: u64,
}

/// flamegraph 조회용 Row — payload 포함
#[derive(Debug, Deserialize, Row)]
struct ProfileDetailRow {
    pub profile_id: String,
    pub service: String,
    #[serde(rename = "type")]
    pub profile_type: String,
    pub timestamp: i64,
    pub payload: String,
}

// ---------------------------------------------------------------------------
// SQL 인젝션 방어 헬퍼
// ---------------------------------------------------------------------------

/// String 파라미터에서 SQL 특수문자를 이스케이프한다.
/// ClickHouse String literal 내에서 `'`와 `\`를 이스케이프.
fn escape_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------

/// GET /api/v1/profiles
///
/// 서비스 + 시간 범위로 프로파일 목록을 조회한다.
/// payload는 포함하지 않으며 크기 정보만 반환한다.
pub async fn list_profiles_handler(
    State(state): State<Arc<AppState>>,
    Query(params): Query<ProfilesListParams>,
) -> impl IntoResponse {
    let tenant_id = params
        .tenant_id
        .as_deref()
        .unwrap_or("default")
        .to_string();
    let limit = params.limit.unwrap_or(10).min(100);

    info!(
        service = %params.service,
        start = params.start,
        end = params.end,
        tenant_id = %tenant_id,
        "profiles 목록 조회"
    );

    // Unix ms → 나노초로 변환 (ClickHouse DateTime64(9) 호환)
    let start_ns = params.start * 1_000_000i64;
    let end_ns = params.end * 1_000_000i64;

    let service_esc = escape_string(&params.service);
    let tenant_esc = escape_string(&tenant_id);

    // type 필터 (선택)
    let type_clause = match &params.profile_type {
        Some(t) => format!(" AND type = '{}'", escape_string(t)),
        None => String::new(),
    };

    let sql = format!(
        "SELECT \
            profile_id, \
            service, \
            type, \
            toInt64(timestamp) AS timestamp, \
            toUInt64(length(payload)) AS payload_size \
         FROM datacat.profiles \
         WHERE tenant_id = '{tenant}' \
           AND service = '{service}' \
           AND timestamp >= {start} \
           AND timestamp <= {end} \
           {type_clause} \
         ORDER BY timestamp DESC \
         LIMIT {limit}",
        tenant = tenant_esc,
        service = service_esc,
        start = start_ns,
        end = end_ns,
        type_clause = type_clause,
        limit = limit,
    );

    debug!(sql = %sql, "profiles 쿼리 실행");

    match state
        .ch_client
        .query(&sql)
        .fetch_all::<ProfileListRow>()
        .await
    {
        Ok(rows) => {
            let profiles: Vec<ProfileSummary> = rows
                .into_iter()
                .map(|r| ProfileSummary {
                    id: r.profile_id,
                    service: r.service,
                    profile_type: r.profile_type,
                    // 나노초 → 밀리초
                    timestamp: r.timestamp / 1_000_000,
                    // base64 문자 수 → 실제 bytes 추정 (base64 overhead: 4/3)
                    size_bytes: r.payload_size * 3 / 4,
                })
                .collect();

            (
                StatusCode::OK,
                axum::Json(ProfilesListResponse { profiles }),
            )
                .into_response()
        }
        Err(e) => {
            error!(error = %e, "profiles 쿼리 실패");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "internal server error" })),
            )
                .into_response()
        }
    }
}

/// GET /api/v1/profiles/:profile_id/flamegraph
///
/// 특정 프로파일의 flamegraph 데이터를 반환한다.
///
/// 처리 흐름:
/// 1. ClickHouse에서 profile_id로 payload 조회
/// 2. base64 decode → raw bytes
/// 3. gzip 압축 여부 확인 (pprof는 gzip으로 압축됨)
/// 4. folded format 변환 시도
/// 5. 실패 시 raw base64 반환 (프론트엔드에서 직접 파싱)
pub async fn get_flamegraph_handler(
    State(state): State<Arc<AppState>>,
    Path(profile_id): Path<String>,
) -> impl IntoResponse {
    let profile_id_esc = escape_string(&profile_id);

    info!(profile_id = %profile_id, "flamegraph 조회");

    let sql = format!(
        "SELECT \
            profile_id, \
            service, \
            type, \
            toInt64(timestamp) AS timestamp, \
            payload \
         FROM datacat.profiles \
         WHERE profile_id = '{profile_id}' \
         LIMIT 1",
        profile_id = profile_id_esc,
    );

    let rows = match state
        .ch_client
        .query(&sql)
        .fetch_all::<ProfileDetailRow>()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            error!(error = %e, profile_id = %profile_id, "profiles payload 조회 실패");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "internal server error" })),
            )
                .into_response();
        }
    };

    let row = match rows.into_iter().next() {
        Some(r) => r,
        None => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(serde_json::json!({ "error": "profile not found" })),
            )
                .into_response();
        }
    };

    let timestamp_ms = row.timestamp / 1_000_000;

    // base64 decode
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
    let raw_bytes = match BASE64.decode(&row.payload) {
        Ok(b) => b,
        Err(e) => {
            error!(error = %e, profile_id = %profile_id, "base64 decode 실패");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({ "error": "payload decode failed" })),
            )
                .into_response();
        }
    };

    // pprof 파싱 시도 (gzip → protobuf)
    // Phase 4 단순화: pprof 완전 파싱 대신 folded format 변환 시도
    // 실패 시 raw base64 반환
    match try_parse_pprof_to_folded(&raw_bytes) {
        Some(folded) => {
            let resp = FlamegraphResponse {
                profile_id: row.profile_id,
                service: row.service,
                profile_type: row.profile_type,
                timestamp: timestamp_ms,
                format: FlamegraphFormat::Folded,
                folded: Some(folded),
                data_base64: None,
            };
            (StatusCode::OK, axum::Json(resp)).into_response()
        }
        None => {
            // folded 변환 실패 → raw base64 반환 (프론트엔드에서 @pyroscope/pprof로 파싱)
            let resp = FlamegraphResponse {
                profile_id: row.profile_id,
                service: row.service,
                profile_type: row.profile_type,
                timestamp: timestamp_ms,
                format: FlamegraphFormat::Pprof,
                folded: None,
                data_base64: Some(row.payload),
            };
            (StatusCode::OK, axum::Json(resp)).into_response()
        }
    }
}

// ---------------------------------------------------------------------------
// pprof 파싱 → folded format 변환
// ---------------------------------------------------------------------------

/// pprof binary를 folded format으로 변환한다.
///
/// Phase 4 단순화 구현:
/// - gzip 헤더 (0x1f 0x8b) 감지 → flate2로 압축 해제
/// - protobuf 디코딩은 prost + pprof.proto 없이 수동 파싱 (필드 번호 기반)
/// - 완전한 pprof 파싱이 실패하면 None 반환 → 호출자가 raw base64 반환
///
/// 성공 시 Vec<FoldedFrame> 반환
fn try_parse_pprof_to_folded(data: &[u8]) -> Option<Vec<FoldedFrame>> {
    // gzip 압축 해제
    let decompressed = if data.starts_with(&[0x1f, 0x8b]) {
        decompress_gzip(data)?
    } else {
        data.to_vec()
    };

    // pprof protobuf 수동 파싱
    // pprof.proto 구조:
    //   message Profile {
    //     repeated ValueType sample_type = 1;
    //     repeated Sample    sample      = 2;
    //     repeated Mapping   mapping     = 3;
    //     repeated Location  location    = 4;
    //     repeated Function  function    = 5;
    //     repeated string    string_table = 6;
    //     ...
    //   }
    //   message Sample {
    //     repeated uint64 location_id = 1;
    //     repeated int64  value        = 2;
    //   }
    //   message Location {
    //     uint64 id = 1;
    //     repeated Line line = 4;
    //   }
    //   message Line {
    //     uint64 function_id = 1;
    //     int64  line        = 2;
    //   }
    //   message Function {
    //     uint64 id   = 1;
    //     int64  name = 2;  // index into string_table
    //   }
    parse_pprof_proto(&decompressed)
}

/// gzip 압축을 해제한다.
fn decompress_gzip(data: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut decoder = flate2::read::GzDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).ok()?;
    Some(out)
}

// ---------------------------------------------------------------------------
// 경량 pprof protobuf 파서
// ---------------------------------------------------------------------------

/// protobuf varint를 읽는다.
/// (buf, offset) → (value, new_offset)
fn read_varint(buf: &[u8], offset: usize) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    let mut pos = offset;
    loop {
        if pos >= buf.len() {
            return None;
        }
        let byte = buf[pos];
        pos += 1;
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 64 {
            return None; // overflow guard
        }
    }
    Some((result, pos))
}

/// protobuf LEN 필드(string/bytes/embedded message)를 읽어 슬라이스를 반환한다.
fn read_len_delimited<'a>(buf: &'a [u8], offset: usize) -> Option<(&'a [u8], usize)> {
    let (len, pos) = read_varint(buf, offset)?;
    let end = pos + len as usize;
    if end > buf.len() {
        return None;
    }
    Some((&buf[pos..end], end))
}

/// 경량 pprof protobuf 파서.
///
/// pprof.proto의 핵심 필드만 추출하여 folded format을 생성한다.
/// 완전한 파서가 아니므로 일부 pprof 파일에서 실패할 수 있다 (None 반환).
fn parse_pprof_proto(data: &[u8]) -> Option<Vec<FoldedFrame>> {
    // 파싱할 구조체들
    let mut string_table: Vec<String> = Vec::new();
    let mut functions: std::collections::HashMap<u64, i64> = std::collections::HashMap::new(); // id → name_idx
    let mut locations: std::collections::HashMap<u64, Vec<u64>> = std::collections::HashMap::new(); // id → [function_id]
    let mut samples: Vec<(Vec<u64>, i64)> = Vec::new(); // (location_ids, value)

    let mut pos = 0usize;

    while pos < data.len() {
        let (tag_wire, new_pos) = read_varint(data, pos)?;
        pos = new_pos;

        let field_number = tag_wire >> 3;
        let wire_type = tag_wire & 0x7;

        match (field_number, wire_type) {
            // field 2: Sample (LEN)
            (2, 2) => {
                let (sample_bytes, new_pos) = read_len_delimited(data, pos)?;
                pos = new_pos;
                if let Some((loc_ids, value)) = parse_sample(sample_bytes) {
                    samples.push((loc_ids, value));
                }
            }
            // field 4: Location (LEN)
            (4, 2) => {
                let (loc_bytes, new_pos) = read_len_delimited(data, pos)?;
                pos = new_pos;
                if let Some((loc_id, func_ids)) = parse_location(loc_bytes) {
                    locations.insert(loc_id, func_ids);
                }
            }
            // field 5: Function (LEN)
            (5, 2) => {
                let (func_bytes, new_pos) = read_len_delimited(data, pos)?;
                pos = new_pos;
                if let Some((func_id, name_idx)) = parse_function(func_bytes) {
                    functions.insert(func_id, name_idx);
                }
            }
            // field 6: string_table (LEN)
            (6, 2) => {
                let (s_bytes, new_pos) = read_len_delimited(data, pos)?;
                pos = new_pos;
                string_table.push(String::from_utf8_lossy(s_bytes).into_owned());
            }
            // 나머지 필드: wire type에 따라 skip
            (_, 0) => {
                let (_, new_pos) = read_varint(data, pos)?;
                pos = new_pos;
            }
            (_, 1) => {
                pos = pos.checked_add(8)?;
                if pos > data.len() { return None; }
            }
            (_, 2) => {
                let (_, new_pos) = read_len_delimited(data, pos)?;
                pos = new_pos;
            }
            (_, 5) => {
                pos = pos.checked_add(4)?;
                if pos > data.len() { return None; }
            }
            _ => {
                // 알 수 없는 wire type — 파싱 포기
                return None;
            }
        }
    }

    if string_table.is_empty() || samples.is_empty() {
        return None;
    }

    // folded format 생성
    let mut folded: Vec<FoldedFrame> = Vec::with_capacity(samples.len());

    for (loc_ids, value) in &samples {
        // location_ids 순서를 역순으로 (leaf → root → root가 앞에 오도록)
        let mut stack_parts: Vec<String> = Vec::new();
        for &loc_id in loc_ids.iter() {
            if let Some(func_ids) = locations.get(&loc_id) {
                for &func_id in func_ids {
                    if let Some(&name_idx) = functions.get(&func_id) {
                        if name_idx >= 0 && (name_idx as usize) < string_table.len() {
                            let name = &string_table[name_idx as usize];
                            if !name.is_empty() {
                                stack_parts.push(name.clone());
                            }
                        }
                    }
                }
            }
        }
        if !stack_parts.is_empty() {
            folded.push(FoldedFrame {
                stack: stack_parts.join(";"),
                value: *value,
            });
        }
    }

    if folded.is_empty() {
        None
    } else {
        Some(folded)
    }
}

/// Sample 메시지 파싱: (location_ids, first_value)
fn parse_sample(data: &[u8]) -> Option<(Vec<u64>, i64)> {
    let mut loc_ids: Vec<u64> = Vec::new();
    let mut values: Vec<i64> = Vec::new();
    let mut pos = 0usize;

    while pos < data.len() {
        let (tag_wire, new_pos) = read_varint(data, pos)?;
        pos = new_pos;
        let field_number = tag_wire >> 3;
        let wire_type = tag_wire & 0x7;

        match (field_number, wire_type) {
            // field 1: location_id (packed varint 또는 repeated varint)
            (1, 2) => {
                let (packed, new_pos) = read_len_delimited(data, pos)?;
                pos = new_pos;
                let mut ppos = 0;
                while ppos < packed.len() {
                    let (v, np) = read_varint(packed, ppos)?;
                    ppos = np;
                    loc_ids.push(v);
                }
            }
            (1, 0) => {
                let (v, new_pos) = read_varint(data, pos)?;
                pos = new_pos;
                loc_ids.push(v);
            }
            // field 2: value (int64, wire type 0)
            (2, 0) => {
                let (v, new_pos) = read_varint(data, pos)?;
                pos = new_pos;
                values.push(v as i64);
            }
            // 나머지 skip
            (_, 0) => { let (_, np) = read_varint(data, pos)?; pos = np; }
            (_, 2) => { let (_, np) = read_len_delimited(data, pos)?; pos = np; }
            _ => break,
        }
    }

    let value = values.first().copied().unwrap_or(1);
    Some((loc_ids, value))
}

/// Location 메시지 파싱: (id, function_ids)
fn parse_location(data: &[u8]) -> Option<(u64, Vec<u64>)> {
    let mut id: u64 = 0;
    let mut func_ids: Vec<u64> = Vec::new();
    let mut pos = 0usize;

    while pos < data.len() {
        let (tag_wire, new_pos) = read_varint(data, pos)?;
        pos = new_pos;
        let field_number = tag_wire >> 3;
        let wire_type = tag_wire & 0x7;

        match (field_number, wire_type) {
            // field 1: id
            (1, 0) => { let (v, np) = read_varint(data, pos)?; pos = np; id = v; }
            // field 4: line (LEN) — Line.function_id는 field 1
            (4, 2) => {
                let (line_bytes, np) = read_len_delimited(data, pos)?;
                pos = np;
                if let Some(func_id) = parse_line_function_id(line_bytes) {
                    func_ids.push(func_id);
                }
            }
            (_, 0) => { let (_, np) = read_varint(data, pos)?; pos = np; }
            (_, 2) => { let (_, np) = read_len_delimited(data, pos)?; pos = np; }
            _ => break,
        }
    }

    Some((id, func_ids))
}

/// Line 메시지에서 function_id(field 1)만 추출
fn parse_line_function_id(data: &[u8]) -> Option<u64> {
    let mut pos = 0usize;
    while pos < data.len() {
        let (tag_wire, new_pos) = read_varint(data, pos)?;
        pos = new_pos;
        let field_number = tag_wire >> 3;
        let wire_type = tag_wire & 0x7;
        match (field_number, wire_type) {
            (1, 0) => { let (v, _) = read_varint(data, pos)?; return Some(v); }
            (_, 0) => { let (_, np) = read_varint(data, pos)?; pos = np; }
            (_, 2) => { let (_, np) = read_len_delimited(data, pos)?; pos = np; }
            _ => break,
        }
    }
    None
}

/// Function 메시지 파싱: (id, name index into string_table)
fn parse_function(data: &[u8]) -> Option<(u64, i64)> {
    let mut id: u64 = 0;
    let mut name_idx: i64 = 0;
    let mut pos = 0usize;

    while pos < data.len() {
        let (tag_wire, new_pos) = read_varint(data, pos)?;
        pos = new_pos;
        let field_number = tag_wire >> 3;
        let wire_type = tag_wire & 0x7;

        match (field_number, wire_type) {
            // field 1: id
            (1, 0) => { let (v, np) = read_varint(data, pos)?; pos = np; id = v; }
            // field 2: name (int64 — string_table 인덱스)
            (2, 0) => { let (v, np) = read_varint(data, pos)?; pos = np; name_idx = v as i64; }
            (_, 0) => { let (_, np) = read_varint(data, pos)?; pos = np; }
            (_, 2) => { let (_, np) = read_len_delimited(data, pos)?; pos = np; }
            _ => break,
        }
    }

    Some((id, name_idx))
}
