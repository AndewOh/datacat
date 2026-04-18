# RFC-004: 인터널 와이어 포맷

- **Status**: Accepted
- **Phase**: 0
- **Author**: datacat core
- **Date**: 2026-04-18

---

## 1. 배경

datacat의 데이터 흐름은 여러 컴포넌트를 경유한다. 각 구간에서 서로 다른 직렬화 포맷이 최적이다. 이 RFC는 Phase 0부터 Phase 2+까지의 포맷 선택과 그 근거를 정의한다.

---

## 2. 전체 데이터 흐름

```
OTel SDK
   │ OTLP proto (gRPC / HTTP)
   ▼
Collector (현재: OTel Contrib, Phase 1: datacat-collector)
   │ OTLP proto (Kafka message)
   ▼
Redpanda (topics: datacat.spans, datacat.logs, datacat.metrics)
   │ OTLP proto
   ▼
Ingester (datacat-ingester)
   │ ClickHouse native protocol (row batch)
   ▼
ClickHouse
   │ Arrow IPC (Phase 2+) / JSON (Phase 0)
   ▼
Query 서비스 (datacat-query)
   │ Arrow Flight (Phase 2+) / JSON HTTP (Phase 0)
   ▼
Web / API 클라이언트
```

---

## 3. 구간별 포맷 상세

### 3.1 OTel SDK → Collector: OTLP proto

표준 준수. OTel Collector가 OTLP gRPC(포트 4317)와 OTLP HTTP(포트 4318)를 모두 수신한다. 변경 불가 — SDK와 Collector의 인터페이스다.

### 3.2 Collector → Redpanda: OTLP proto

**포맷**: `otlp_proto` (binary protobuf)

```yaml
# OTel Collector kafka exporter
exporters:
  kafka:
    encoding: otlp_proto
```

#### 선택 이유

| 항목 | OTLP proto | JSON | Avro |
|------|-----------|------|------|
| 스키마 | OTel 표준 정의 | 없음 | 별도 registry 필요 |
| 크기 | 작음 | 큼 | 중간 |
| Collector 지원 | 기본 내장 | 기본 내장 | 플러그인 필요 |
| Ingester 구현 | prost crate | serde_json | schema registry 연동 |

Phase 0에서 Collector를 OTel Contrib으로 사용하므로 `otlp_proto`가 자연스러운 선택. Phase 1에서 datacat-collector로 교체해도 동일 포맷 유지.

**Kafka 메시지 구조**:
```
Header:
  tenant-id: <string>     (Collector가 API Key 기반으로 주입)
  signal-type: spans|logs|metrics
  timestamp: <unix_ms>
Value:
  ExportTraceServiceRequest | ExportLogsServiceRequest | ExportMetricsServiceRequest (binary proto)
```

### 3.3 Ingester 내부: Arrow IPC (Phase 2 목표)

Phase 0에서는 OTLP proto를 직접 파싱해 ClickHouse 행으로 변환한다. Phase 2에서 Ingester가 배치를 처리할 때 Arrow IPC를 내부 버퍼 포맷으로 사용할 계획이다.

**Phase 2 전환 이유**:
- Arrow 컬럼형 포맷이 `duration_ns`, `status_code` 같은 수치 컬럼의 SIMD 연산에 유리
- ClickHouse native protocol이 컬럼 단위 INSERT를 선호 → Arrow 컬럼을 직접 매핑 가능
- Ingester 내 집계(통계, 샘플링)가 Arrow compute kernel로 가속 가능

**Phase 0 (현재)**: OTLP proto → `prost` 역직렬화 → Rust 구조체 → ClickHouse row INSERT

### 3.4 Ingester → ClickHouse: Native Protocol (행 배치)

ClickHouse native 클라이언트 프로토콜(`clickhouse-rs` crate)을 사용한다. HTTP 인터페이스 대비:
- 연결 재사용 (persistent TCP connection)
- 서버 측 압축 협상 (LZ4 기본)
- 비동기 INSERT 지원

배치 크기: 기본 1000행 또는 1초 타임아웃 (먼저 도달하는 쪽). Phase 1에서 튜닝 가능한 환경변수로 노출.

### 3.5 Query 서비스 → 클라이언트

#### Phase 0: JSON over HTTP

```
GET /api/v1/spans?tenant_id=acme&service=api&from=...&to=...
→ Content-Type: application/json
→ { "spans": [...], "total": 1234 }
```

구현 단순성 우선. Web 클라이언트(React)가 직접 소비 가능.

#### Phase 2: Arrow Flight (목표)

대용량 결과셋 (수만 행 이상) 전송 시 JSON은 직렬화 오버헤드가 크다. Arrow Flight는:
- 컬럼형 전송으로 네트워크 효율 극대화
- 클라이언트 측 Arrow 처리 가능 (Web: arrow-js, Python: pyarrow)
- ClickHouse → Arrow → Flight 파이프라인이 제로카피에 근접

전환 시 API 버전 분리: `/api/v1` (JSON), `/api/v2` (Arrow Flight).

---

## 4. Phase 0 단순화 요약

| 구간 | Phase 0 | Phase 2+ |
|------|---------|---------|
| SDK → Collector | OTLP proto | OTLP proto (동일) |
| Collector → Redpanda | OTLP proto | OTLP proto (동일) |
| Ingester 내부 버퍼 | Rust 구조체 (heap) | Arrow IPC |
| Ingester → ClickHouse | Native row INSERT | Native columnar INSERT |
| Query → 클라이언트 | JSON HTTP | Arrow Flight |

Phase 0 목표는 동작하는 E2E 파이프라인이다. 퍼포먼스 최적화는 Phase 2에서 프로파일링 기반으로 진행한다.

---

## 5. Redpanda 토픽 설계

```
datacat.spans    — ExportTraceServiceRequest 메시지
datacat.logs     — ExportLogsServiceRequest 메시지
datacat.metrics  — ExportMetricsServiceRequest 메시지
```

- 파티션 수: 16 (Phase 0). Ingester 인스턴스 수에 맞게 조정.
- 레플리카: 1 (Phase 0, 단일 노드). 프로덕션 전환 시 3으로 증가.
- 보관 기간: 24시간 (Redpanda는 WAL 역할. 장기 보관은 ClickHouse가 담당).
- 압축: LZ4 (Redpanda 기본값 유지. OTLP proto는 이미 compact).

### 토픽 파티션 키

Collector의 kafka exporter는 기본적으로 라운드로빈 또는 랜덤 파티셔닝을 사용한다. Phase 1에서 `tenant_id` 해시 기반 파티셔닝으로 전환해 동일 테넌트 데이터의 순서를 보장할 계획이다 (트레이스 재조합 시 유리).

---

## 6. 에러 처리 및 DLQ

Phase 0에서는 파싱 실패 시 로그 출력 후 스킵.

Phase 1에서:
- 파싱 불가 메시지 → `datacat.dlq` 토픽으로 이동 (Dead Letter Queue)
- DLQ 메시지는 원본 + 에러 이유를 포함
- DLQ 알림 메트릭: `datacat.ingester.dlq_total`
