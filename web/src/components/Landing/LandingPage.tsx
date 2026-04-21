/**
 * LandingPage.tsx — Phase 8 About / documentation index
 *
 * Route: #/about
 *
 * Sections:
 *   1. Hero (install-first)
 *   2. Feature grid (6 cards, 3-column)
 *   3. Architecture diagram
 *   4. Performance SLOs
 *   5. Quick start
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

type InstallTab = 'shell' | 'docker' | 'kubernetes';

// ─── Data ─────────────────────────────────────────────────────────────────────

const FEATURES: FeatureCard[] = [
  {
    title:       'X-View Scatter',
    icon:        '◈',
    description: 'Jennifer-style real-time scatter plot. 500k points at 60fps via WebGL2.',
    tag:         'WebGL2',
  },
  {
    title:       'Distributed Tracing',
    icon:        '⟁',
    description: 'OTLP-native. Rust ingest pipeline. 1M spans/s throughput.',
    tag:         'OTLP',
  },
  {
    title:       'Metrics',
    icon:        '▦',
    description: 'Gauges, counters, histograms. Prometheus-compatible query interface.',
    tag:         'PromQL',
  },
  {
    title:       'Logs',
    icon:        '≡',
    description: 'Full-text search via ClickHouse tokenbf_v1. Live-tail WebSocket.',
    tag:         'ClickHouse',
  },
  {
    title:       'Profiling',
    icon:        '⬡',
    description: 'Continuous profiling. pprof flamegraphs. Icicle chart renderer.',
    tag:         'pprof',
  },
  {
    title:       'AI Auto-Ops',
    icon:        '◬',
    description: 'Z-score anomaly detection. Pattern recognition. Chat interface.',
    tag:         'Phase 6',
  },
];

const SLO_STATS: SloStat[] = [
  { label: 'Ingest throughput',      value: '1M',      sub: 'spans / second'    },
  { label: 'X-View query p99',       value: '<500ms',  sub: 'end-to-end latency' },
  { label: 'Collect latency p99',    value: '<200ms',  sub: 'collector pipeline' },
  { label: 'UI frame budget',        value: '<16ms',   sub: '60fps render target' },
];

const ARCH_DIAGRAM = `OTLP → datacat-collector → Redpanda → datacat-ingester → ClickHouse
                                                              ↓
Browser ← datacat-web ← datacat-api ← datacat-query ←────────┘`;

const QUICKSTART = `git clone https://github.com/your-org/datacat
cd datacat && ./scripts/quickstart.sh`;

const INSTALL_TABS: { id: InstallTab; label: string }[] = [
  { id: 'shell',      label: 'Linux / macOS' },
  { id: 'docker',     label: 'Docker'        },
  { id: 'kubernetes', label: 'Kubernetes'    },
];

const INSTALL_COMMANDS: Record<InstallTab, string> = {
  shell: `curl -sSL http://localhost:8000/install.sh | \\
  DATACAT_HOST=localhost:4317 \\
  DATACAT_SERVICE=my-app \\
  bash`,
  docker: `docker compose -f docker-compose.yml \\
  -f https://raw.githubusercontent.com/datacat/datacat/main/deploy/docker/docker-compose.otel.yml up -d`,
  kubernetes: `kubectl apply -f https://raw.githubusercontent.com/datacat/datacat/main/deploy/kubernetes/instrumentation.yaml`,
};

const INSTALL_HINTS: Record<InstallTab, string> = {
  shell:      'Auto-detects language · Installs OTel agent · Ships to your datacat cluster',
  docker:     'Adds OTel collector sidecar · Mounts shared network · Zero app changes needed',
  kubernetes: 'Deploys OTel operator · Auto-instruments pods via annotation · Cluster-wide',
};

const BULLETS = [
  '✓ Zero config — auto-detects Java / Python / Node / Go',
  '✓ No code changes — instrumentation via OTel SDK',
  '✓ On-prem or cloud — your choice',
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function InstallCard() {
  const [tab, setTab]       = useState<InstallTab>('shell');
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard.writeText(INSTALL_COMMANDS[tab]).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div style={s.installCard}>
      {/* Tab row */}
      <div style={s.tabRow}>
        {INSTALL_TABS.map(({ id, label }) => (
          <button
            key={id}
            style={tab === id ? s.tabActive : s.tabInactive}
            onClick={() => { setTab(id); setCopied(false); }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Code block */}
      <div style={s.codeWrap}>
        <pre style={s.installCode}>{INSTALL_COMMANDS[tab]}</pre>
        <button
          style={copied ? s.copyBtnDone : s.copyBtn}
          onClick={handleCopy}
          aria-label="Copy command"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      {/* Hint */}
      <p style={s.installHint}>{INSTALL_HINTS[tab]}</p>
    </div>
  );
}

function Hero() {
  return (
    <section style={s.hero}>
      <div style={s.heroInner}>
        {/* Headline */}
        <h1 style={s.heroH1}>Install datacat in 30 seconds.</h1>
        <p style={s.heroSubtitle}>
          Drop-in OpenTelemetry observability. Traces, metrics, logs, profiles — one platform, one line.
        </p>

        {/* Install card */}
        <InstallCard />

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

function FeatureGrid() {
  return (
    <section style={s.section}>
      <h2 style={s.sectionTitle}>Features</h2>
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
      <h2 style={s.sectionTitle}>Architecture</h2>
      <pre style={s.codeBlock}>{ARCH_DIAGRAM}</pre>
      <p style={s.archNote}>
        All components communicate via gRPC internally. The collector speaks OTLP/gRPC
        and OTLP/HTTP. ClickHouse stores spans, metrics, logs, and profiles in separate
        MergeTree tables with appropriate TTL policies.
      </p>
    </section>
  );
}

function PerformanceSLOs() {
  return (
    <section style={s.section}>
      <h2 style={s.sectionTitle}>Performance SLOs</h2>
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

function QuickStart() {
  return (
    <section style={s.section}>
      <h2 style={s.sectionTitle}>Quick Start</h2>
      <p style={s.quickStartSub}>
        Get a full observability stack running locally in under 2 minutes.
        Docker Compose orchestrates ClickHouse, Redpanda, and all datacat services.
      </p>
      <pre style={s.codeBlock}>{QUICKSTART}</pre>
      <p style={s.archNote}>
        The quickstart script spins up all required infrastructure via Docker Compose
        and exposes the UI on <code style={s.inlineCode}>http://localhost:5173</code>.
        Collector listens on <code style={s.inlineCode}>:4317</code> (gRPC) and{' '}
        <code style={s.inlineCode}>:4318</code> (HTTP).
      </p>
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
    </footer>
  );
}

// ─── Root component ───────────────────────────────────────────────────────────

export function LandingPage() {
  return (
    <div style={s.root}>
      <div style={s.scrollArea}>
        <Hero />
        <FeatureGrid />
        <ArchDiagram />
        <PerformanceSLOs />
        <QuickStart />
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
    minHeight:      '70vh',
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
    letterSpacing: '-0.03em',
    lineHeight:    1.1,
    margin:        '0 0 16px',
  },
  heroSubtitle: {
    fontSize:   17,
    color:      TEXT_SEC,
    lineHeight: 1.6,
    margin:     '0 0 40px',
    maxWidth:   620,
    marginLeft: 'auto',
    marginRight: 'auto',
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
    display:    'flex',
    gap:        8,
    padding:    '16px 20px 0',
    borderBottom: `1px solid ${BORDER}`,
    paddingBottom: 0,
  },
  tabActive: {
    fontSize:       12,
    fontWeight:     600,
    color:          BG_PAGE,
    background:     ACCENT,
    border:         `1px solid ${ACCENT}`,
    borderRadius:   20,
    padding:        '5px 14px',
    cursor:         'pointer',
    marginBottom:   12,
    fontFamily:     SANS,
    outline:        'none',
  },
  tabInactive: {
    fontSize:       12,
    fontWeight:     600,
    color:          TEXT_SEC,
    background:     'transparent',
    border:         `1px solid ${BORDER2}`,
    borderRadius:   20,
    padding:        '5px 14px',
    cursor:         'pointer',
    marginBottom:   12,
    fontFamily:     SANS,
    outline:        'none',
  },
  codeWrap: {
    position:   'relative',
    padding:    '24px 20px 20px',
  },
  installCode: {
    fontFamily: MONO,
    fontSize:   14,
    lineHeight: 1.7,
    color:      '#E6EDF3',
    margin:     0,
    whiteSpace: 'pre',
    overflowX:  'auto',
    paddingRight: 80,
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
  installHint: {
    fontSize:     12,
    color:        TEXT_DIM,
    margin:       '0',
    padding:      '0 20px 18px',
    fontFamily:   MONO,
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
    letterSpacing: '0.1em',
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

  // ── Quick start ───────────────────────────────────────────────────────────
  quickStartSub: {
    fontSize:   14,
    color:      TEXT_SEC,
    lineHeight: 1.7,
    margin:     '0 0 20px',
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
