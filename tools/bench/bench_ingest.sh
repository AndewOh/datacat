#!/usr/bin/env bash
# datacat ingest 벤치마크
# 사전 조건: docker compose가 실행 중이어야 함
set -euo pipefail

ENDPOINT="${1:-localhost:4317}"
RATE="${2:-10000}"
DURATION="${3:-30}"

echo "=== datacat Ingest Benchmark ==="
echo "Endpoint: $ENDPOINT"
echo "Target rate: $RATE spans/s"
echo "Duration: ${DURATION}s"
echo ""

# ClickHouse 초기 카운트
CH_START=$(docker exec datacat-clickhouse-1 clickhouse-client \
  --user datacat --password datacat_dev \
  --query "SELECT count() FROM datacat.spans" 2>/dev/null || echo "0")

echo "ClickHouse spans before: $CH_START"

# 부하 생성
START_TS=$(date +%s%3N)
python3 tools/load-generator/generate.py \
  --rate "$RATE" \
  --duration "$DURATION" \
  --endpoint "$ENDPOINT" \
  --workers 8

# 10초 대기 (ingester 배치 flush)
echo "Waiting for ingester flush..."
sleep 10

END_TS=$(date +%s%3N)

# ClickHouse 최종 카운트
CH_END=$(docker exec datacat-clickhouse-1 clickhouse-client \
  --user datacat --password datacat_dev \
  --query "SELECT count() FROM datacat.spans" 2>/dev/null || echo "0")

INGESTED=$((CH_END - CH_START))
ACTUAL_DURATION=$(( (END_TS - START_TS) / 1000 ))
RATE_ACTUAL=$((INGESTED / ACTUAL_DURATION))

echo ""
echo "=== 결과 ==="
echo "Ingested spans: $INGESTED"
echo "Duration: ${ACTUAL_DURATION}s"
echo "Actual rate: $RATE_ACTUAL spans/s"
echo "SLO target: 1,000,000 spans/s"

if [ "$RATE_ACTUAL" -ge 1000000 ]; then
  echo "SLO PASS"
else
  echo "SLO FAIL ($(( RATE_ACTUAL * 100 / 1000000 ))% of target)"
fi
