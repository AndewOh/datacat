# RFC-003: 멀티테넌시 모델

- **Status**: Accepted
- **Phase**: 0
- **Author**: datacat core
- **Date**: 2026-04-18

---

## 1. 배경

datacat은 단일 클러스터에서 여러 조직(테넌트)을 지원해야 한다. 온프레미스 배포에서는 단일 테넌트로 단순하게 운영되고, SaaS 모드에서는 완전한 멀티테넌시가 필요하다. 두 모드를 동일한 코드베이스로 지원하는 것이 목표다.

---

## 2. 결정: 쿼리 레벨 필터 (WHERE tenant_id = ?)

### 2.1 아키텍처

모든 테이블에 `tenant_id LowCardinality(String)`이 첫 번째 ORDER BY 컬럼이자 첫 번째 파티션 키다.

```sql
PARTITION BY (tenant_id, toYYYYMMDD(start_time))
ORDER BY (tenant_id, service, start_time, trace_id)
```

모든 쿼리는 반드시 `WHERE tenant_id = :tenant_id` 조건을 포함해야 한다. Query 서비스가 이를 강제한다.

```rust
// datacat-query: 모든 쿼리에 tenant_id 자동 주입
pub fn build_query(ctx: &TenantContext, q: UserQuery) -> String {
    format!("SELECT ... FROM datacat.spans WHERE tenant_id = '{}' AND {}", 
            ctx.tenant_id, q.user_filter)
}
```

### 2.2 row-level security 미사용 이유

ClickHouse는 row policy를 통한 row-level security를 지원한다. 미채택 이유:

| 항목 | row-level security | WHERE 필터 |
|------|-------------------|-----------|
| 성능 | 내부 rewrite로 오버헤드 존재 | 쿼리 플래너가 직접 최적화 |
| 투명성 | 숨겨진 필터로 디버깅 어려움 | 쿼리 로그에 명시적으로 보임 |
| 복잡성 | ClickHouse 계정 관리 필요 | 애플리케이션 레벨에서 완전 제어 |
| 온프레미스 호환성 | 설정 복잡도 증가 | 단순 연결 문자열로 동작 |

WHERE 필터 방식은 단순하고 투명하며 퍼포먼스가 예측 가능하다.

---

## 3. 테넌트 간 데이터 격리 보장

### 3.1 스토리지 레벨 격리

`tenant_id`가 파티션 첫 번째 키이므로, 서로 다른 테넌트의 데이터는 항상 다른 파트 파일에 저장된다. A 테넌트의 쿼리가 B 테넌트의 파트 파일을 읽는 물리적 I/O가 발생하지 않는다 (파티션 프루닝).

### 3.2 쿼리 레벨 격리

Query 서비스의 `TenantContext`는 인증 토큰에서 추출되며 변조 불가능하다. 모든 쿼리 빌더가 `TenantContext`를 요구하므로, tenant_id 없이는 쿼리를 구성할 수 없다.

```
클라이언트 요청
  → API Gateway (JWT 검증, tenant_id 추출)
  → Query 서비스 (TenantContext 생성)
  → ClickHouse 쿼리 (WHERE tenant_id = ? 자동 주입)
```

### 3.3 Ingestion 레벨 격리

Collector가 수신한 OTLP 데이터는 API 키로 테넌트를 식별한다. Ingester가 Redpanda 메시지에서 tenant_id를 검증하고 ClickHouse에 기록한다.

```
OTel SDK → Collector (API Key → tenant_id 매핑)
  → Redpanda (topic 헤더에 tenant_id 포함)
  → Ingester (tenant_id 검증 후 INSERT)
```

API 키 없는 요청은 Collector에서 즉시 거부 (401).

---

## 4. tenant_id 형식

```
Format: [a-z0-9-]{3,64}
Example: "acme-corp", "kaflix", "dev"
```

- 온프레미스 단일 테넌트 기본값: `"default"`
- 대소문자 정규화: 항상 소문자
- 변경 불가: tenant_id는 파티션 키이므로 변경 시 데이터 재파티셔닝 필요. 식별자 변경은 지원하지 않으며 별칭 레이어로 처리 예정

---

## 5. 온프레미스 단일 테넌트 모드

온프레미스 배포에서는 환경 변수로 단일 테넌트 모드를 활성화한다.

```yaml
# docker-compose.yml (온프레미스)
environment:
  DATACAT_SINGLE_TENANT: "true"
  DATACAT_TENANT_ID: "default"
```

단일 테넌트 모드에서:
- API 키 검증 스킵 (내부 네트워크 신뢰)
- 모든 데이터가 `tenant_id = "default"`로 기록
- UI에서 테넌트 선택 UI 숨김

SaaS 모드와 스키마가 동일하므로 단일→멀티 마이그레이션이 데이터 재작성 없이 가능하다.

---

## 6. 미래: ClickHouse 멀티 노드 전환

### 6.1 ReplicatedMergeTree

```sql
-- 현재 (Phase 0)
ENGINE = MergeTree()

-- Phase 2+ 멀티 노드
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/datacat.spans', '{replica}')
```

ZooKeeper 또는 ClickHouse Keeper 클러스터가 필요하다. 데이터 마이그레이션 절차:
1. 신규 노드에 ReplicatedMergeTree 테이블 생성
2. `ATTACH PARTITION` 으로 기존 데이터 이전
3. 트래픽 컷오버

### 6.2 샤딩 전략

테넌트 수가 많고 데이터가 편중된 경우:

**테넌트 기반 샤딩** (권장, Phase 2):
```sql
-- Distributed 테이블
ENGINE = Distributed(datacat_cluster, datacat, spans, cityHash64(tenant_id))
```
- 동일 테넌트 데이터가 동일 샤드에 집중 → 로컬 조인 가능
- 대형 테넌트(whale tenant) 편중 문제 가능성

**랜덤 샤딩** (Phase 3 대안):
- 균등 분산이나 크로스-샤드 집계 오버헤드 증가

Phase 0~1은 단일 노드로 운영. 10TB/월 이상 또는 쿼리 지연 SLO 위반 시 샤딩 전환.

### 6.3 테넌트별 리소스 쿼터

향후 Phase 3에서 ClickHouse의 `quota` 기능 또는 Query 서비스의 rate limiter로 테넌트별 쿼리 동시성과 스캔 바이트를 제한할 계획.

```sql
-- ClickHouse quota (Phase 3 예정)
CREATE QUOTA tenant_standard FOR INTERVAL 1 hour MAX queries = 1000, 
    read_bytes = 107374182400  -- 100GB/hour
TO datacat_role;
```
