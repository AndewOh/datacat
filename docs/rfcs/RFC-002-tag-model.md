# RFC-002: 태그/레이블 모델

- **Status**: Accepted
- **Phase**: 0
- **Author**: datacat core
- **Date**: 2026-04-18

---

## 1. 배경

OTel 데이터 모델은 모든 시그널(span, log, metric)에 임의의 키-값 속성(attributes)을 허용한다. 이를 ClickHouse에 어떻게 저장하느냐가 쓰기 처리량, 쿼리 지연, 스토리지 효율에 직접적인 영향을 미친다.

---

## 2. 결정: `Array(LowCardinality(String))` 키-값 쌍

```sql
attrs_keys   Array(LowCardinality(String)),
attrs_values Array(String),
```

두 배열의 인덱스가 1:1 매핑된다. 즉 `attrs_keys[i]`의 값은 `attrs_values[i]`다.

### 2.1 선택 이유

#### `LowCardinality` 키 (attrs_keys)

태그 키는 카디널리티가 낮다. `http.method`, `db.system`, `error.type` 등 수백 개 수준이다. `LowCardinality(String)`은 내부적으로 딕셔너리 인코딩을 사용해 키 컬럼을 정수 배열로 저장한다. 메모리와 디스크 사용량이 크게 줄고, 키 기반 필터링이 빠르다.

태그 값은 카디널리티가 높을 수 있으므로 (URL path, user_id 등) 일반 `String`으로 저장한다.

#### 스키마 유연성

OTel 속성은 사전 정의 없이 확장된다. 컬럼 방식(`ALTER TABLE ADD COLUMN`)은 운영 부담이 크고, ClickHouse에서 컬럼 추가는 메타데이터 변경으로 빠르지만 수백 개 희소 컬럼은 공간 낭비다. 배열 방식은 스키마 변경 없이 새 태그를 수용한다.

#### 쿼리 패턴

```sql
-- 특정 태그 값 필터
SELECT * FROM datacat.spans
WHERE tenant_id = 'acme'
  AND has(attrs_keys, 'http.status_code')
  AND attrs_values[indexOf(attrs_keys, 'http.status_code')] = '500'
```

`has()` + `indexOf()` 조합은 ClickHouse가 배열 함수로 최적화하며, 실 사용 패턴에서 충분히 빠르다. 카디널리티가 높은 태그 값 조회는 Phase 2에서 보조 인덱스를 추가해 가속할 수 있다.

---

## 3. 카디널리티 가드레일

과도한 태그는 스토리지와 쿼리 성능을 모두 해친다. Collector/Ingester 레이어에서 다음을 강제한다.

| 제약 | 기본값 | 적용 레이어 |
|------|--------|------------|
| 태그 키 최대 개수 | 32개 | Ingester (초과 시 뒤쪽 키-값 드롭) |
| 태그 키 최대 길이 | 128자 | Ingester (초과 시 truncate) |
| 태그 값 최대 길이 | 512자 | Ingester (초과 시 truncate) |
| 키 이름 허용 문자 | `[a-z0-9._-]` | Ingester (정규화 또는 드롭) |

가드레일 위반은 메트릭(`datacat.ingester.tag_dropped_total`)으로 기록되어 테넌트별 모니터링이 가능하다.

---

## 4. OTel resource attributes vs span attributes 분리

```sql
attrs_keys       Array(LowCardinality(String)),  -- span/log attributes
attrs_values     Array(String),
resource_keys    Array(LowCardinality(String)),  -- resource attributes
resource_values  Array(String),
```

### 분리 이유

OTel 데이터 모델에서 `resource`는 프로세스/서비스 수준 메타데이터다 (`service.name`, `host.name`, `k8s.pod.name` 등). `attributes`는 요청/이벤트 수준이다.

**쿼리 패턴이 다르다:**
- resource 조회: "이 서버에서 발생한 모든 에러" — 낮은 카디널리티, 필터로 자주 사용
- span attributes 조회: "status_code가 500인 요청" — 높은 카디널리티 혼재

**압축 효율:**
resource_keys는 거의 동일한 값이 반복 (`service.name` = `api-gateway`가 모든 행에). 별도 컬럼으로 분리하면 ClickHouse 컬럼 압축이 훨씬 효율적이다.

**인덱싱 전략 분리:**
Phase 1에서 resource_keys에 별도 보조 인덱스를 추가해 인프라 속성 기반 필터를 가속할 계획. span attributes는 다른 인덱스 전략(tokenbf 등)이 적합할 수 있다.

---

## 5. 미래: Map(LowCardinality(String), String) 트레이드오프

ClickHouse는 `Map` 타입을 지원한다.

```sql
-- 대안 (미채택)
attrs Map(LowCardinality(String), String)
```

### Map 방식의 장점

- 쿼리 문법이 직관적: `attrs['http.method']`
- 단일 컬럼으로 관리 간편

### Map 방식의 단점

| 항목 | 배열 방식 | Map 방식 |
|------|----------|---------|
| 압축 효율 | 키/값 컬럼 분리 압축, 우수 | 키-값 인터리브, 열등 |
| LowCardinality 키 | 지원됨 | Map 키에 LowCardinality 미지원 (현 버전) |
| 보조 인덱스 | 배열 함수로 가능 | 제한적 |
| 배열 함수 활용 | `arrayJoin`, `arrayFilter` 등 풍부 | 변환 필요 |

현재 ClickHouse 버전(24.x)에서 `Map(LowCardinality(String), String)`은 LowCardinality 효과가 제한적이다. 키 컬럼의 딕셔너리 인코딩 이점을 살리려면 배열 방식이 우선이다. 향후 ClickHouse Map 타입이 LowCardinality를 완전히 지원할 경우 재평가한다.

---

## 6. 구현 노트

Ingester에서 OTel proto → ClickHouse 행 변환 시:

```rust
// OTelAttribute 목록을 두 Vec<String>으로 분리
let (keys, values): (Vec<_>, Vec<_>) = attrs
    .iter()
    .take(MAX_TAGS)  // 32개 가드레일
    .map(|kv| {
        let k = kv.key.chars().take(128).collect::<String>();
        let v = any_value_to_string(&kv.value).chars().take(512).collect();
        (k, v)
    })
    .unzip();
```

정렬은 하지 않는다. 삽입 순서 유지가 디버깅 시 OTel 원본과 1:1 대응되어 유용하다.
