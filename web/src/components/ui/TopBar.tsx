/**
 * TopBar.tsx — 시간 범위 선택 + 서비스 드롭다운 + 통계 뱃지
 */

import type { XViewStats, Service } from '../../api/client';

const TIME_RANGES = [
  { label: 'Last 15m', value: '15m' },
  { label: 'Last 1h',  value: '1h'  },
  { label: 'Last 6h',  value: '6h'  },
  { label: 'Last 24h', value: '24h' },
] as const;

interface TopBarProps {
  timeRange: string;
  onTimeRangeChange: (value: string) => void;
  selectedService: string | null;
  onServiceChange: (value: string | null) => void;
  services: Service[];
  stats: XViewStats | null;
  loading?: boolean;
  usingMock?: boolean;
}

function fmtNs(ns: number): string {
  if (ns <= 0) return '—';
  const ms = ns / 1_000_000;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 1)    return `${ms.toFixed(1)}ms`;
  return `${(ns / 1000).toFixed(0)}µs`;
}

function errorRate(stats: XViewStats): string {
  if (!stats.total) return '0%';
  return `${((stats.errors / stats.total) * 100).toFixed(2)}%`;
}

export function TopBar({
  timeRange,
  onTimeRangeChange,
  selectedService,
  onServiceChange,
  services,
  stats,
  loading = false,
  usingMock = false,
}: TopBarProps) {
  const errRate = stats ? (stats.errors / Math.max(stats.total, 1)) * 100 : 0;
  const errColor = errRate > 1 ? '#F85149' : '#3FB950';

  return (
    <header style={styles.topbar} role="banner">
      {/* Brand */}
      <div style={styles.brand}>
        <span style={styles.brandText}>datacat</span>
        <span style={styles.brandDot}>.</span>
        <span style={styles.brandSub}>X-View</span>
      </div>

      {/* Time range selector */}
      <div style={styles.controls} role="group" aria-label="Time range">
        {TIME_RANGES.map((tr) => {
          const active = timeRange === tr.value;
          return (
            <button
              key={tr.value}
              style={{
                ...styles.rangeBtn,
                background:   active ? 'rgba(88,166,255,0.15)' : 'transparent',
                color:        active ? '#58A6FF' : 'rgba(201,209,217,0.45)',
                borderColor:  active ? 'rgba(88,166,255,0.4)'  : 'rgba(48,54,61,0.8)',
              }}
              onClick={() => onTimeRangeChange(tr.value)}
              aria-pressed={active}
            >
              {tr.label}
            </button>
          );
        })}
      </div>

      {/* Service dropdown */}
      <div style={styles.dropdownWrap}>
        <select
          style={styles.dropdown}
          value={selectedService ?? ''}
          onChange={(e) => onServiceChange(e.target.value || null)}
          aria-label="Select service"
        >
          <option value="">All Services</option>
          {services.map((svc) => (
            <option key={`${svc.name}:${svc.env}`} value={svc.name}>
              {svc.name} ({svc.env})
            </option>
          ))}
        </select>
      </div>

      {/* Stats badges */}
      {stats && (
        <div style={styles.statsRow} aria-label="Current statistics">
          <div style={styles.statBadge} title="Total spans">
            <span style={styles.statLabel}>Spans</span>
            <span style={styles.statValue}>{stats.total.toLocaleString()}</span>
          </div>
          <div style={styles.statBadge} title="Error rate">
            <span style={styles.statLabel}>Err%</span>
            <span style={{ ...styles.statValue, color: errColor }}>
              {errorRate(stats)}
            </span>
          </div>
          <div style={styles.statBadge} title="p99 response time">
            <span style={styles.statLabel}>p99</span>
            <span style={styles.statValue}>{fmtNs(stats.p99_ns)}</span>
          </div>
        </div>
      )}

      {/* Mock / loading indicators */}
      <div style={styles.rightArea}>
        {usingMock && (
          <span style={styles.mockBadge} title="API 서버 없음 — mock 데이터 표시 중">
            MOCK
          </span>
        )}
        {loading ? (
          <span style={styles.spinner} aria-label="Loading" />
        ) : (
          <>
            <span style={styles.liveDot} aria-hidden="true" />
            <span style={styles.liveLabel}>LIVE</span>
          </>
        )}
      </div>
    </header>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  topbar: {
    height: 48,
    background: '#161B22',
    borderBottom: '1px solid #30363D',
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    gap: 12,
    flexShrink: 0,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  brand: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 2,
    marginRight: 4,
    flexShrink: 0,
  },
  brandText: {
    fontSize: 14,
    fontWeight: 700,
    color: '#C9D1D9',
    fontFamily: 'ui-monospace, monospace',
    letterSpacing: '-0.02em',
  },
  brandDot: {
    fontSize: 18,
    fontWeight: 700,
    color: '#58A6FF',
    lineHeight: 1,
  },
  brandSub: {
    fontSize: 11,
    color: 'rgba(201,209,217,0.4)',
    fontFamily: 'ui-monospace, monospace',
    marginLeft: 4,
  },
  controls: {
    display: 'flex',
    gap: 4,
    flexShrink: 0,
  },
  rangeBtn: {
    padding: '4px 10px',
    border: '1px solid',
    borderRadius: 4,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    transition: 'all 0.12s ease',
    letterSpacing: '0.01em',
    whiteSpace: 'nowrap' as const,
  },
  dropdownWrap: {
    flexShrink: 0,
  },
  dropdown: {
    background: '#0D1117',
    color: '#C9D1D9',
    border: '1px solid #30363D',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    cursor: 'pointer',
    outline: 'none',
    maxWidth: 180,
  },
  statsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  statBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    background: 'rgba(48,54,61,0.6)',
    border: '1px solid #30363D',
    borderRadius: 4,
    padding: '3px 8px',
  },
  statLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'rgba(201,209,217,0.4)',
    letterSpacing: '0.06em',
    fontFamily: 'ui-monospace, monospace',
  },
  statValue: {
    fontSize: 12,
    fontWeight: 600,
    color: '#C9D1D9',
    fontFamily: 'ui-monospace, monospace',
  },
  rightArea: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginLeft: 'auto',
    flexShrink: 0,
  },
  mockBadge: {
    fontSize: 9,
    fontWeight: 700,
    color: '#f0c060',
    background: 'rgba(240,192,96,0.1)',
    border: '1px solid rgba(240,192,96,0.3)',
    borderRadius: 3,
    padding: '2px 5px',
    letterSpacing: '0.08em',
    fontFamily: 'ui-monospace, monospace',
  },
  spinner: {
    display: 'inline-block',
    width: 12,
    height: 12,
    border: '2px solid rgba(88,166,255,0.25)',
    borderTopColor: '#58A6FF',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    background: '#3FB950',
    boxShadow: '0 0 6px #3FB950',
    animation: 'pulse 2s ease-in-out infinite',
  },
  liveLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: '#3FB950',
    letterSpacing: '0.08em',
    fontFamily: 'ui-monospace, monospace',
  },
} as const;
