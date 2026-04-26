#!/usr/bin/env bash
# verify-stack.sh — verify datacat's local demo stack before recording or judging.
#
# This script is intentionally read-only: it does not start, stop, seed, or mutate
# services. Run ./scripts/dev.sh first, then run this script until all required
# checks pass.

set -euo pipefail

TIMEOUT="${DATACAT_VERIFY_TIMEOUT:-3}"
API_URL="${DATACAT_API_URL:-http://localhost:8000}"
QUERY_URL="${DATACAT_QUERY_URL:-http://localhost:8001}"
ALERTING_URL="${DATACAT_ALERTING_URL:-http://localhost:9090}"
INSIGHTS_URL="${DATACAT_INSIGHTS_URL:-http://localhost:9091}"
ADMIN_URL="${DATACAT_ADMIN_URL:-http://localhost:9093}"
WEB_URL="${DATACAT_WEB_URL:-http://localhost:3000}"
CLICKHOUSE_URL="${DATACAT_CLICKHOUSE_URL:-http://localhost:8123}"
REDPANDA_ADMIN_URL="${DATACAT_REDPANDA_ADMIN_URL:-http://localhost:9644}"
COLLECTOR_HTTP_URL="${DATACAT_COLLECTOR_HTTP_URL:-http://localhost:4318}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

PASS=0
FAIL=0
WARN=0

ok() { printf "${GREEN}PASS${RESET} %s\n" "$*"; PASS=$((PASS + 1)); }
fail() { printf "${RED}FAIL${RESET} %s\n" "$*"; FAIL=$((FAIL + 1)); }
warn() { printf "${YELLOW}WARN${RESET} %s\n" "$*"; WARN=$((WARN + 1)); }
info() { printf "${CYAN}INFO${RESET} %s\n" "$*"; }

check_http() {
  local name="$1"
  local url="$2"
  local expected="${3:-}"

  local body
  local status
  body="$(mktemp)"
  status="$(curl -sS --max-time "${TIMEOUT}" -o "${body}" -w '%{http_code}' "${url}" 2>/dev/null || true)"

  if [[ "${status}" =~ ^2|3 ]]; then
    if [[ -n "${expected}" ]] && ! grep -q "${expected}" "${body}"; then
      fail "${name}: ${url} returned HTTP ${status}, but body did not contain '${expected}'"
      rm -f "${body}"
      return
    fi
    ok "${name}: ${url} returned HTTP ${status}"
  else
    fail "${name}: ${url} returned HTTP ${status:-000}"
    if [[ -s "${body}" ]]; then
      sed 's/^/      /' "${body}" | head -5
    fi
  fi
  rm -f "${body}"
}

check_tcp() {
  local name="$1"
  local host="$2"
  local port="$3"

  if command -v nc >/dev/null 2>&1; then
    if nc -z -w "${TIMEOUT}" "${host}" "${port}" >/dev/null 2>&1; then
      ok "${name}: ${host}:${port} accepts TCP connections"
    else
      fail "${name}: ${host}:${port} is not accepting TCP connections"
    fi
  else
    warn "${name}: nc not installed; skipping TCP check for ${host}:${port}"
  fi
}

info "Checking datacat local stack (timeout=${TIMEOUT}s)"

check_http "ClickHouse" "${CLICKHOUSE_URL}/ping" "Ok"
check_http "Redpanda Admin" "${REDPANDA_ADMIN_URL}/v1/cluster/health_overview"
check_tcp "Redpanda Kafka" "localhost" "9092"
check_tcp "Collector OTLP/gRPC" "localhost" "4317"
check_tcp "Collector OTLP/HTTP" "localhost" "4318"

# Collector OTLP HTTP does not expose /health today; a 404 is acceptable as long
# as the TCP port is open. Keep this as WARN instead of FAIL to avoid requiring
# a product change before demos.
collector_status="$(curl -sS --max-time "${TIMEOUT}" -o /dev/null -w '%{http_code}' "${COLLECTOR_HTTP_URL}/health" 2>/dev/null || true)"
if [[ "${collector_status}" == "200" ]]; then
  ok "Collector HTTP health endpoint exists"
else
  warn "Collector HTTP /health returned ${collector_status:-000}; TCP check above is the source of truth for now"
fi

check_http "Query service" "${QUERY_URL}/health"
check_http "API gateway" "${API_URL}/health" "ok"
check_http "Alerting" "${ALERTING_URL}/health" "ok"
check_http "Insights" "${INSIGHTS_URL}/health" "ok"
check_http "Admin" "${ADMIN_URL}/health" "datacat-admin"
check_http "Web dashboard" "${WEB_URL}"

printf "\nSummary: ${GREEN}%d pass${RESET}, ${YELLOW}%d warn${RESET}, ${RED}%d fail${RESET}\n" "${PASS}" "${WARN}" "${FAIL}"

if [[ "${FAIL}" -gt 0 ]]; then
  cat <<'EOF'

Some required demo checks failed.
Suggested recovery:
  1. Start infra:       make dev-db
  2. Start full stack:  ./scripts/dev.sh
  3. If schema drift appears, reset local volumes only after confirming data is disposable:
       make clean && ./scripts/dev.sh
EOF
  exit 1
fi

if [[ "${WARN}" -gt 0 ]]; then
  exit 2
fi
