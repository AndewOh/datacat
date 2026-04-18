# Contributing to datacat

## Prerequisites

| Tool | Minimum Version | Notes |
|------|----------------|-------|
| Rust | 1.82 | Install via [rustup](https://rustup.rs) |
| cmake | any recent | Required to build `rdkafka` (cmake-build feature) |
| Docker + Compose | Docker 24+ | Docker Desktop bundles Compose V2 |
| Node.js | 20 | Required for the web frontend |
| npm | bundled with Node | Used for web dependencies |

**macOS:** `brew install cmake` then `rustup update stable`
**Ubuntu/Debian:** `sudo apt-get install cmake libssl-dev pkg-config`

## Dev Setup

```bash
git clone https://github.com/datacat-io/datacat.git
cd datacat

# Start infra + print service instructions (quickest path):
./scripts/quickstart.sh

# Or start everything (infra + all services + web) in one command:
./scripts/dev.sh
```

`scripts/quickstart.sh` brings up only the infrastructure (Redpanda, ClickHouse, OTel Collector) and prints the commands to run each service. `scripts/dev.sh` starts everything including all Rust services and the Vite dev server, and kills everything on Ctrl+C.

## Architecture Overview

datacat is a Rust workspace with 10 crates:

**`crates/datacat-proto`** — Shared Protobuf/gRPC definitions and generated code. All service-to-service gRPC contracts live here. Depends only on `prost` and `tonic`.

**`crates/datacat-common`** — Cross-cutting utilities: configuration loading (via the `config` crate), structured logging setup, error types (`thiserror`), and shared domain models (Span, Log, Metric, Profile value objects).

**`crates/datacat-schema`** — ClickHouse DDL and schema migration logic. Owns the canonical table definitions for `spans`, `logs`, `metrics`, and `profiles`. Applied at service startup or via the admin CLI.

**`crates/datacat-collector`** — OTLP ingestion gateway. Accepts telemetry over gRPC (port 4317) and HTTP (port 4318), validates and normalises signals, then publishes to Redpanda topics (`datacat.spans`, `datacat.logs`, `datacat.metrics`, `datacat.profiles`).

**`crates/datacat-ingester`** — Kafka consumer that reads from Redpanda topics and bulk-inserts into ClickHouse using the async inserter. Handles back-pressure, retries, and DLQ routing.

**`crates/datacat-query`** — Query execution engine. Exposes an Arrow Flight gRPC interface and an HTTP/JSON API for running trace, log, metric, and profile queries against ClickHouse. Implements distributed query planning and column pruning.

**`crates/datacat-api`** — Public HTTP API gateway (Axum). Handles authentication, authorization, rate limiting, and fan-out to the query, insights, and admin services. This is the only service exposed to the browser and external clients.

**`crates/datacat-alerting`** — Alert rule evaluation, notification routing, and incident management. Polls ClickHouse on configurable schedules, evaluates threshold/anomaly conditions, and dispatches to configured channels (PagerDuty, Slack, webhook).

**`crates/datacat-insights`** — AI Auto-Ops engine. Runs anomaly detection, root-cause correlation, and automated runbook suggestions. Integrates with LLM providers via a pluggable backend.

**`crates/datacat-admin`** — Tenant management, license enforcement, and platform configuration. Exposes an internal gRPC API consumed by `datacat-api`.

## Running Tests

```bash
# Run all unit tests across the workspace
cargo test --workspace

# Run tests for a single crate
cargo test -p datacat-query

# Run a specific test
cargo test -p datacat-common -- config::tests::
```

Integration tests (requiring live ClickHouse + Redpanda) are tagged `#[ignore]` and excluded from CI. Run them locally:

```bash
# Start infra first
./scripts/quickstart.sh

# Run integration tests
cargo test --workspace -- --include-ignored integration
```

## Code Style & Linting

```bash
# Rust formatting (must pass before merge)
cargo fmt --all

# Clippy — all warnings are errors in CI
cargo clippy --workspace -- -D warnings

# TypeScript type check (must pass before merge)
cd web && npx tsc --noEmit

# Frontend build smoke test
cd web && npm run build
```

## PR Guidelines

1. **Clippy must pass.** `cargo clippy --workspace -- -D warnings` must exit 0.
2. **TypeScript must type-check.** `cd web && npx tsc --noEmit` must exit 0.
3. **Tests must pass.** `cargo test --workspace` must exit 0.
4. **Formatting.** Run `cargo fmt --all` before pushing. The CI `cargo fmt --all --check` step will fail if there are formatting differences.
5. **One logical change per PR.** Keep PRs focused; large refactors should be discussed in an issue first.
6. **Commit messages.** Use the imperative mood: "Add span deduplication" not "Added span deduplication".
7. **No unsafe without justification.** If you need `unsafe`, document the invariant in a comment above the block.

## Submitting a PR

```bash
# Create a feature branch
git checkout -b feat/my-feature

# Make changes, then verify locally
cargo fmt --all
cargo clippy --workspace -- -D warnings
cargo test --workspace
cd web && npx tsc --noEmit && npm run build && cd ..

# Push and open PR
git push -u origin feat/my-feature
gh pr create --fill
```

The CI pipeline (`ci.yml`) will run `rust-check`, `rust-test`, `frontend-check`, and `security-audit` automatically on every PR.
