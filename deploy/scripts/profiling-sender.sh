#!/usr/bin/env bash
# =============================================================================
# datacat Profiling Sender — pprof / JFR 주기적 수집 및 전송
# =============================================================================
# datacat-profiling.service 에서 실행되거나 직접 실행 가능.
#
# 환경변수:
#   DATACAT_HOST      — datacat collector (예: datacat.example.com:4317)
#   DATACAT_SERVICE   — 서비스 이름
#   DATACAT_ENV       — 환경 (기본: production)
#   DATACAT_TENANT    — 테넌트 ID (기본: default)
#   DATACAT_LANG      — java | go
#   PROFILE_INTERVAL  — 수집 주기 초 (기본: 60)
#
# Go: PPROF_HOST, PPROF_PORT (기본: localhost:6060)
# Java: JVM_PID 또는 JFR_DURATION (기본: 30초)
# =============================================================================

set -euo pipefail

DATACAT_HOST="${DATACAT_HOST:-localhost:4317}"
DATACAT_SERVICE="${DATACAT_SERVICE:-unknown}"
DATACAT_ENV="${DATACAT_ENV:-production}"
DATACAT_TENANT="${DATACAT_TENANT:-default}"
DATACAT_LANG="${DATACAT_LANG:-go}"
PROFILE_INTERVAL="${PROFILE_INTERVAL:-60}"

COLLECTOR_HOST="${DATACAT_HOST%%:*}"
PROFILES_URL="http://${COLLECTOR_HOST}:4318/api/v1/profiles"

info() { echo "[profiling-sender] $*"; }
error() { echo "[profiling-sender] ERROR: $*" >&2; }

# ─── Go pprof 수집 ────────────────────────────────────────────────────────────
send_go_profile() {
  local pprof_host="${PPROF_HOST:-localhost}"
  local pprof_port="${PPROF_PORT:-6060}"
  local profile_type="${1:-cpu}"
  local duration="${2:-30}"

  local url="http://${pprof_host}:${pprof_port}/debug/pprof"

  case "$profile_type" in
    cpu)      url="${url}/profile?seconds=${duration}" ;;
    heap)     url="${url}/heap" ;;
    goroutine) url="${url}/goroutine" ;;
    block)    url="${url}/block" ;;
    mutex)    url="${url}/mutex" ;;
    *)        url="${url}/profile?seconds=${duration}" ;;
  esac

  info "Go ${profile_type} 프로파일 수집: ${url}"

  local tmpfile
  tmpfile=$(mktemp /tmp/datacat-pprof-XXXXXX.pprof)
  trap "rm -f ${tmpfile}" EXIT

  if ! curl -sSf --max-time $((duration + 10)) "$url" -o "$tmpfile" 2>/dev/null; then
    error "pprof 엔드포인트 연결 실패 (${url}) — net/http/pprof 가 활성화되어 있는지 확인하세요"
    return 1
  fi

  local size
  size=$(wc -c < "$tmpfile")
  if [[ "$size" -eq 0 ]]; then
    error "빈 pprof 응답"
    return 1
  fi

  curl -sSf -X POST "$PROFILES_URL" \
    -H "Content-Type: application/octet-stream" \
    -H "X-Datacat-Service: ${DATACAT_SERVICE}" \
    -H "X-Datacat-Type: ${profile_type}" \
    -H "X-Datacat-Env: ${DATACAT_ENV}" \
    -H "X-Datacat-Tenant: ${DATACAT_TENANT}" \
    --data-binary "@${tmpfile}" \
    --max-time 30 \
    > /dev/null

  info "Go ${profile_type} 전송 완료 (${size} bytes)"
}

# ─── Java JFR 수집 ───────────────────────────────────────────────────────────
send_java_profile() {
  local jfr_duration="${JFR_DURATION:-30}"
  local pid="${JVM_PID:-}"

  # PID 자동 감지 (DATACAT_SERVICE 이름으로)
  if [[ -z "$pid" ]]; then
    pid=$(pgrep -f "Dotel.service.name=${DATACAT_SERVICE}" 2>/dev/null | head -1 || true)
  fi
  if [[ -z "$pid" ]]; then
    pid=$(jps 2>/dev/null | grep -v Jps | awk '{print $1}' | head -1 || true)
  fi
  if [[ -z "$pid" ]]; then
    error "JVM 프로세스를 찾을 수 없습니다. JVM_PID를 명시하세요."
    return 1
  fi

  local tmpjfr
  tmpjfr=$(mktemp /tmp/datacat-jfr-XXXXXX.jfr)
  trap "rm -f ${tmpjfr}" EXIT

  info "Java JFR 수집: PID=${pid}, 기간=${jfr_duration}s"

  # jcmd로 JFR 녹화
  if ! command -v jcmd &>/dev/null; then
    error "jcmd가 필요합니다 (JDK 설치 확인)"
    return 1
  fi

  local rec_name="datacat_$(date +%s)"
  jcmd "$pid" JFR.start name="${rec_name}" duration="${jfr_duration}s" filename="${tmpjfr}" 2>/dev/null || {
    error "JFR 시작 실패"
    return 1
  }

  sleep $((jfr_duration + 2))

  local size
  size=$(wc -c < "$tmpjfr" 2>/dev/null || echo 0)
  if [[ "$size" -eq 0 ]]; then
    error "JFR 파일이 비어 있습니다"
    return 1
  fi

  curl -sSf -X POST "$PROFILES_URL" \
    -H "Content-Type: application/octet-stream" \
    -H "X-Datacat-Service: ${DATACAT_SERVICE}" \
    -H "X-Datacat-Type: cpu" \
    -H "X-Datacat-Env: ${DATACAT_ENV}" \
    -H "X-Datacat-Tenant: ${DATACAT_TENANT}" \
    --data-binary "@${tmpjfr}" \
    --max-time 60 \
    > /dev/null

  info "Java JFR 전송 완료 (${size} bytes)"
}

# ─── 메인 루프 ────────────────────────────────────────────────────────────────
info "프로파일링 에이전트 시작 — 서비스: ${DATACAT_SERVICE}, 언어: ${DATACAT_LANG}, 주기: ${PROFILE_INTERVAL}s"

while true; do
  case "$DATACAT_LANG" in
    go)
      send_go_profile "cpu"  30  || true
      send_go_profile "heap"  0  || true
      send_go_profile "goroutine" 0 || true
      ;;
    java)
      send_java_profile || true
      ;;
    *)
      error "프로파일링 미지원 언어: ${DATACAT_LANG} (go | java만 지원)"
      exit 1
      ;;
  esac

  info "다음 수집까지 ${PROFILE_INTERVAL}초 대기..."
  sleep "$PROFILE_INTERVAL"
done
