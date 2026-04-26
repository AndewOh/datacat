#!/usr/bin/env bash
# demo-checklist.sh — print the recommended contest demo flow.
#
# This is intentionally non-mutating. Use it as an operator checklist while
# recording a demo video or presenting datacat live.

set -euo pipefail

cat <<'EOF'
# datacat contest demo checklist

## 0. Start

  ./scripts/dev.sh

In another terminal:

  ./scripts/verify-stack.sh

## 1. Generate telemetry

Use one of:

  make load-gen RATE=200 DURATION=60

or start a sample app and point its OTLP exporter to:

  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

## 2. Show landing page

  http://localhost:3000

Explain:

  "datacat is a Rust-native APM that combines OpenTelemetry ingest,
   ClickHouse analytics, X-View visualization, and AI incident summaries."

## 3. Show X-View

Open the X-View/dashboard screen and point out:

  - latency clusters
  - error-colored points
  - service/time filtering

## 4. Correlate evidence

From the suspicious time range, show:

  - related traces
  - related logs
  - metrics query range

## 5. Ask AI Insights

Prompt examples:

  왜 checkout-service가 느려졌어?
  관련 로그와 trace를 근거로 원인 후보를 정리해줘.
  지금 incident runbook을 만들어줘.

## 6. Close with the product promise

  "datacat reduces incident diagnosis from dashboard-hopping to one workflow:
   see the pattern, click the evidence, get an AI-generated runbook."

## 7. If something breaks

  ./scripts/verify-stack.sh
  tail -f .dev-logs/datacat-api.log
  tail -f .dev-logs/datacat-query.log
  tail -f .dev-logs/datacat-ingester.log
EOF
