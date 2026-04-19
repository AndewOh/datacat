/**
 * App.tsx — SPA 루트 컴포넌트
 *
 * Hash 라우팅 (외부 의존성 없음):
 *   #/          → X-View 대시보드 (Phase 1)
 *   #/metrics   → 대시보드 빌더  (Phase 2)
 *   #/logs      → Logs            (Phase 3 placeholder)
 *   #/profiling → Profiling       (Phase 4 placeholder)
 *   #/insights  → AI Auto-Ops     (Phase 6)
 */

import { useState, useEffect, useCallback } from 'react';
import type { CSSProperties } from 'react';
import { Dashboard } from './components/Dashboard/Dashboard';
import { MetricsDashboard } from './components/Dashboard/MetricsDashboard';
import { LogsView } from './components/Logs/LogsView';
import { ProfilingView } from './components/Profiling/ProfilingView';
import { InsightsView } from './components/Insights/InsightsView';
import { LandingPage } from './components/Landing/LandingPage';
import { MetricsExplorer } from './components/MetricsExplorer/MetricsExplorer';
import { LogMetricsView } from './components/LogMetrics/LogMetricsView';

// ─── Route definitions ────────────────────────────────────────────────────────

type Route = '/' | '/metrics' | '/explorer' | '/logs' | '/log-rules' | '/profiling' | '/insights' | '/about';

const NAV_ITEMS: Array<{ label: string; route: Route; phase?: string }> = [
  { label: 'X-View',    route: '/'          },
  { label: 'Dashboard', route: '/metrics'   },
  { label: 'Explorer',  route: '/explorer'  },
  { label: 'Logs',      route: '/logs'      },
  { label: 'Log Rules', route: '/log-rules' },
  { label: 'Profiling', route: '/profiling' },
  { label: 'Insights',  route: '/insights'  },
  { label: 'About',     route: '/about'     },
];

function getRoute(): Route {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  const valid: Route[] = ['/', '/metrics', '/explorer', '/logs', '/log-rules', '/profiling', '/insights', '/about'];
  return valid.includes(hash as Route) ? (hash as Route) : '/';
}

// ─── Time range shared state (used by both Dashboard views) ───────────────────

const TIME_RANGES = [
  { label: '15m', value: '15m' },
  { label: '1h',  value: '1h'  },
  { label: '6h',  value: '6h'  },
  { label: '24h', value: '24h' },
] as const;

// ─── NavBar ───────────────────────────────────────────────────────────────────

interface NavBarProps {
  route: Route;
  onNavigate: (r: Route) => void;
  timeRange: string;
  onTimeRangeChange: (v: string) => void;
}

function NavBar({ route, onNavigate, timeRange, onTimeRangeChange }: NavBarProps) {
  return (
    <nav style={navStyles.bar} role="navigation" aria-label="Main navigation">
      {/* Logo */}
      <div style={navStyles.logo}>
        <span style={navStyles.logoText}>datacat</span>
        <span style={navStyles.logoDot}>.</span>
      </div>

      <div style={navStyles.divider} aria-hidden="true" />

      {/* Nav tabs */}
      <div style={navStyles.tabs} role="tablist">
        {NAV_ITEMS.map(({ label, route: r, phase }) => {
          const active = route === r;
          const isPlaceholder = !!phase;
          return (
            <button
              key={r}
              role="tab"
              aria-selected={active}
              style={{
                ...navStyles.tab,
                color:         active ? '#C9D1D9' : '#8B949E',
                borderBottom:  active
                  ? '2px solid #58A6FF'
                  : '2px solid transparent',
                background:    active ? 'rgba(88,166,255,0.06)' : 'transparent',
                opacity:       isPlaceholder && !active ? 0.55 : 1,
              }}
              onClick={() => {
                if (!isPlaceholder || active) onNavigate(r);
                else onNavigate(r); // allow navigation even to placeholders
              }}
              title={phase ? `Phase ${phase} — 준비 중` : undefined}
            >
              {label}
              {phase && (
                <span style={navStyles.phaseChip}>P{phase}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Shared time range picker (only relevant for metric views) */}
      {(route === '/metrics' || route === '/explorer') && (
        <div style={navStyles.timeGroup} role="group" aria-label="Time range">
          {TIME_RANGES.map((tr) => {
            const active = timeRange === tr.value;
            return (
              <button
                key={tr.value}
                style={{
                  ...navStyles.timeBtn,
                  background:  active ? 'rgba(88,166,255,0.15)' : 'transparent',
                  color:       active ? '#58A6FF' : 'rgba(201,209,217,0.45)',
                  borderColor: active ? 'rgba(88,166,255,0.4)' : 'rgba(48,54,61,0.8)',
                }}
                onClick={() => onTimeRangeChange(tr.value)}
                aria-pressed={active}
              >
                {tr.label}
              </button>
            );
          })}
        </div>
      )}
    </nav>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function App() {
  const [route, setRoute]         = useState<Route>(getRoute);
  const [timeRange, setTimeRange] = useState('15m');

  // Sync hash ↔ state
  useEffect(() => {
    const handler = () => setRoute(getRoute());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  const navigate = useCallback((r: Route) => {
    window.location.hash = `#${r}`;
    setRoute(r);
  }, []);

  return (
    <div style={appStyles.root}>
      <NavBar
        route={route}
        onNavigate={navigate}
        timeRange={timeRange}
        onTimeRangeChange={setTimeRange}
      />

      <main style={appStyles.main}>
        {route === '/'          && <Dashboard />}
        {route === '/metrics'   && <MetricsDashboard timeRange={timeRange} />}
        {route === '/explorer'  && <MetricsExplorer timeRange={timeRange} onTimeRangeChange={setTimeRange} />}
        {route === '/logs'      && <LogsView />}
        {route === '/log-rules' && <LogMetricsView />}
        {route === '/profiling' && <ProfilingView />}
        {route === '/insights'  && <InsightsView />}
        {route === '/about'     && <LandingPage />}
      </main>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const appStyles = {
  root: {
    display:       'flex',
    flexDirection: 'column' as const,
    height:        '100vh',
    background:    '#0D1117',
    overflow:      'hidden',
  },
  main: {
    flex:      1,
    minHeight: 0,
    display:   'flex',
    overflow:  'hidden',
  },
} as const;

const navStyles = {
  bar: {
    height:       48,
    background:   '#161B22',
    borderBottom: '1px solid #30363D',
    display:      'flex',
    alignItems:   'center',
    padding:      '0 16px',
    gap:          0,
    flexShrink:   0,
    fontFamily:   'system-ui, -apple-system, sans-serif',
  } as CSSProperties,
  logo: {
    display:    'flex',
    alignItems: 'baseline',
    gap:        1,
    marginRight: 8,
    flexShrink: 0,
  },
  logoText: {
    fontSize:      14,
    fontWeight:    700,
    color:         '#C9D1D9',
    fontFamily:    'ui-monospace, monospace',
    letterSpacing: '-0.02em',
  },
  logoDot: {
    fontSize:   18,
    fontWeight: 700,
    color:      '#58A6FF',
    lineHeight: 1,
  },
  divider: {
    width:      1,
    height:     20,
    background: '#30363D',
    marginRight: 8,
    flexShrink: 0,
  },
  tabs: {
    display:    'flex',
    alignItems: 'stretch',
    height:     '100%',
    gap:        0,
  },
  tab: {
    display:       'flex',
    alignItems:    'center',
    gap:           5,
    padding:       '0 14px',
    background:    'transparent',
    border:        'none',
    borderBottom:  '2px solid transparent',
    cursor:        'pointer',
    fontSize:      13,
    fontWeight:    500,
    fontFamily:    'system-ui, -apple-system, sans-serif',
    transition:    'color 0.12s ease, background 0.12s ease',
    whiteSpace:    'nowrap' as const,
    height:        '100%',
    borderRadius:  0,
  } as CSSProperties,
  phaseChip: {
    fontSize:      9,
    fontWeight:    700,
    color:         'rgba(201,209,217,0.35)',
    background:    'rgba(48,54,61,0.8)',
    borderRadius:  3,
    padding:       '1px 4px',
    fontFamily:    'ui-monospace, monospace',
    letterSpacing: '0.04em',
  },
  timeGroup: {
    display:    'flex',
    gap:        4,
    alignItems: 'center',
    marginLeft: 8,
    flexShrink: 0,
  },
  timeBtn: {
    padding:       '4px 10px',
    border:        '1px solid',
    borderRadius:  4,
    cursor:        'pointer',
    fontSize:      12,
    fontWeight:    500,
    fontFamily:    'system-ui, -apple-system, sans-serif',
    transition:    'all 0.12s ease',
    letterSpacing: '0.01em',
    whiteSpace:    'nowrap' as const,
  } as CSSProperties,
} as const;

