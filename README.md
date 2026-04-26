# datacat

**Rust-native observability platform with Jennifer-style X-View, Datadog-style telemetry, and AI-assisted root cause analysis.**

`datacat` ingests OpenTelemetry traces, logs, metrics, and profiles through a Rust collector, moves them through Redpanda, stores them in ClickHouse, and visualizes incidents in a React dashboard. The contest demo focuses on one flow: **latency spike → X-View pattern → correlated logs/traces → AI incident summary/runbook**.

---

## Why datacat?

Modern teams already collect too much telemetry, but incident diagnosis is still slow:

- dashboards are scattered across traces, logs, metrics, and alerts;
- high-cardinality telemetry becomes expensive quickly;
- most OSS APM stacks are Go/JVM-heavy and can show p99 latency under pressure;
- managers and engineers need an answer, not just another chart.

`datacat` experiments with a performance-first architecture:

- **Rust hot path** for collector, ingestion, query, alerting, admin, and insights services;
- **OpenTelemetry-first** ingest so existing apps can send data without vendor lock-in;
- **Redpanda + ClickHouse** for low-latency buffering and columnar analytics;
- **X-View** heatmap UX inspired by Jennifer APM for instant visual anomaly detection;
- **AI Insights** to explain incidents and draft runbooks from correlated telemetry.

---

## Current status

This repository is an active PoC/MVP, not a polished production release yet.

| Area | Status |
|---|---|
| Rust workspace | Builds successfully across 10 crates |
| Collector | OTLP gRPC, OTLP HTTP, StatsD, profiling ingest paths implemented |
| Ingester | Redpanda/Kafka consumers and ClickHouse writers for spans/logs/metrics/profiles |
| Query service | X-View, logs, metrics, services, profiling, log metric APIs |
| API gateway | Front-door routing, install script serving, auth/proxy layer |
| Alerting | Monitor/incident API and evaluator skeleton |
| Insights | Anomaly, X-View pattern, and chat/runbook APIs |
| Admin | Tenant/license/API-key service with health endpoint |
| Web UI | React/Vite dashboard, landing page, X-View, logs, metrics, profiling, insights views |
| Deployment | Docker Compose, Dockerfiles, Helm/Kubernetes scaffolding |
| Tests | Rust + web tests pass, but backend integration coverage is still incomplete |

Known gaps are documented below so judges and contributors can distinguish implemented MVP features from roadmap items.

---

## Architecture

```text
Target apps / OTel SDKs
        │
        ▼
┌─────────────────────┐        ┌────────────┐        ┌──────────────┐
│ datacat-collector   │ ─────▶ │ Redpanda   │ ─────▶ │ datacat-     │
│ OTLP gRPC/HTTP      │        │ Kafka API  │        │ ingester     │
│ StatsD / profiles   │        └────────────┘        └──────┬───────┘
└─────────────────────┘                                      │
                                                               ▼
                                                        ┌──────────────┐
                                                        │ ClickHouse   │
                                                        │ spans/logs/  │
                                                        │ metrics/etc. │
                                                        └──────┬───────┘
                                                               │
           ┌──────────────────────┬────────────────────────────┼──────────────────────┐
           ▼                      ▼                            ▼                      ▼
┌──────────────────┐   ┌──────────────────┐        ┌──────────────────┐   ┌──────────────────┐
│ datacat-query    │   │ datacat-api      │        │ datacat-alerting │   │ datacat-insights │
│ X-View/logs/     │◀──│ gateway/proxy    │───────▶│ monitors/incidents│  │ AI RCA/runbooks  │
│ metrics/profiles │   │ auth/install     │        └──────────────────┘   └──────────────────┘
└──────────────────┘   └────────┬─────────┘
                                ▼
                         ┌─────────────┐
                         │ React web   │
                         │ dashboard   │
                         └─────────────┘
```

---

## Quickstart

### Prerequisites

- Rust toolchain (`cargo`)
- Node.js + npm
- Docker Desktop / Docker Compose
- `cmake` for `rdkafka` native build

### Start infra only

```bash
make dev-db
# or
./scripts/quickstart.sh
```

This starts ClickHouse and Redpanda.

### Start the full local stack

```bash
./scripts/dev.sh
```

Expected local endpoints:

| Service | URL / port |
|---|---|
| Web dashboard | `http://localhost:3000` |
| API gateway | `http://localhost:8000` |
| Query service | `http://localhost:8001` |
| Collector OTLP gRPC | `localhost:4317` |
| Collector OTLP HTTP | `http://localhost:4318` |
| Alerting | `http://localhost:9090` |
| Insights | `http://localhost:9091` |
| Admin | `http://localhost:9093` |
| ClickHouse HTTP | `http://localhost:8123` |
| Redpanda Kafka | `localhost:9092` |

### Verify the stack

```bash
./scripts/verify-stack.sh
```

The script checks health endpoints, Docker infra, and the web UI. Use it before demos and submissions.

---

## Demo scenario

The recommended contest demo is deliberately narrow and visual:

1. Start `datacat` locally.
2. Generate sample telemetry from a demo app or load generator.
3. Show X-View: a latency spike appears as a visible pattern.
4. Click the suspicious time range/service.
5. Show correlated logs/traces/metrics.
6. Ask AI Insights: “왜 느려졌어?”
7. Present a root-cause candidate and runbook.

Suggested demo story:

> Checkout latency spikes after a database timeout. datacat shows the spike in X-View, filters related logs by trace/service/time, and summarizes the likely database bottleneck with a suggested runbook.

---

## Development commands

```bash
# Rust
cargo check --workspace
cargo test --workspace
cargo build --workspace

# Web
cd web
npm run build
npm test -- --run

# Infra
make dev-db
make down
make clean
```

---

## Verification snapshot

Last local verification performed during project triage:

```text
cargo check --workspace      PASS
cargo build --workspace      PASS
cargo test --workspace       PASS, 19 Rust tests
web npm run build            PASS
web npm test -- --run        PASS, 30 web tests
```

Current test coverage is strongest in `datacat-query`, `datacat-schema`, and selected React views. Collector/ingester/API/admin/alerting/insights need more integration tests before production use.

---

## Known limitations

- The repository previously had no top-level README; docs are now being consolidated around this file.
- Some older dev logs showed ClickHouse schema drift (`resource_keys`, `profiles`, and `start_time` type mismatches). Use a fresh volume or re-apply `deploy/clickhouse/init.sql` before demos.
- Full-stack demo startup must be verified with `./scripts/verify-stack.sh`; individual services may be running while API/query/web are down.
- AI Insights is currently a PoC layer. It needs a hardened demo dataset, deterministic incident summaries, and stronger tests.
- The roadmap mentions very high performance targets such as 1M spans/s. Treat these as targets until a benchmark report is committed.

---

## Roadmap to contest-ready

1. Add deterministic demo data and a `make demo` command.
2. Fix and test fresh ClickHouse schema bootstrap/migration.
3. Add X-View → trace/log correlation as the primary UI flow.
4. Add AI RCA summary cards and one-click runbook prompts.
5. Publish a small benchmark table with reproducible commands.
6. Add CI badges and backend integration tests.

---

## License

AGPL-3.0. See `Cargo.toml` workspace metadata.
