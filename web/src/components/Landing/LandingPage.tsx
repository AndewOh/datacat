/**
 * LandingPage.tsx — Phase 8 About / documentation index
 *
 * Route: #/about
 *
 * Sections:
 *   1. Hero
 *   2. Feature grid (6 cards, 3-column)
 *   3. Architecture diagram
 *   4. Performance SLOs
 *   5. Quick start
 *   6. Footer
 */

import type { CSSProperties } from 'react';

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

// ─── Sub-components ───────────────────────────────────────────────────────────

function Hero() {
  return (
    <section style={s.hero}>
      <div style={s.heroInner}>
        <div style={s.heroLogo}>
          <span style={s.heroLogoText}>datacat</span>
          <span style={s.heroLogoDot}>.</span>
        </div>
        <p style={s.heroTagline}>
          1M spans/second.&nbsp; Sub-500ms X-View.&nbsp; Self-hosted.
        </p>
        <p style={s.heroSub}>
          Open-source observability platform combining Jennifer APM's X-View with
          Datadog-breadth signal coverage — built on Rust, ClickHouse, and Redpanda.
        </p>
        <div style={s.heroBadges}>
          {['Rust', 'ClickHouse', 'Redpanda', 'OTLP', 'WebGL2', 'Self-hosted'].map((b) => (
            <span key={b} style={s.badge}>{b}</span>
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
const BORDER   = '#21262D';
const TEXT_PRI = '#C9D1D9';
const TEXT_SEC = '#8B949E';
const TEXT_DIM = 'rgba(139,148,158,0.6)';
const MONO     = "'Courier New', 'Menlo', 'Monaco', monospace";
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

  // Hero
  hero: {
    padding:         '72px 0 64px',
    borderBottom:    `1px solid ${BORDER}`,
    textAlign:       'center',
  },
  heroInner: {
    maxWidth:  720,
    margin:    '0 auto',
    padding:   '0 24px',
  },
  heroLogo: {
    display:        'inline-flex',
    alignItems:     'baseline',
    gap:            2,
    marginBottom:   20,
  },
  heroLogoText: {
    fontSize:      48,
    fontWeight:    800,
    color:         TEXT_PRI,
    fontFamily:    MONO,
    letterSpacing: '-0.04em',
    lineHeight:    1,
  },
  heroLogoDot: {
    fontSize:   56,
    fontWeight: 800,
    color:      ACCENT,
    lineHeight: 1,
  },
  heroTagline: {
    fontSize:     22,
    fontWeight:   600,
    color:        TEXT_PRI,
    margin:       '0 0 16px',
    letterSpacing: '-0.01em',
    lineHeight:   1.4,
  },
  heroSub: {
    fontSize:   15,
    color:      TEXT_SEC,
    lineHeight: 1.7,
    margin:     '0 0 28px',
    maxWidth:   600,
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  heroBadges: {
    display:        'flex',
    gap:            8,
    justifyContent: 'center',
    flexWrap:       'wrap',
  },
  badge: {
    fontSize:     11,
    fontWeight:   600,
    color:        ACCENT,
    background:   'rgba(88,166,255,0.08)',
    border:       `1px solid rgba(88,166,255,0.2)`,
    borderRadius: 4,
    padding:      '4px 10px',
    fontFamily:   MONO,
    letterSpacing: '0.04em',
  },

  // Sections
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

  // Feature grid
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
    display:     'flex',
    alignItems:  'center',
    gap:         8,
    marginBottom: 10,
  },
  cardIcon: {
    fontSize:  16,
    color:     ACCENT,
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
    fontSize:     10,
    fontWeight:   600,
    color:        TEXT_DIM,
    background:   'rgba(48,54,61,0.8)',
    borderRadius: 3,
    padding:      '2px 6px',
    fontFamily:   MONO,
    letterSpacing: '0.04em',
    flexShrink:   0,
  },
  cardDesc: {
    fontSize:   13,
    color:      TEXT_SEC,
    lineHeight: 1.6,
    margin:     0,
  },

  // Architecture
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

  // SLO grid
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

  // Quick start
  quickStartSub: {
    fontSize:   14,
    color:      TEXT_SEC,
    lineHeight: 1.7,
    margin:     '0 0 20px',
  },

  // Footer
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
