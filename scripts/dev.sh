#!/usr/bin/env bash
# dev.sh — Full local development environment for datacat
# Usage: ./scripts/dev.sh
#
# Starts all infra, all Rust services, and the web dev server.
# Press Ctrl+C to stop everything cleanly.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ─── Colour helpers ───────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${CYAN}[datacat]${RESET} $*"; }
success() { echo -e "${GREEN}[datacat]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[datacat]${RESET} $*"; }
fatal()   { echo -e "${RED}[datacat] ERROR:${RESET} $*" >&2; exit 1; }

# Track background PIDs for cleanup
PIDS=()

cleanup() {
  echo ""
  info "Shutting down all services..."
  for pid in "${PIDS[@]}"; do
    if kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  info "All services stopped. Goodbye."
}

trap cleanup SIGINT SIGTERM EXIT

# ─── 1. Check cmake (required for rdkafka cmake-build feature) ───────────────
info "Checking prerequisites..."

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    fatal "'$1' is not installed. $2"
  fi
}

check_cmd cmake  "Install cmake: 'brew install cmake' (macOS) or 'sudo apt-get install cmake' (Linux)."
check_cmd cargo  "Install Rust: https://rustup.rs"
check_cmd docker "Install Docker Desktop: https://docs.docker.com/get-docker/"
check_cmd node   "Install Node.js 20+: https://nodejs.org"
check_cmd npm    "npm should be bundled with Node.js."
check_cmd curl   "Install curl via your package manager."

# Docker Compose V2 or V1
if docker compose version &>/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  fatal "Docker Compose not found."
fi

success "Prerequisites OK."

# ─── 2. Start infra ───────────────────────────────────────────────────────────
info "Starting infra (Redpanda + ClickHouse + OTel Collector)..."
cd "${REPO_ROOT}/deploy"
${COMPOSE} --profile dev up -d redpanda clickhouse redpanda-init collector

# ─── 3. Wait for healthchecks ─────────────────────────────────────────────────
info "Waiting for ClickHouse (up to 90s)..."
TIMEOUT=90
ELAPSED=0
until curl -sf "http://localhost:8123/ping" > /dev/null 2>&1; do
  if [ "${ELAPSED}" -ge "${TIMEOUT}" ]; then
    fatal "ClickHouse not healthy after ${TIMEOUT}s. Check: ${COMPOSE} logs clickhouse"
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  printf '.'
done
echo ""
success "ClickHouse healthy."

info "Waiting for Redpanda (up to 60s)..."
ELAPSED=0
until curl -sf "http://localhost:9644/v1/cluster/health_overview" > /dev/null 2>&1; do
  if [ "${ELAPSED}" -ge "60" ]; then
    warn "Redpanda health check timed out — continuing anyway."
    break
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  printf '.'
done
echo ""
success "Redpanda ready."

# ─── 4. Start Rust services in background ─────────────────────────────────────
cd "${REPO_ROOT}"

# Common environment variables for all services
export RUST_LOG="${RUST_LOG:-info}"
export DATACAT_KAFKA_BROKERS="localhost:9092"
export DATACAT_CLICKHOUSE_URL="http://localhost:8123"
export DATACAT_CLICKHOUSE_USER="datacat"
export DATACAT_CLICKHOUSE_PASSWORD="datacat_dev"

info "Building and starting Rust services..."

start_service() {
  local crate="$1"
  local extra_env="${2:-}"

  info "  Starting ${crate}..."
  if [ -n "${extra_env}" ]; then
    env ${extra_env} cargo run -p "${crate}" >> "${REPO_ROOT}/.dev-logs/${crate}.log" 2>&1 &
  else
    cargo run -p "${crate}" >> "${REPO_ROOT}/.dev-logs/${crate}.log" 2>&1 &
  fi
  PIDS+=($!)
}

mkdir -p "${REPO_ROOT}/.dev-logs"

start_service "datacat-collector"
start_service "datacat-ingester"
start_service "datacat-query"   "DATACAT_LISTEN_ADDR=0.0.0.0:8001"
start_service "datacat-api"     "DATACAT_LISTEN_ADDR=0.0.0.0:8000 DATACAT_QUERY_SERVICE_URL=http://localhost:8001 DATACAT_INSIGHTS_SERVICE_URL=http://localhost:9091 DATACAT_ADMIN_URL=http://localhost:9092"
start_service "datacat-alerting"  "DATACAT_LISTEN_ADDR=0.0.0.0:9090"
start_service "datacat-insights"  "DATACAT_LISTEN_ADDR=0.0.0.0:9091"
start_service "datacat-admin"     "DATACAT_LISTEN_ADDR=0.0.0.0:9092 DATACAT_LICENSE_SECRET=dev_secret"

# Give services a moment to start compiling / binding ports
sleep 2

# ─── 5. Start web dev server ──────────────────────────────────────────────────
info "Starting web dev server..."
cd "${REPO_ROOT}/web"
if [ ! -d node_modules ]; then
  info "  Running npm install first..."
  npm install
fi
npm run dev >> "${REPO_ROOT}/.dev-logs/web.log" 2>&1 &
PIDS+=($!)

# ─── 6. Print service table ───────────────────────────────────────────────────
sleep 2
echo ""
echo -e "${BOLD}${GREEN}datacat dev environment is up!${RESET}"
echo ""
printf "  %-26s %-24s %s\n" "SERVICE" "ADDRESS" "LOG"
printf "  %-26s %-24s %s\n" "-------" "-------" "---"
printf "  ${CYAN}%-26s${RESET} %-24s %s\n" "datacat-collector"  "localhost:4317 / 4318"  ".dev-logs/datacat-collector.log"
printf "  ${CYAN}%-26s${RESET} %-24s %s\n" "datacat-ingester"   "(background consumer)" ".dev-logs/datacat-ingester.log"
printf "  ${CYAN}%-26s${RESET} %-24s %s\n" "datacat-query"      "localhost:8001"         ".dev-logs/datacat-query.log"
printf "  ${CYAN}%-26s${RESET} %-24s %s\n" "datacat-api"        "localhost:8000"         ".dev-logs/datacat-api.log"
printf "  ${CYAN}%-26s${RESET} %-24s %s\n" "datacat-alerting"   "localhost:9090"         ".dev-logs/datacat-alerting.log"
printf "  ${CYAN}%-26s${RESET} %-24s %s\n" "datacat-insights"   "localhost:9091"         ".dev-logs/datacat-insights.log"
printf "  ${CYAN}%-26s${RESET} %-24s %s\n" "datacat-admin"      "localhost:9092"         ".dev-logs/datacat-admin.log"
printf "  ${YELLOW}%-26s${RESET} %-24s %s\n" "web (Vite dev)"     "localhost:5173"         ".dev-logs/web.log"
echo ""
printf "  ${BOLD}%-26s${RESET} %-24s\n" "ClickHouse HTTP"   "localhost:8123"
printf "  ${BOLD}%-26s${RESET} %-24s\n" "Redpanda (Kafka)"  "localhost:9092"
printf "  ${BOLD}%-26s${RESET} %-24s\n" "Redpanda Admin"    "localhost:9644"
echo ""
echo -e "${YELLOW}Tip:${RESET} Tail a service log: tail -f .dev-logs/<service>.log"
echo -e "${YELLOW}Tip:${RESET} Press ${BOLD}Ctrl+C${RESET} to stop all services."
echo ""

# ─── 7. Wait for all background jobs ─────────────────────────────────────────
wait
