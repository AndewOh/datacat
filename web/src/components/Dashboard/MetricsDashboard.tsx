/**
 * MetricsDashboard.tsx — Phase 2 메트릭 대시보드 빌더
 *
 * - "Add Panel" 버튼으로 패널 추가 (최대 4개)
 * - 2열 그리드 배치
 * - 각 패널: 메트릭 선택 드롭다운 + Canvas2D 라인 차트 + 삭제
 * - 상위 timeRange와 동기화
 */

import { useState, useCallback, useId } from 'react';
import type { CSSProperties } from 'react';
import { LineChart } from '../Chart/LineChart';
import { useMetrics, useMetricNames } from '../../hooks/useMetrics';

// ─── Panel color rotation ─────────────────────────────────────────────────────

const PANEL_COLORS = ['#58A6FF', '#3FB950', '#FF7B72', '#D2A8FF'];

// ─── Types ────────────────────────────────────────────────────────────────────

interface PanelState {
  id: string;
  query: string;
}

// ─── Single metric panel ──────────────────────────────────────────────────────

interface MetricPanelProps {
  panel: PanelState;
  colorIdx: number;
  timeRange: string;
  availableMetrics: Array<{ name: string; service: string }>;
  onQueryChange: (id: string, query: string) => void;
  onRemove: (id: string) => void;
}

function MetricPanel({
  panel,
  colorIdx,
  timeRange,
  availableMetrics,
  onQueryChange,
  onRemove,
}: MetricPanelProps) {
  const color = PANEL_COLORS[colorIdx % PANEL_COLORS.length];
  const { data, loading, usingMock } = useMetrics({ query: panel.query, timeRange });
  const selectId = useId();

  return (
    <div style={panelStyles.wrap}>
      {/* Header */}
      <div style={panelStyles.header}>
        <div style={{ ...panelStyles.colorDot, background: color }} />

        <label htmlFor={selectId} className="sr-only">Metric</label>
        <select
          id={selectId}
          style={panelStyles.metricSelect}
          value={panel.query}
          onChange={(e) => onQueryChange(panel.id, e.target.value)}
          aria-label="Select metric"
        >
          <option value="" disabled>— select metric —</option>
          {availableMetrics.map((m) => (
            <option key={`${m.service}/${m.name}`} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>

        {usingMock && (
          <span style={panelStyles.mockBadge} title="Mock 데이터 사용 중">MOCK</span>
        )}

        <button
          style={panelStyles.removeBtn}
          onClick={() => onRemove(panel.id)}
          aria-label="Remove panel"
          title="패널 삭제"
        >
          ×
        </button>
      </div>

      {/* Chart */}
      <div style={panelStyles.chartArea}>
        {!panel.query ? (
          <div style={panelStyles.empty}>
            <span style={panelStyles.emptyIcon}>◎</span>
            <span style={panelStyles.emptyText}>메트릭을 선택하세요</span>
          </div>
        ) : (
          <LineChart data={data} color={color} loading={loading} title={panel.query} />
        )}
      </div>
    </div>
  );
}

// ─── MetricsDashboard ─────────────────────────────────────────────────────────

interface MetricsDashboardProps {
  timeRange: string;
}

let _counter = 0;
const nextId = () => `panel-${++_counter}`;

export function MetricsDashboard({ timeRange }: MetricsDashboardProps) {
  const [panels, setPanels] = useState<PanelState[]>([]);
  const { names: availableMetrics, loading: namesLoading } = useMetricNames();

  const handleAdd = useCallback(() => {
    if (panels.length >= 4) return;
    const defaultQuery = availableMetrics[0]?.name ?? '';
    setPanels((prev) => [...prev, { id: nextId(), query: defaultQuery }]);
  }, [panels.length, availableMetrics]);

  const handleQueryChange = useCallback((id: string, query: string) => {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, query } : p)));
  }, []);

  const handleRemove = useCallback((id: string) => {
    setPanels((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const canAdd = panels.length < 4;

  // Grid columns: 1 panel = 1 col, 2+ panels = 2 cols
  const gridCols = panels.length <= 1 ? '1fr' : '1fr 1fr';

  const gridStyle: CSSProperties = {
    flex:                1,
    display:             'grid',
    gridTemplateColumns: gridCols,
    gap:                 10,
    overflowY:           'auto',
    minHeight:           0,
    alignContent:        'start',
  };

  return (
    <div style={rootStyles.root}>
      {/* Toolbar */}
      <div style={rootStyles.toolbar}>
        <span style={rootStyles.title}>Dashboard Builder</span>
        <span style={rootStyles.count}>{panels.length} / 4 panels</span>

        <button
          style={{
            ...rootStyles.addBtn,
            opacity: canAdd ? 1 : 0.4,
            cursor:  canAdd ? 'pointer' : 'not-allowed',
          }}
          onClick={handleAdd}
          disabled={!canAdd || namesLoading}
          aria-label="Add metric panel"
        >
          + Add Panel
        </button>
      </div>

      {/* Empty state */}
      {panels.length === 0 ? (
        <div style={rootStyles.emptyWrap}>
          <div style={rootStyles.emptyBox}>
            <div style={rootStyles.emptyBigIcon}>◎</div>
            <div style={rootStyles.emptyTitle}>대시보드가 비어 있습니다</div>
            <div style={rootStyles.emptySub}>
              패널을 추가하여 메트릭 차트를 시각화하세요 (최대 4개)
            </div>
            <button
              style={{ ...rootStyles.addBtn, marginTop: 20 }}
              onClick={handleAdd}
              disabled={namesLoading}
            >
              {namesLoading ? '로딩 중…' : '+ Add Panel'}
            </button>
          </div>
        </div>
      ) : (
        <div style={gridStyle}>
          {panels.map((panel, idx) => (
            <MetricPanel
              key={panel.id}
              panel={panel}
              colorIdx={idx}
              timeRange={timeRange}
              availableMetrics={availableMetrics}
              onQueryChange={handleQueryChange}
              onRemove={handleRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const rootStyles = {
  root: {
    flex:          1,
    display:       'flex',
    flexDirection: 'column' as const,
    padding:       12,
    gap:           10,
    overflow:      'hidden',
    minHeight:     0,
  },
  toolbar: {
    display:     'flex',
    alignItems:  'center',
    gap:         10,
    flexShrink:  0,
    height:      36,
  },
  title: {
    fontSize:   13,
    fontWeight: 600,
    color:      'rgba(201,209,217,0.85)',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    marginRight: 4,
  },
  count: {
    fontSize:   11,
    color:      'rgba(201,209,217,0.35)',
    fontFamily: 'ui-monospace, monospace',
  },
  addBtn: {
    marginLeft:    'auto',
    padding:       '6px 14px',
    background:    'rgba(88,166,255,0.12)',
    color:         '#58A6FF',
    border:        '1px solid rgba(88,166,255,0.35)',
    borderRadius:  5,
    fontSize:      12,
    fontWeight:    600,
    fontFamily:    'system-ui, -apple-system, sans-serif',
    cursor:        'pointer',
    transition:    'all 0.12s ease',
    letterSpacing: '0.01em',
  } as CSSProperties,
  emptyWrap: {
    flex:           1,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    minHeight:      0,
  },
  emptyBox: {
    display:        'flex',
    flexDirection:  'column' as const,
    alignItems:     'center',
    gap:            8,
    textAlign:      'center' as const,
    padding:        40,
  },
  emptyBigIcon: {
    fontSize:   52,
    color:      'rgba(139,148,158,0.25)',
    lineHeight: 1,
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize:   15,
    fontWeight: 600,
    color:      'rgba(201,209,217,0.55)',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  emptySub: {
    fontSize:   12,
    color:      'rgba(201,209,217,0.3)',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    maxWidth:   300,
    lineHeight: 1.6,
  },
} as const;

const panelStyles = {
  wrap: {
    display:       'flex',
    flexDirection: 'column' as const,
    background:    '#161B22',
    border:        '1px solid #30363D',
    borderRadius:  8,
    overflow:      'hidden',
    minHeight:     220,
  },
  header: {
    display:        'flex',
    alignItems:     'center',
    gap:            8,
    padding:        '8px 12px',
    borderBottom:   '1px solid #30363D',
    background:     '#1C2128',
    flexShrink:     0,
  },
  colorDot: {
    width:        8,
    height:       8,
    borderRadius: '50%',
    flexShrink:   0,
  },
  metricSelect: {
    flex:         1,
    background:   '#0D1117',
    color:        '#C9D1D9',
    border:       '1px solid #30363D',
    borderRadius: 4,
    padding:      '3px 6px',
    fontSize:     12,
    fontFamily:   'ui-monospace, monospace',
    cursor:       'pointer',
    outline:      'none',
    minWidth:     0,
  },
  mockBadge: {
    fontSize:      9,
    fontWeight:    700,
    color:         '#f0c060',
    background:    'rgba(240,192,96,0.1)',
    border:        '1px solid rgba(240,192,96,0.3)',
    borderRadius:  3,
    padding:       '2px 5px',
    letterSpacing: '0.08em',
    fontFamily:    'ui-monospace, monospace',
    flexShrink:    0,
  },
  removeBtn: {
    background:     'transparent',
    color:          'rgba(201,209,217,0.4)',
    border:         '1px solid transparent',
    borderRadius:   4,
    width:          22,
    height:         22,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    cursor:         'pointer',
    fontSize:       16,
    lineHeight:     1,
    flexShrink:     0,
    padding:        0,
    transition:     'all 0.12s ease',
  },
  chartArea: {
    flex:      1,
    minHeight: 0,
    padding:   8,
  },
  empty: {
    height:         '100%',
    display:        'flex',
    flexDirection:  'column' as const,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            8,
    color:          'rgba(139,148,158,0.45)',
  },
  emptyIcon: {
    fontSize: 28,
  },
  emptyText: {
    fontSize:   12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
} as const;
