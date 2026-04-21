/**
 * LandingPage.tsx — Phase 8 About / documentation index
 *
 * Route: #/about
 *
 * Sections:
 *   1. Hero (대상 앱 에이전트 설치)
 *   2. Server Install (datacat 서버 설치)
 *   3. Feature grid (6 cards, 3-column)
 *   4. Architecture diagram
 *   5. Performance SLOs
 *   6. Footer
 */

import { useState, type CSSProperties } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface FeatureCard {
  title: string;
  icon: string;
  description: string;
  tag: string;
}

interface SloStat {
  label: string;
  value: string;
  sub: string;
}

interface TabDef {
  id: string;
  label: string;
}

interface InstallCardProps {
  tabs: TabDef[];
  commands: Record<string, string>;
  hints: Record<string, string>;
  defaultTab: string;
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const FEATURES: FeatureCard[] = [
  {
    title:       'X-View Scatter',
    icon:        '◈',
    description: 'Jennifer 스타일 실시간 산점도. WebGL2로 500k 포인트 60fps.',
    tag:         'WebGL2',
  },
  {
    title:       'Distributed Tracing',
    icon:        '⟁',
    description: 'OTLP 네이티브. Rust 인게스트 파이프라인. 초당 100만 스팬.',
    tag:         'OTLP',
  },
  {
    title:       'Metrics',
    icon:        '▦',
    description: '게이지·카운터·히스토그램. Prometheus 호환 쿼리.',
    tag:         'PromQL',
  },
  {
    title:       'Logs',
    icon:        '≡',
    description: 'ClickHouse tokenbf_v1 기반 전문 검색. WebSocket 라이브테일.',
    tag:         'ClickHouse',
  },
  {
    title:       'Profiling',
    icon:        '⬡',
    description: 'continuous profiling. pprof 플레임그래프. icicle 차트.',
    tag:         'pprof',
  },
  {
    title:       'AI Auto-Ops',
    icon:        '◬',
    description: 'Z-score 이상 탐지. 패턴 인식. 챗 인터페이스.',
    tag:         'Phase 6',
  },
];

const SLO_STATS: SloStat[] = [
  { label: '인제스트 처리량',   value: '1M',      sub: '초당 스팬'          },
  { label: 'X-View 쿼리 p99',  value: '<500ms',  sub: '엔드투엔드 지연'    },
  { label: '수집 지연 p99',     value: '<200ms',  sub: '컬렉터 파이프라인'  },
  { label: 'UI 프레임 예산',    value: '<16ms',   sub: '60fps 렌더 타겟'    },
];

const ARCH_DIAGRAM = `OTLP → datacat-collector → Redpanda → datacat-ingester → ClickHouse
                                                              ↓
Browser ← datacat-web ← datacat-api ← datacat-query ←────────┘`;

// ── Hero (앱 에이전트) install data ──────────────────────────────────────────

const HERO_TABS: TabDef[] = [
  { id: 'host',       label: '호스트 에이전트'          },
  { id: 'docker',     label: 'Docker Compose'           },
  { id: 'kubernetes', label: 'Kubernetes Auto-Inject'   },
];

const HERO_COMMANDS: Record<string, string> = {
  host: `curl -sSL http://localhost:8000/install.sh | \\
  DATACAT_HOST=localhost:4317 \\
  DATACAT_SERVICE=my-app \\
  bash`,
  docker: `docker compose -f docker-compose.yml \\
  -f https://raw.githubusercontent.com/datacat/datacat/main/deploy/docker/docker-compose.otel.yml up -d`,
  kubernetes: `kubectl apply -f https://raw.githubusercontent.com/datacat/datacat/main/deploy/kubernetes/instrumentation.yaml`,
};

const HERO_HINTS: Record<string, string> = {
  host:       '언어 자동 감지 · OTel 자동 계측 에이전트 설치 · datacat 클러스터로 전송',
  docker:     '사이드카 OTel Collector를 기존 스택에 오버레이 · 재시작 없이 삽입',
  kubernetes: 'OpenTelemetry Operator가 pod annotation 기반으로 자동 주입',
};

// ── Server install data ──────────────────────────────────────────────────────

const SERVER_TABS: TabDef[] = [
  { id: 'docker',     label: 'Docker Compose' },
  { id: 'kubernetes', label: 'Kubernetes'     },
];

const SERVER_COMMANDS: Record<string, string> = {
  docker: `git clone https://github.com/datacat/datacat && cd datacat
docker compose -f deploy/docker-compose.yml up -d`,
  kubernetes: `DATACAT_HOST=<your-host>:4317 bash <(curl -sSL https://raw.githubusercontent.com/datacat/datacat/main/deploy/kubernetes/install.sh)`,
};

const SERVER_HINTS: Record<string, string> = {
  docker:     'Collector · Ingester · ClickHouse · Redpanda를 한 명령으로 기동',
  kubernetes: 'Helm 차트 기반 클러스터 배포. DATACAT_HOST를 컬렉터 수신 주소로 지정',
};

const BULLETS = [
  '✓ 제로 설정 — Java · Python · Node · Go 자동 감지',
  '✓ 코드 수정 불필요 — OTel SDK 기반 계측',
  '✓ 온프레미스 · 클라우드 자유 선택',
];

// ─── Sub-components ───────────────────────────────────────────────────────────

type CopyState = 'idle' | 'copied' | 'failed';

function InstallCard({ tabs, commands, hints, defaultTab }: InstallCardProps) {
  const [tab, setTab]           = useState<string>(defaultTab);
  const [copyState, setCopyState] = useState<CopyState>('idle');

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(commands[tab]);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    setTimeout(() => setCopyState('idle'), 1500);
  }

  const copyLabel =
    copyState === 'copied' ? '복사됨!' :
    copyState === 'failed' ? '복사 실패' :
    '복사';

  return (
    <div style={s.installCard}>
      {/* Tab row */}
      <div style={s.tabRow}>
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            style={tab === id ? s.tabActive : s.tabInactive}
            onClick={() => { setTab(id); setCopyState('idle'); }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Code block */}
      <div style={s.codeWrap}>
        <pre style={s.installCode}>{commands[tab]}</pre>
        <button
          style={copyState === 'idle' ? s.copyBtn : copyState === 'copied' ? s.copyBtnDone : s.copyBtnFail}
          onClick={() => { void handleCopy(); }}
          aria-label="명령어 복사"
        >
          {copyLabel}
        </button>
      </div>

      {/* Hint */}
      <p style={s.installHint}>{hints[tab]}</p>
    </div>
  );
}

function Hero() {
  return (
    <section style={s.hero}>
      <div style={s.heroInner}>
        {/* Headline */}
        <h1 style={s.heroH1}>앱에서 텔레메트리를 30초만에 수집하세요.</h1>
        <p style={s.heroSubtitle}>
          OpenTelemetry 기반 드롭인 관측 플랫폼. 트레이스·메트릭·로그·프로파일을 한 줄로.
        </p>

        {/* Target banner */}
        <div style={s.targetBanner}>
          🎯 아래 명령은 <strong>모니터링 대상 서비스 머신</strong>에서 실행합니다
        </div>

        {/* Install card */}
        <InstallCard
          tabs={HERO_TABS}
          commands={HERO_COMMANDS}
          hints={HERO_HINTS}
          defaultTab="host"
        />

        {/* Supporting bullets */}
        <div style={s.bullets}>
          {BULLETS.map((b) => (
            <span key={b} style={s.bullet}>{b}</span>
          ))}
        </div>
      </div>
    </section>
  );
}

function ServerInstall() {
  return (
    <section style={s.serverSection}>
      <div style={s.serverInner}>
        <h2 style={s.serverH2}>datacat 서버 설치</h2>
        <p style={s.serverSub}>
          Collector · Ingester · ClickHouse · Redpanda 인프라를 한 명령으로.
        </p>
        <InstallCard
          tabs={SERVER_TABS}
          commands={SERVER_COMMANDS}
          hints={SERVER_HINTS}
          defaultTab="docker"
        />
      </div>
    </section>
  );
}

function FeatureGrid() {
  return (
    <section style={s.section}>
      <h2 style={s.sectionTitle}>핵심 기능</h2>
      <div style={s.grid}>
        {FEATURES.map((f) => (
          <FeatureCardItem key={f.title} card={f} />
        ))}
      </div>
    </section>
  );
}

function FeatureCardItem({ card }: { card: FeatureCard }) {
  return (
    <div
      style={s.card}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = '#30363D';
        (e.currentTarget as HTMLDivElement).style.background = 'rgba(33,38,45,0.9)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = '#21262D';
        (e.currentTarget as HTMLDivElement).style.background = 'rgba(22,27,34,0.6)';
      }}
    >
      <div style={s.cardHeader}>
        <span style={s.cardIcon}>{card.icon}</span>
        <span style={s.cardTitle}>{card.title}</span>
        <span style={s.cardTag}>{card.tag}</span>
      </div>
      <p style={s.cardDesc}>{card.description}</p>
    </div>
  );
}

function ArchDiagram() {
  return (
    <section style={s.section}>
      <h2 style={s.sectionTitle}>아키텍처</h2>
      <pre style={s.codeBlock}>{ARCH_DIAGRAM}</pre>
      <p style={s.archNote}>
        모든 컴포넌트는 내부적으로 gRPC로 통신합니다. 컬렉터는 OTLP/gRPC와 OTLP/HTTP를 지원하며,
        ClickHouse는 스팬·메트릭·로그·프로파일을 각각 별도의 MergeTree 테이블에 TTL 정책과 함께 저장합니다.
      </p>
    </section>
  );
}

function PerformanceSLOs() {
  return (
    <section style={s.section}>
      <h2 style={s.sectionTitle}>성능 목표 (SLO)</h2>
      <div style={s.sloGrid}>
        {SLO_STATS.map((stat) => (
          <div key={stat.label} style={s.sloCard}>
            <span style={s.sloValue}>{stat.value}</span>
            <span style={s.sloLabel}>{stat.label}</span>
            <span style={s.sloSub}>{stat.sub}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer style={s.footer}>
      <span>Built with&nbsp;</span>
      <span style={s.footerRust}>Rust 🦀</span>
      <span style={s.footerDivider}> | </span>
      <span>ClickHouse</span>
      <span style={s.footerDivider}> | </span>
      <span>Redpanda</span>
      <span style={s.footerDivider}> | </span>
      <span>WebGL2</span>
      <span style={s.footerDivider}> | </span>
      <span>© 2025 datacat</span>
    </footer>
  );
}

// ─── Root component ───────────────────────────────────────────────────────────

export function LandingPage() {
  return (
    <div style={s.root}>
      <div style={s.scrollArea}>
        <Hero />
        <ServerInstall />
        <FeatureGrid />
        <ArchDiagram />
        <PerformanceSLOs />
        <Footer />
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const ACCENT   = '#58A6FF';
const BG_PAGE  = '#0D1117';
const BG_CARD  = 'rgba(22,27,34,0.6)';
const BG_CARD2 = '#161B22';
const BG_SERVER = '#0A0F15';
const BORDER   = '#21262D';
const BORDER2  = '#30363D';
const TEXT_PRI = '#C9D1D9';
const TEXT_SEC = '#8B949E';
const TEXT_DIM = 'rgba(139,148,158,0.6)';
const MONO     = "'ui-monospace', 'Menlo', 'Monaco', monospace";
const SANS     = 'system-ui, -apple-system, sans-serif';

const s: Record<string, CSSProperties> = {
  root: {
    display:    'flex',
    flex:       1,
    background: BG_PAGE,
    overflow:   'hidden',
    fontFamily: SANS,
  },
  scrollArea: {
    flex:       1,
    overflowY:  'auto',
    overflowX:  'hidden',
  },

  // ── Hero ──────────────────────────────────────────────────────────────────
  hero: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    padding:        '72px 24px 64px',
    borderBottom:   `1px solid ${BORDER}`,
  },
  heroInner: {
    maxWidth:  780,
    width:     '100%',
    margin:    '0 auto',
    textAlign: 'center',
  },
  heroH1: {
    fontSize:      48,
    fontWeight:    800,
    color:         TEXT_PRI,
    letterSpacing: '-0.02em',
    lineHeight:    1.1,
    margin:        '0 0 16px',
  },
  heroSubtitle: {
    fontSize:    17,
    color:       TEXT_SEC,
    lineHeight:  1.6,
    margin:      '0 auto 32px',
    maxWidth:    620,
  },

  // ── Target banner ──────────────────────────────────────────────────────────
  targetBanner: {
    display:      'inline-block',
    fontSize:     13,
    color:        '#E6C87A',
    background:   'rgba(230,200,122,0.08)',
    border:       '1px solid rgba(230,200,122,0.2)',
    borderRadius: 6,
    padding:      '7px 16px',
    marginBottom: 20,
    lineHeight:   1.5,
  },

  // ── Install card ──────────────────────────────────────────────────────────
  installCard: {
    background:   BG_CARD2,
    border:       `1px solid ${BORDER2}`,
    borderRadius: 12,
    overflow:     'hidden',
    marginBottom: 32,
    textAlign:    'left',
  },
  tabRow: {
    display:       'flex',
    gap:           8,
    padding:       '16px 20px 12px',
    borderBottom:  `1px solid ${BORDER}`,
  },
  tabActive: {
    fontSize:     12,
    fontWeight:   600,
    color:        BG_PAGE,
    background:   ACCENT,
    border:       `1px solid ${ACCENT}`,
    borderRadius: 20,
    padding:      '5px 14px',
    cursor:       'pointer',
    fontFamily:   SANS,
    outline:      'none',
  },
  tabInactive: {
    fontSize:     12,
    fontWeight:   600,
    color:        TEXT_SEC,
    background:   'transparent',
    border:       `1px solid ${BORDER2}`,
    borderRadius: 20,
    padding:      '5px 14px',
    cursor:       'pointer',
    fontFamily:   SANS,
    outline:      'none',
  },
  codeWrap: {
    position: 'relative',
    padding:  '24px 20px 20px',
  },
  installCode: {
    fontFamily:   MONO,
    fontSize:     14,
    lineHeight:   1.7,
    color:        '#E6EDF3',
    margin:       0,
    whiteSpace:   'pre',
    overflowX:    'auto',
    paddingRight: 90,
  },
  copyBtn: {
    position:     'absolute',
    top:          16,
    right:        16,
    fontSize:     11,
    fontWeight:   600,
    color:        TEXT_SEC,
    background:   'transparent',
    border:       `1px solid ${BORDER2}`,
    borderRadius: 6,
    padding:      '4px 12px',
    cursor:       'pointer',
    fontFamily:   SANS,
    outline:      'none',
    whiteSpace:   'nowrap',
  },
  copyBtnDone: {
    position:     'absolute',
    top:          16,
    right:        16,
    fontSize:     11,
    fontWeight:   600,
    color:        ACCENT,
    background:   'rgba(88,166,255,0.1)',
    border:       `1px solid rgba(88,166,255,0.3)`,
    borderRadius: 6,
    padding:      '4px 12px',
    cursor:       'pointer',
    fontFamily:   SANS,
    outline:      'none',
    whiteSpace:   'nowrap',
  },
  copyBtnFail: {
    position:     'absolute',
    top:          16,
    right:        16,
    fontSize:     11,
    fontWeight:   600,
    color:        '#F97316',
    background:   'rgba(249,115,22,0.1)',
    border:       `1px solid rgba(249,115,22,0.3)`,
    borderRadius: 6,
    padding:      '4px 12px',
    cursor:       'pointer',
    fontFamily:   SANS,
    outline:      'none',
    whiteSpace:   'nowrap',
  },
  installHint: {
    fontSize:      12,
    color:         TEXT_DIM,
    margin:        0,
    padding:       '0 20px 18px',
    fontFamily:    MONO,
    letterSpacing: '0.01em',
  },

  // ── Bullets ───────────────────────────────────────────────────────────────
  bullets: {
    display:        'flex',
    gap:            24,
    justifyContent: 'center',
    flexWrap:       'wrap',
  },
  bullet: {
    fontSize:   13,
    color:      TEXT_SEC,
    lineHeight: 1.5,
  },

  // ── Server Install section ─────────────────────────────────────────────────
  serverSection: {
    background:   BG_SERVER,
    borderBottom: `1px solid ${BORDER}`,
    padding:      '56px 24px',
  },
  serverInner: {
    maxWidth: 780,
    margin:   '0 auto',
  },
  serverH2: {
    fontSize:      22,
    fontWeight:    700,
    color:         TEXT_PRI,
    letterSpacing: '-0.01em',
    margin:        '0 0 8px',
  },
  serverSub: {
    fontSize:   15,
    color:      TEXT_SEC,
    lineHeight: 1.6,
    margin:     '0 0 28px',
  },

  // ── Sections ──────────────────────────────────────────────────────────────
  section: {
    maxWidth:     960,
    margin:       '0 auto',
    padding:      '56px 24px',
    borderBottom: `1px solid ${BORDER}`,
  },
  sectionTitle: {
    fontSize:      13,
    fontWeight:    700,
    color:         TEXT_DIM,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    margin:        '0 0 28px',
    fontFamily:    MONO,
  },

  // ── Feature grid ──────────────────────────────────────────────────────────
  grid: {
    display:             'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap:                 16,
  },
  card: {
    background:   BG_CARD,
    border:       `1px solid ${BORDER}`,
    borderRadius: 8,
    padding:      '20px 20px 18px',
    transition:   'border-color 0.15s ease, background 0.15s ease',
    cursor:       'default',
  },
  cardHeader: {
    display:      'flex',
    alignItems:   'center',
    gap:          8,
    marginBottom: 10,
  },
  cardIcon: {
    fontSize:   16,
    color:      ACCENT,
    flexShrink: 0,
    lineHeight: 1,
  },
  cardTitle: {
    fontSize:   13,
    fontWeight: 600,
    color:      TEXT_PRI,
    flex:       1,
  },
  cardTag: {
    fontSize:      10,
    fontWeight:    600,
    color:         TEXT_DIM,
    background:    'rgba(48,54,61,0.8)',
    borderRadius:  3,
    padding:       '2px 6px',
    fontFamily:    MONO,
    letterSpacing: '0.04em',
    flexShrink:    0,
  },
  cardDesc: {
    fontSize:   13,
    color:      TEXT_SEC,
    lineHeight: 1.6,
    margin:     0,
  },

  // ── Architecture ──────────────────────────────────────────────────────────
  codeBlock: {
    background:   'rgba(13,17,23,0.8)',
    border:       `1px solid ${BORDER}`,
    borderRadius: 8,
    padding:      '20px 24px',
    fontFamily:   MONO,
    fontSize:     13,
    lineHeight:   1.65,
    color:        TEXT_PRI,
    overflowX:    'auto',
    margin:       0,
    whiteSpace:   'pre',
  },
  archNote: {
    fontSize:   13,
    color:      TEXT_SEC,
    lineHeight: 1.7,
    margin:     '16px 0 0',
  },
  inlineCode: {
    fontFamily:   MONO,
    fontSize:     12,
    color:        ACCENT,
    background:   'rgba(88,166,255,0.08)',
    borderRadius: 3,
    padding:      '1px 5px',
    border:       `1px solid rgba(88,166,255,0.15)`,
  },

  // ── SLO grid ──────────────────────────────────────────────────────────────
  sloGrid: {
    display:             'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap:                 16,
  },
  sloCard: {
    background:    'rgba(22,27,34,0.6)',
    border:        `1px solid ${BORDER}`,
    borderRadius:  8,
    padding:       '20px 20px 18px',
    display:       'flex',
    flexDirection: 'column',
    gap:           4,
  },
  sloValue: {
    fontSize:      28,
    fontWeight:    700,
    color:         ACCENT,
    fontFamily:    MONO,
    letterSpacing: '-0.03em',
    lineHeight:    1,
  },
  sloLabel: {
    fontSize:   12,
    fontWeight: 600,
    color:      TEXT_PRI,
    lineHeight: 1.3,
    marginTop:  4,
  },
  sloSub: {
    fontSize: 11,
    color:    TEXT_DIM,
  },

  // ── Footer ────────────────────────────────────────────────────────────────
  footer: {
    maxWidth:       960,
    margin:         '0 auto',
    padding:        '32px 24px 48px',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    flexWrap:       'wrap',
    fontSize:       13,
    color:          TEXT_DIM,
    gap:            0,
    fontFamily:     SANS,
  },
  footerRust: {
    color: '#F97316',
  },
  footerDivider: {
    color:   BORDER,
    padding: '0 4px',
  },
};
