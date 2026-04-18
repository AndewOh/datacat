# datacat — Master Plan (Performance-First Edition)

> Jennifer APM의 **직관적 실시간 UX(X-View)** + Datadog의 **폭넓은 관측성과 확장성**을 하나로.
> 온프레미스/클라우드 양립. **퍼포먼스를 최우선**으로 설계하고, 운영 부담은 AI 기반 자동화로 상쇄한다.

---

## 0. 핵심 원칙 (개정)

**"속도가 곧 기능이다."** 초당 수백만 스팬·수억 포인트를 삼키고도 대시보드가 1초 안에 응답하는 것 — 이게 datacat의 약속이다. 이 약속을 지키기 위한 트레이드오프는 일관된다:

1. **퍼포먼스 ≻ 운영성**: Go보다 Rust, GC 있는 런타임보다 네이티브, JVM 중개 없이 OS 레벨.
2. **운영 부담은 AI로 상쇄**: 자동 튜닝, 자동 스케일 결정, LLM 기반 런북, 이상 탐지·자동 완화.
3. **Zero-copy, SIMD, columnar, io_uring, eBPF** 가 1일차 설계 언어.
4. **OTel-first** — 표준만 수용하고, 그 위에 datacat 확장.
5. **X-View를 시스템 중심에 둔다** — WebGPU/WebGL로 100만 포인트 60fps.
6. **온프레=1급 시민** — 단일 바이너리 배포, 외부 의존 최소.
7. **멀티테넌시 from day 1**.

---

## 1. 포지셔닝 — 비슷한 생각을 한 사람들의 결론

| 제품 | 강점 | datacat이 비집고 들어갈 틈 |
|---|---|---|
| **Datadog** | 통합 관측성, SaaS | 비쌈, 온프레 없음, APM UX는 "그래프 나열" |
| **Jennifer** | X-View, 실시간 UX | K8s/MSA/OTel 약함, 글로벌 인지도 |
| **SigNoz / Uptrace** | OSS, OTel, ClickHouse | Go 기반(GC 지연), UX는 일반적 |
| **Pinpoint / Scouter** | 스캐터 차트(한국산) | 노후 UI, JVM 편중, OTel 아님 |
| **ClickStack** | ClickHouse 공식 OTel 스택 | 인프라 수준, 제품력 얇음 |
| **Grafana Cloud / Tempo / Loki / Mimir** | Go 기반 OSS 생태계 | GC 지연, 고카디널리티 한계 |
| **Datadog Monocle (참고)** | Rust + LSM + Kafka WAL로 초당 수십억 포인트 | 상용, 비공개. 우리 방향의 **교본** |

**공통 결론 = datacat 기회:**
- OTel + ClickHouse는 정답이지만, **주변 코드를 Go로 짜면 Datadog Monocle 수준엔 못 간다**.
- Datadog이 직접 증명함: "진짜 빠른 관측성은 Rust로 재작성해야 한다."
- UX(X-View)는 여전히 OSS 공백지대.
- 온프레 현대 APM은 희귀하다 — 단일 바이너리 Rust 스택은 여기서 압도적 장점.

---

## 2. 아키텍처 (Performance-First)

```
                   ┌──────────────────────────── datacat Control Plane (All Rust) ─────────────────────────┐
 Target            │                                                                                       │
 ┌──────────┐      │   ┌────────────┐    ┌──────────────┐    ┌────────────┐    ┌───────────────────┐    │
 │App + SDK │──┐   │   │ Collector  │───▶│   Redpanda   │───▶│ Ingester   │───▶│ ClickHouse        │    │
 │(OTel)    │──┼──▶│   │ (Rust,     │    │  (C++, JVM   │    │ (Rust,     │    │ (hot, SIMD,       │    │
 └──────────┘   │  │   │  io_uring) │    │   없는 Kafka) │    │  Arrow/    │    │  LowCardinality,  │    │
 ┌──────────┐   │  │   └────────────┘    └──────────────┘    │  rkyv IPC) │    │  Projections)     │    │
 │Host Agent│───┤  │                                          └────────────┘    └──────┬────────────┘    │
 │(eBPF)    │   │  │                                                                     │                │
 └──────────┘   │  │   ┌──────────┐                                              ┌───────▼───────┐       │
 ┌──────────┐   │  │   │Profiling │                                              │ Query Engine  │       │
 │K8s Cluster│──┘  │   │Ingestor   │                                              │ (Rust, Arrow  │       │
 │ Agent+CA  │     │   │(pprof/jfr)│                                              │  Flight, SIMD)│       │
 └──────────┘     │   └──────────┘                                              └───┬───────┬───┘       │
                  │                                                                  │       │           │
                  │        ┌──────────┐    ┌──────────┐    ┌──────────────┐          │       │           │
                  │        │ Parquet  │    │ S3/MinIO │    │ Alerting     │          │       │           │
                  │        │ (cold)   │◀──▶│ (object) │    │ Engine (Rust)│          │       │           │
                  │        └──────────┘    └──────────┘    └──────────────┘          │       │           │
                  │                                                                  │       │           │
                  │   ┌──────────────────────────────────────────────────────────────▼──┐   │           │
                  │   │  Web UI — React + TypeScript + WebGPU/WebGL (regl, Apache Arrow  │   │           │
                  │   │  over WebSocket, Rust-WASM for heavy transforms)                  │◀──┘           │
                  │   └───────────────────────────────────────────────────────────────────┘               │
                  │                                                                                       │
                  │   ┌───────────────────────────── AI Auto-Ops Layer ─────────────────────────────┐    │
                  │   │  자동 튜닝(스키마/샘플링/TTL), 이상탐지, X-View 패턴, LLM 런북, 자동 스케일     │    │
                  │   └──────────────────────────────────────────────────────────────────────────────┘    │
                  └───────────────────────────────────────────────────────────────────────────────────────┘
```

### 스택 결정 (개정)

| 레이어 | 선택 | 왜 (퍼포먼스 근거) |
|---|---|---|
| **언어(서버 전반)** | **Rust** (전 계층) | GC 없음, 예측 가능한 레이턴시, SIMD/async 성숙. Datadog도 같은 결론 |
| **Agent (SDK)** | OTel SDK + **datacat native extension (Rust cdylib)** | JVM/Node도 JNI/N-API로 native 확장 붙여 오버헤드 최소 |
| **Host Agent** | **Rust + eBPF** (aya 또는 libbpf-rs) | 커널 레벨 네트워크/프로세스 관측, 커버리지↑, 오버헤드↓ |
| **Collector** | **Rust로 자체 구현** (hyper, tokio, io_uring via tokio-uring) | OTel Collector Contrib(Go)는 GC로 tail latency 튐. OTel 프로토콜만 호환 |
| **버스/WAL** | **Redpanda** (Kafka 프로토콜, C++) | JVM 없음, p99 낮음. 단일 바이너리 배포 |
| **Ingester** | **Rust + Apache Arrow + rkyv** | zero-copy 파이프라인, columnar 전송 |
| **Hot storage** | **ClickHouse** (LowCardinality, Projections, Materialized View) | SIMD, columnar, 압축. ClickHouse 엔진 자체가 C++로 최고 수준 |
| **Cold storage** | **Parquet on S3/MinIO** (ClickHouse MergeTree `S3` 엔진) | 압축·컬럼나·저렴 |
| **Query API** | **Rust + Apache Arrow Flight** | 결과셋 zero-copy, 브라우저까지 Arrow 그대로 |
| **Frontend** | React + TS, **WebGPU(지원 시) / WebGL2 regl**, **Rust→WASM**으로 대용량 변환 | X-View 100만~1000만 포인트 60fps 타깃 |
| **배포** | 단일 정적 바이너리 + Helm + Operator | musl/cross 빌드, 에어갭 tarball |
| **AI Auto-Ops** | ONNX Runtime in-process (Rust 바인딩) + LLM 외부 | 이상탐지는 인프로세스, 런북/챗봇은 LLM API |

### 명시적으로 버리는 선택

- **Go 전면 사용**: Grafana·SigNoz가 Go. 편하지만 GC p99 튐. 타겟 성능 영역에서 불리.
- **Java/JVM 서버 컴포넌트**: Elastic이 여기서 무거워짐.
- **OTel Collector Contrib(Go)**: 호환은 유지하되 hot-path는 자체 Rust 구현.
- **Elasticsearch/Loki**: 고카디널리티·조인 약점, 비용.

---

## 3. 단계별 로드맵 (퍼포먼스 타깃 포함)

각 Phase에 **성능 수용 기준(SLO)** 추가. 이것 못 맞추면 다음 Phase 금지.

### Phase 0 — Foundation (1–2주)
- 모노레포: `agents/ collector/ ingester/ query/ web/ deploy/ ops-ai/ docs/`
- Rust workspace (cargo workspace, 공통 crate: `datacat-proto`, `datacat-schema`, `datacat-arrow`)
- RFC-001 ClickHouse 스키마 (spans/logs/metrics/profiles + Projection 설계)
- RFC-002 태그 모델 (LowCardinality, 카디널리티 가드레일)
- RFC-003 멀티테넌시 (tenant_id 파티션, ReplicatedMergeTree 샤딩)
- RFC-004 Arrow/Flight 인터널 와이어 포맷
- 라이선스: **AGPLv3 (core)** + 엔터프라이즈 모듈 BSL 제안 — 최종 결정
- **데모**: `docker compose up` → Redpanda + ClickHouse + 빈 UI + Collector 부팅 10초 이내

### Phase 1 — MVP: Traces + X-View ⭐ (4–6주)
- OTLP gRPC/HTTP receiver (Rust, tokio-uring)
- Redpanda 프로듀서 (배치, zstd)
- Ingester: Redpanda → ClickHouse 배치 insert (초당 1M+ spans 단일 노드)
- **X-View WebGPU 엔진**: 1M 포인트 60fps, 드래그 선택 < 16ms, 프로파일 슬라이드 < 200ms
- Java 샘플 + OTel 자동계측
- **성능 SLO**:
  - Ingest: 단일 인스턴스 1M spans/s, p99 수집 latency < 200ms
  - Query: X-View 1시간/1M span 범위 쿼리 p99 < 500ms
  - UI: 초기 로드 < 1s, 인터랙션 < 16ms

### Phase 2 — Metrics (4주)
- OTel metrics + StatsD (UDS 선호, UDP 호환) 수신
- **고카디널리티** 처리: ClickHouse Projections + 사전계산 Materialized View
- PromQL-lite 호환 쿼리 엔진 (Rust)
- 대시보드 빌더 (서버 측 쿼리 병합, Arrow Flight 응답)
- **성능 SLO**: 1B active series에서 쿼리 p99 < 1s

### Phase 3 — Logs + 상관분석 (4주)
- OTel logs receiver + 네이티브 tailer (Rust, inotify/FSEvents)
- 파이프라인: grok/json 파싱은 SIMD 가속(simd-json)
- **trace_id 조인** 없이 풀텍스트→트레이스 점프 (bloom filter + skip index)
- 라이브테일 WebSocket
- **성능 SLO**: 1M logs/s 단일 노드, 풀텍스트 검색 p95 < 300ms

### Phase 4 — Smart Profiling ⭐ (6주)
- Continuous profiling: pprof/JFR/perf 수신 (Parca/Polar Signals 포맷 호환)
- eBPF 기반 CPU/heap 샘플러 (호스트 에이전트)
- 플레임그래프/아이시클/diff, 비동기·MSA 타임라인
- X-View 포인트 선택→해당 구간 플레임그래프 자동 합성
- **성능 SLO**: 대상 앱 오버헤드 < 1%, 플레임그래프 렌더 < 300ms

### Phase 5 — Alerting / Incident / On-call (4주)
- 모니터 DSL (Rust 평가기, 서브밀리초 평가)
- 통지: Slack/Telegram/Email/Webhook/Teams/PagerDuty
- 인시던트 + 온콜 + SLO/에러버짓

### Phase 6 — AI Auto-Ops + Insights ⭐ (6주, 운영성 상쇄 축)
- **Auto-tuning**: 수집 샘플링률·ClickHouse TTL·Projection을 부하에 맞게 자동 조정
- **이상탐지** (ONNX in-process): Prophet/LSTM/로보스트 이상탐지
- **X-View 패턴 인식** (surge/waterfall/droplet/wave — Jennifer 패턴 표준화, ML 분류기)
- **LLM 런북/챗봇**: "지금 왜 느려?"→자동 트레이스·로그 검색→요약 답변 (한/영/일)
- **자동 RCA**: 이상 구간의 상관지표/로그/트레이스 묶음

### Phase 7 — Multi-tenant SaaS + 온프레 패키지 (8주)
- RBAC, SSO(OIDC/SAML), 조직/워크스페이스
- 테넌트 파티션, row-level security
- Usage-based billing (ingested bytes, spans, retention)
- **단일 정적 바이너리** + Helm + Operator + 에어갭 tarball
- 라이선스 서버(엔터프라이즈)

### Phase 8 — Distribution / GTM
- OSS core / Cloud SaaS / Enterprise 삼단
- 벤치 리포트: datacat vs SigNoz vs Datadog (수집률, p99, 비용)
- 한국(Jennifer 리프레시) + 글로벌(HN/Reddit/GitHub 주도)

---

## 4. 퍼포먼스 타깃 요약 (단일 노드 기준)

| 지표 | 타깃 |
|---|---|
| Ingest (spans) | ≥ 1M/s |
| Ingest (metrics points) | ≥ 5M/s |
| Ingest (log lines) | ≥ 1M/s |
| 수집 p99 latency | < 200ms |
| X-View 쿼리 p99 (1h / 1M spans) | < 500ms |
| UI 인터랙션 | < 16ms (60fps) |
| Agent 오버헤드 | < 1% CPU |
| Collector 메모리 | 동일 부하 대비 Go 버전의 ≤ 1/3 |

---

## 5. 리스크 & 대응 (개정)

| 리스크 | 대응 |
|---|---|
| Rust 러닝커브·개발 속도 | 공통 crate 재사용 극대화, `axum`/`tokio`/`tonic` 생태계 적극 활용. 복잡한 프론트엔드 도메인 로직은 TS로 유지 |
| X-View 100만 점 WebGPU 난이도 | Phase 0에 2일 스파이크, Fallback은 WebGL2 regl |
| ClickHouse 운영(고성능 세팅) | 기본 Operator + **AI Auto-Ops가 자동 튜닝** — 운영성 상쇄 원칙의 첫 검증 |
| Redpanda 성숙도 | Kafka 프로토콜 호환이므로 비상시 Kafka 대체 가능 |
| OTel 스팩 변경 | Collector는 자체 Rust 구현이지만 외부 인터페이스는 OTLP 표준 고정 |
| eBPF 커널 버전 이슈 | CO-RE(libbpf-rs), 미지원 커널은 ptrace/proc 폴백 |
| 단일팀 범위 폭주 | 각 Phase 성능 SLO + 데모 가능이 "완료" 기준 |

---

## 6. 당장 다음 액션 (This Week)

1. **Rust workspace 스캐폴딩** + CI (cargo, clippy, deny, criterion 벤치)
2. **X-View 스파이크(2일 타임박스)**: WebGPU vs WebGL2 regl 1M 포인트 60fps 벤치
3. **RFC-001 ClickHouse 스키마 초안** (spans 테이블, Projections 후보)
4. **Ingest 벤치 테스트베드**: OTLP → 자체 Rust 수신기 → Redpanda → ClickHouse 파이프라인 PoC. 단일 노드 1M spans/s 가능성 측정
5. `docker compose up` 10초 부팅 목표 데모

---

## 7. 참고 링크

- [Datadog — Rust로 재작성한 시계열 엔진 Monocle](https://www.datadoghq.com/blog/engineering/rust-timeseries-engine/)
- [Datadog 커스텀 DB 배경 (ByteByteGo)](https://blog.bytebytego.com/p/how-datadog-built-a-custom-database)
- [SigNoz — OTel + ClickHouse (참고: Go 기반의 한계)](https://signoz.io/)
- [ClickStack — ClickHouse 공식 OTel 스택](https://clickhouse.com/resources/engineering/top-opentelemetry-compatible-platforms)
- [Uptrace — OTel APM](https://uptrace.dev/opentelemetry/apm)
- [Redpanda — JVM 없는 Kafka](https://redpanda.com/)
- [Apache Arrow Flight](https://arrow.apache.org/docs/format/Flight.html)
- [aya — Rust eBPF](https://aya-rs.dev/)
- [tokio-uring](https://github.com/tokio-rs/tokio-uring)
- [Pinpoint (스캐터 선행자)](https://pinpoint-apm.github.io/pinpoint/)
- [Scouter XLog](https://github.com/scouter-project/scouter)
