#!/usr/bin/env bash
# quickstart.sh — One-command local setup for datacat
# Usage: ./scripts/quickstart.sh
#
# Brings up the core infra (Redpanda + ClickHouse + OTel Collector) and
# prints instructions for starting the Rust services and web dev server.

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

# ─── 1. Dependency checks ─────────────────────────────────────────────────────
info "Checking dependencies..."

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    fatal "'$1' is not installed. $2"
  fi
}

check_cmd docker   "Install Docker Desktop: https://docs.docker.com/get-docker/"
check_cmd curl     "Install curl via your package manager."

# Docker Compose V2 (built-in plugin) or V1 standalone
if docker compose version &>/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  fatal "Docker Compose is not available. Install Docker Desktop or docker-compose."
fi

success "All dependencies found."

# ─── 2. Start infra (dev profile: redpanda + clickhouse + otel-collector) ────
info "Starting infra services (Redpanda, ClickHouse, OTel Collector)..."
cd "${REPO_ROOT}/deploy"

${COMPOSE} --profile dev up -d redpanda clickhouse redpanda-init collector

# ─── 3. Wait for ClickHouse health ────────────────────────────────────────────
info "Waiting for ClickHouse to become healthy (up to 60s)..."

TIMEOUT=60
ELAPSED=0
until curl -sf "http://localhost:8123/ping" > /dev/null 2>&1; do
  if [ "${ELAPSED}" -ge "${TIMEOUT}" ]; then
    fatal "ClickHouse did not become healthy within ${TIMEOUT}s. Check: docker compose logs clickhouse"
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
  printf '.'
done
echo ""
success "ClickHouse is healthy."

# ─── 4. Success banner ────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Infra is up and running!${RESET}"
echo ""
echo -e "  ${BOLD}Redpanda (Kafka)${RESET}    localhost:${CYAN}9092${RESET}"
echo -e "  ${BOLD}Redpanda Admin${RESET}      localhost:${CYAN}9644${RESET}"
echo -e "  ${BOLD}Redpanda Schema Reg${RESET} localhost:${CYAN}8081${RESET}"
echo -e "  ${BOLD}ClickHouse HTTP${RESET}     localhost:${CYAN}8123${RESET}"
echo -e "  ${BOLD}ClickHouse Native${RESET}   localhost:${CYAN}9000${RESET}"
echo -e "  ${BOLD}OTLP gRPC${RESET}           localhost:${CYAN}4317${RESET}"
echo -e "  ${BOLD}OTLP HTTP${RESET}           localhost:${CYAN}4318${RESET}"
echo ""

# ─── 5. Instructions for Rust services and web ────────────────────────────────
echo -e "${BOLD}To start the Rust services and web dev server, run:${RESET}"
echo ""
echo -e "  ${YELLOW}# In separate terminals (or use scripts/dev.sh for all-in-one):${RESET}"
echo ""
echo -e "  cargo run -p datacat-collector &"
echo -e "  cargo run -p datacat-ingester  &"
echo -e "  cargo run -p datacat-query     &"
echo -e "  cargo run -p datacat-api       &"
echo -e "  cargo run -p datacat-alerting  &"
echo -e "  cargo run -p datacat-insights  &"
echo -e "  cargo run -p datacat-admin     &"
echo ""
echo -e "  cd web && npm install && npm run dev"
echo ""
echo -e "${YELLOW}Tip:${RESET} Run ${BOLD}./scripts/dev.sh${RESET} to start everything at once with a single Ctrl+C to stop."
echo ""
