/**
 * Dashboard.tsx — Phase 1 메인 레이아웃
 *
 * ┌─────── TopBar ─────────────────────────┐
 * │ Sidebar │    X-View (60%)              │
 * │         │                              │
 * │ (200px) │  TransactionTable (40%)      │
 * └─────────┴──────────────────────────────┘
 */

import { useState, useCallback, useEffect } from 'react';
import { Sidebar } from '../ui/Sidebar';
import { TopBar } from '../ui/TopBar';
import { XView } from '../XView/XView';
import { TransactionTable } from '../TransactionTable/TransactionTable';
import { useXView, timeRangeToParams } from '../../hooks/useXView';
import type { XViewPoint } from '../XView/types';
import { fetchServices } from '../../api/client';
import type { Service } from '../../api/client';

export function Dashboard() {
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [timeRange,       setTimeRange]       = useState('15m');
  const [selectedPoints,  setSelectedPoints]  = useState<XViewPoint[]>([]);
  const [services,        setServices]        = useState<Service[]>([]);

  // 서비스 목록 로드 (TopBar dropdown 용)
  useEffect(() => {
    const ctrl = new AbortController();
    fetchServices(ctrl.signal)
      .then((list) => { if (!ctrl.signal.aborted) setServices(list); })
      .catch(() => {});
    return () => ctrl.abort();
  }, []);

  // X-View 데이터
  const { points, stats, loading, error, usingMock } = useXView({
    service:          selectedService ?? undefined,
    timeRange,
    refreshIntervalMs: 30_000,
  });

  // 버튼이 바뀔 때마다 X축 범위도 바뀌어야 하므로 timeRange 기반으로 재계산
  const { start: rangeStart, end: rangeEnd } = timeRangeToParams(timeRange);

  const handlePointsSelected = useCallback((pts: XViewPoint[]) => {
    setSelectedPoints(pts);
  }, []);

  const handleServiceChange = useCallback((svc: string | null) => {
    setSelectedService(svc);
    setSelectedPoints([]);
  }, []);

  return (
    <div style={styles.root}>
      {/* Sidebar */}
      <Sidebar
        selectedService={selectedService}
        onSelectService={handleServiceChange}
        stats={stats}
      />

      {/* Main column */}
      <div style={styles.main}>
        <TopBar
          timeRange={timeRange}
          onTimeRangeChange={(val) => { setTimeRange(val); setSelectedPoints([]); }}
          selectedService={selectedService}
          onServiceChange={handleServiceChange}
          services={services}
          stats={stats}
          loading={loading}
          usingMock={usingMock}
        />

        <div style={styles.content}>
          {/* X-View panel — 60% */}
          <section style={styles.xviewPanel} aria-label="X-View scatter plot">
            <div style={styles.panelHeader}>
              <span style={styles.panelTitle}>X-View</span>
              <span style={styles.panelSubtitle}>
                {selectedService ?? 'All Services'} · Response time distribution
              </span>
              {selectedPoints.length > 0 && (
                <span style={styles.selBadge}>
                  {selectedPoints.length.toLocaleString()} 트랜잭션 선택됨
                </span>
              )}
            </div>
            <div style={styles.xviewContainer}>
              <XView
                points={points}
                loading={loading}
                error={error}
                usingMock={usingMock}
                onPointsSelected={handlePointsSelected}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
              />
            </div>
          </section>

          {/* Transaction table panel — 40% */}
          <section style={styles.tablePanel} aria-label="Selected transactions">
            <div style={styles.tablePanelHeader}>
              <span style={styles.panelTitle}>Transactions</span>
              {selectedPoints.length > 0 && (
                <span style={styles.badge}>
                  {selectedPoints.length.toLocaleString()} selected
                </span>
              )}
            </div>
            <TransactionTable selectedPoints={selectedPoints} />
          </section>
        </div>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: 'flex',
    height: '100vh',
    background: '#0D1117',
    overflow: 'hidden',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 14,
    color: '#C9D1D9',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    minWidth: 0,
  },
  content: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    padding: 12,
    gap: 8,
    overflow: 'hidden',
    minHeight: 0,
  },
  xviewPanel: {
    flex: '0 0 60%',
    display: 'flex',
    flexDirection: 'column' as const,
    minHeight: 0,
  },
  panelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginBottom: 6,
    flexShrink: 0,
  },
  panelTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: 'rgba(201,209,217,0.85)',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  panelSubtitle: {
    fontSize: 11,
    color: 'rgba(201,209,217,0.3)',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  selBadge: {
    fontSize: 11,
    fontWeight: 600,
    color: '#58A6FF',
    background: 'rgba(88,166,255,0.10)',
    border: '1px solid rgba(88,166,255,0.25)',
    padding: '2px 8px',
    borderRadius: 10,
    fontFamily: 'ui-monospace, monospace',
    marginLeft: 'auto',
  },
  xviewContainer: {
    flex: 1,
    minHeight: 0,
  },
  tablePanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    minHeight: 0,
    background: '#161B22',
    borderRadius: 8,
    border: '1px solid #30363D',
    overflow: 'hidden',
  },
  tablePanelHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px 6px',
    flexShrink: 0,
  },
  badge: {
    fontSize: 10,
    fontWeight: 600,
    color: '#58A6FF',
    background: 'rgba(88,166,255,0.10)',
    border: '1px solid rgba(88,166,255,0.2)',
    padding: '2px 8px',
    borderRadius: 10,
    fontFamily: 'ui-monospace, monospace',
  },
} as const;
