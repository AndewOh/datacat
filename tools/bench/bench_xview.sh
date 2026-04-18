#!/usr/bin/env bash
# X-View 쿼리 성능 벤치마크
set -euo pipefail

API_URL="${1:-http://localhost:8000}"

echo "=== datacat X-View Query Benchmark ==="

# 현재 시간 기준 1시간 범위
END_TS=$(date +%s%3N)
START_TS=$((END_TS - 3600000))

# p99를 10회 측정
TIMES=()
for i in $(seq 1 10); do
  T=$(curl -s -o /dev/null -w "%{time_total}" \
    "${API_URL}/api/v1/xview?start=${START_TS}&end=${END_TS}&service=api-gateway")
  MS=$(echo "$T * 1000" | bc)
  TIMES+=("$MS")
  echo "  Run $i: ${MS}ms"
done

echo ""
echo "=== X-View 쿼리 결과 ==="
# 정렬 후 p99 계산 (10회 중 9번째)
SORTED=($(printf '%s\n' "${TIMES[@]}" | sort -n))
P99="${SORTED[8]}"
P50="${SORTED[4]}"
echo "p50: ${P50}ms"
echo "p99: ${P99}ms"
echo "SLO target: < 500ms"

if (( $(echo "$P99 < 500" | bc -l) )); then
  echo "SLO PASS"
else
  echo "SLO FAIL"
fi
