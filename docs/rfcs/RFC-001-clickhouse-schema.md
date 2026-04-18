# RFC-001: ClickHouse Schema Design

- **Status**: Accepted
- **Phase**: 0
- **Author**: datacat core
- **Date**: 2026-04-18

---

## 1. 배경 및 목표

datacat의 핵심 쿼리 패턴은 Jennifer UX(X-View)가 구동하는 다음 세 가지다.

1. **트레이스 드릴다운**: `trace_id`로 특정 트랜잭션 전체 스팬 조회 — 단일 키 조회, p99 < 50ms 목표
2. **X-View 응답시간 분포**: `(tenant, service, time_range)` 기준 `duration_ns` 분위수 집계 — 대시보드 렌더, p99 < 500ms 목표
3. **로그-트레이스 연계**: `trace_id` / `span_id`로 로그-스팬 조인 — 상관 분석

스토리지 엔진은 ClickHouse MergeTree 계열. Datadog처럼 쓰기 처리량과 읽기 지연을 동시에 최소화하는 것이 설계 원칙이다.

---

## 2. 파티션 전략: `(tenant_id, toYYYYMMDD(timestamp))`

```sql
PARTITION BY (tenant_id, toYYYYMMDD(start_time))
```

### 선택 이유

| 기준 | 설명 |
|------|------|
| **테넌트 격리** | 파티션 단위로 테넌트가 분리되어, 한 테넌트의 쿼리가 다른 테넌트의 데이터 파일을 건드리지 않는다. ClickHouse는 파티션 프루닝을 WHERE 절 기반으로 수행하므로, `WHERE tenant_id = ?` 만으로도 타 테넌트 파트를 스킵한다. |
| **날짜 기반 TTL 효율** | `TTL ... DELETE`는 파티션 단위로 드롭된다. 날짜 파티션이 없으면 만료된 행을 찾기 위해 전체 테이블 머지가 필요하다. |
| **파티션 크기 제어** | 테넌트 × 일자 조합으로 파티션 하나가 수십~수백 MB 수준. 너무 작으면 파티션 오버헤드, 너무 크면 TTL 드롭 지연. 이 조합이 현실적인 균형점이다. |

파티션 수 폭발 방지: 테넌트 수 × 보관 일수가 파티션 총합. 예) 100개 테넌트 × 30일 = 3000 파티션 — ClickHouse 권장 범위 내.

---

## 3. ORDER BY 선택: `(tenant_id, service, start_time, trace_id)`

```sql
ORDER BY (tenant_id, service, start_time, trace_id)
```

### 선택 이유

ClickHouse MergeTree의 기본 인덱스는 `ORDER BY` 컬럼의 sparse index다. 앞 컬럼일수록 인덱스 효과가 크다.

X-View의 주 쿼리 패턴:

```sql
-- 서비스별 응답시간 분포 (가장 빈번)
SELECT quantile(0.99)(duration_ns)
FROM datacat.spans
WHERE tenant_id = 'acme' AND service = 'api-gateway'
  AND start_time BETWEEN now() - INTERVAL 1 HOUR AND now()
```

이 패턴에서 `(tenant_id, service, start_time)` 순서가 최적이다.

- `tenant_id` 먼저: 멀티테넌시 격리, 모든 쿼리의 선행 조건
- `service` 다음: X-View는 서비스 단위 뷰가 기본
- `start_time` 마지막: 시간 범위 필터로 그래뉼 스킵 극대화
- `trace_id` 후미: 드릴다운 시 같은 서비스+시간대 내 특정 트레이스 위치 지정

### trace_id 단일 조회

`trace_id` 자체 조회는 ORDER BY로는 비효율적이므로, Bloom Filter 보조 인덱스가 담당한다(섹션 4 참고).

---

## 4. 보조 인덱스 선택

### 4.1 Bloom Filter — `trace_id`

```sql
INDEX idx_trace_id trace_id TYPE bloom_filter(0.001) GRANULARITY 1
```

- 오탐률 0.1%로 설정. 약 10KB/그래뉼 오버헤드.
- `WHERE trace_id = 'abc...'` 쿼리에서 존재하지 않는 그래뉼을 99.9% 확률로 스킵한다.
- ORDER BY에 trace_id가 마지막이라 스팬 조회 시 선형 스캔 가능성이 있으나 Bloom filter가 이를 O(1)에 가깝게 만든다.

### 4.2 MinMax — `duration_ns`

```sql
INDEX idx_duration duration_ns TYPE minmax GRANULARITY 1
```

- 느린 요청 필터링: `WHERE duration_ns > 1_000_000_000` (1초 이상) 패턴.
- 그래뉼 단위로 min/max를 저장해 범위 바깥 그래뉼 스킵.
- 오버헤드 극히 낮음 (그래뉼당 16바이트).

### 4.3 Set — `status_code`

```sql
INDEX idx_status status_code TYPE set(4) GRANULARITY 1
```

- 카디널리티 4 이하 (0=unset, 1=ok, 2=error, 3=reserved).
- 에러 스팬 필터 `WHERE status_code = 2` 가 자주 발생한다.
- `set(4)`: 그래뉼 내 고유 값을 4개까지 저장. 해당 값이 없으면 그래뉼 스킵.

---

## 5. Projection 설계: `proj_xview`

```sql
ALTER TABLE datacat.spans
    ADD PROJECTION proj_xview (
        SELECT tenant_id, service, env, start_time, duration_ns, status_code, trace_id, span_id
        ORDER BY (tenant_id, service, start_time)
    );
```

### 목적

X-View p99 500ms 목표를 달성하기 위한 추가 인덱스 구조.

기본 ORDER BY에는 `trace_id`가 포함되어 있어 같은 `(tenant, service, time)` 범위여도 파트 내 정렬이 완전히 시간 순이 아닐 수 있다. Projection은 이 컬럼 집합을 별도 정렬로 저장해, 해당 패턴의 쿼리가 projection을 타도록 ClickHouse 옵티마이저가 자동으로 선택한다.

### 컬럼 선택 이유

`status_msg`, `attrs_keys/values`, `resource_*` 등 무거운 컬럼을 제외해 projection 크기를 최소화. X-View 대시보드는 응답시간 분포와 에러율만 필요로 한다. 드릴다운 상세 정보는 `trace_id`로 기본 테이블을 다시 조회.

---

## 6. TTL 정책

| 테이블 | 기본 보관 기간 | 근거 |
|--------|--------------|------|
| spans | 30일 | 인시던트 사후 분석 주기. 대부분의 팀이 30일 이내 재현 |
| logs | 30일 | 동일 |
| metrics | 30일 | 기본값; 장기 메트릭은 Phase 2에서 downsampling 후 별도 보관 |
| profiles | 7일 | 페이로드가 크고 단기 디버깅 용도 |
| span_stats_1m | 90일 | 분단위 집계 데이터는 크기가 작아 더 오래 보관, 트렌드 분석 용 |

TTL 값은 모두 테넌트 단위 설정으로 오버라이드 가능하도록 Phase 1에서 확장 예정.

---

## 7. Materialized View: `mv_span_stats_1m`

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS datacat.mv_span_stats_1m
TO datacat.span_stats_1m AS
SELECT
    tenant_id, service, env,
    toStartOfMinute(start_time) AS window,
    count(), countIf(status_code = 2),
    quantile(0.50)(duration_ns), quantile(0.95)(duration_ns), quantile(0.99)(duration_ns),
    avg(duration_ns)
FROM datacat.spans
GROUP BY tenant_id, service, env, window;
```

### 용도

- **대시보드 오버뷰**: 서비스 목록과 현재 상태(QPS, 에러율, p99)를 1분 단위로 보여주는 X-View 홈 화면
- **알림 평가**: 임계값 기반 알림이 1분 집계로 평가됨 (실시간 알림은 Phase 2에서 스트리밍으로 교체)
- **쓰기 시점 집계**: INSERT 시 MV가 자동 집계하므로 조회 시 GROUP BY 불필요. 대시보드 쿼리가 `span_stats_1m`에서 직접 읽어 수십 ms 응답 가능

`SummingMergeTree`를 대상 테이블 엔진으로 사용해 같은 키의 행이 자동으로 합산된다. `quantile` 컬럼은 근사값이므로 롤업 오차 허용 (± 1~2%).

---

## 8. 향후 고려사항

- **ReplicatedMergeTree**: 멀티 노드 ClickHouse 전환 시 `ENGINE = ReplicatedMergeTree(...)` 로 교체. ZooKeeper/ClickHouse Keeper 필요.
- **Codec 최적화**: `duration_ns`에 `CODEC(Delta, ZSTD(3))`, timestamp에 `CODEC(DoubleDelta, ZSTD)` 적용으로 20~40% 추가 압축 가능. Phase 1 마이그레이션 시 적용.
- **분위수 정확도**: 현재 `quantile()` 함수는 확률적 근사. 정확한 분위수가 필요한 경우 `quantileExact()` 또는 `quantileTDigest()` 전환 고려.
