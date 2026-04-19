import { useState, useEffect, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { LineChart } from '../Chart/LineChart';
import type { MetricSeries } from '../Chart/LineChart';
import { fetchQueryRange, fetchMetricNames, fetchServices } from '../../api/client';

const TIME_RANGES = ['15m', '1h', '6h', '24h'] as const;
type TimeRange = typeof TIME_RANGES[number];

const AGG_OPTIONS = ['avg', 'sum', 'max', 'min', 'rate'] as const;

const GROUP_BY_OPTIONS = [
  { label: 'None',         value: '' },
  { label: 'service',      value: 'service' },
  { label: 'env',          value: 'env' },
  { label: 'service+env',  value: 'service,env' },
] as const;

function parseTimeRange(range: TimeRange): { start: number; end: number; step: number } {
  const now = Date.now();
  const MAP: Record<TimeRange, number> = {
    '15m': 15 * 60_000,
    '1h':  60 * 60_000,
    '6h':  6 * 60 * 60_000,
    '24h': 24 * 60 * 60_000,
  };
  const durationMs = MAP[range];
  const step = Math.max(15_000, Math.round(durationMs / 120));
  return { start: now - durationMs, end: now, step };
}

function generateMockSeries(
  query: string,
  groupBy: string,
  start: number,
  end: number,
  step: number,
): MetricSeries[] {
  const seed = query.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const mockGroups = groupBy === 'service,env'
    ? [{ service: 'api-gateway', env: 'prod' }, { service: 'order-service', env: 'prod' }]
    : groupBy === 'service'
    ? [{ service: 'api-gateway' }, { service: 'order-service' }]
    : groupBy === 'env'
    ? [{ env: 'prod' }, { env: 'staging' }]
    : [{}];

  return mockGroups.map((labels, si) => {
    const s = seed + si * 31;
    const amplitude  = 50 + (s % 80);
    const baseline   = 20 + (s % 60);
    const period     = 60_000 * (3 + (s % 7));
    const phaseShift = (s % 100) / 100 * Math.PI * 2;
    const data = [];
    for (let t = start; t <= end; t += step) {
      const sine  = Math.sin((t / period) * Math.PI * 2 + phaseShift);
      const noise = (((t * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 20;
      const v = Math.max(0, baseline + amplitude * sine + noise);
      data.push({ t, v: Math.round(v * 100) / 100 });
    }
    return { labels: labels as Record<string, string>, data };
  });
}

interface MetricsExplorerProps {
  timeRange: string;
  onTimeRangeChange?: (v: string) => void;
}

export function MetricsExplorer({ timeRange, onTimeRangeChange }: MetricsExplorerProps) {
  const [metrics, setMetrics] = useState<Array<{ name: string; service: string }>>([]);
  const [services, setServices] = useState<string[]>([]);
  const [selectedMetric, setSelectedMetric] = useState('');
  const [agg, setAgg] = useState<string>('avg');
  const [groupBy, setGroupBy] = useState('');
  const [serviceFilter, setServiceFilter] = useState('');
  const [series, setSeries] = useState<MetricSeries[]>([]);
  const [loading, setLoading] = useState(false);
  const [usingMock, setUsingMock] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetchMetricNames()
      .then((list) => {
        if (list.length) setMetrics(list);
        else setMetrics(FALLBACK_METRICS);
      })
      .catch(() => setMetrics(FALLBACK_METRICS));

    fetchServices()
      .then((svcs) => setServices(svcs.map((s) => s.name)))
      .catch(() => setServices(FALLBACK_SERVICES));
  }, []);

  useEffect(() => {
    if (metrics.length && !selectedMetric) {
      setSelectedMetric(metrics[0].name);
    }
  }, [metrics, selectedMetric]);

  const load = useCallback(async () => {
    if (!selectedMetric) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);

    const { start, end, step } = parseTimeRange(timeRange as TimeRange);
    const query = `${agg}(${selectedMetric})`;

    try {
      const resp = await fetchQueryRange({
        query,
        start,
        end,
        step,
        tenantId: 'default',
        ...(groupBy    ? { groupBy }                 : {}),
        ...(serviceFilter ? { service: serviceFilter } : {}),
      });

      const mapped: MetricSeries[] = resp.series.map((s) => ({
        labels: s.labels,
        data:   s.data,
      }));

      setSeries(mapped);
      setUsingMock(false);
    } catch {
      const { start: ms, end: me, step: mst } = parseTimeRange(timeRange as TimeRange);
      setSeries(generateMockSeries(selectedMetric, groupBy, ms, me, mst));
      setUsingMock(true);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [selectedMetric, agg, groupBy, serviceFilter, timeRange]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  const currentTimeRange = (TIME_RANGES as readonly string[]).includes(timeRange)
    ? (timeRange as TimeRange)
    : '15m';

  return (
    <div style={s.root}>
      <div style={s.toolbar}>
        <select
          style={s.select}
          value={selectedMetric}
          onChange={(e) => setSelectedMetric(e.target.value)}
          aria-label="Metric"
        >
          {metrics.map((m) => (
            <option key={`${m.service}/${m.name}`} value={m.name}>
              {m.name} ({m.service})
            </option>
          ))}
        </select>

        <select
          style={s.select}
          value={agg}
          onChange={(e) => setAgg(e.target.value)}
          aria-label="Aggregation"
        >
          {AGG_OPTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        <select
          style={s.select}
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value)}
          aria-label="Group by"
        >
          {GROUP_BY_OPTIONS.map((g) => (
            <option key={g.value} value={g.value}>{g.label}</option>
          ))}
        </select>

        <div style={s.timeGroup}>
          {TIME_RANGES.map((tr) => {
            const active = currentTimeRange === tr;
            return (
              <button
                key={tr}
                style={{
                  ...s.timeBtn,
                  background:  active ? 'rgba(88,166,255,0.15)' : 'transparent',
                  color:       active ? '#58A6FF' : 'rgba(201,209,217,0.45)',
                  borderColor: active ? 'rgba(88,166,255,0.4)' : 'rgba(48,54,61,0.8)',
                }}
                onClick={() => onTimeRangeChange?.(tr)}
                aria-pressed={active}
              >
                {tr}
              </button>
            );
          })}
        </div>

        <select
          style={s.select}
          value={serviceFilter}
          onChange={(e) => setServiceFilter(e.target.value)}
          aria-label="Service filter"
        >
          <option value="">All</option>
          {services.map((svc) => (
            <option key={svc} value={svc}>{svc}</option>
          ))}
        </select>

        {usingMock && <span style={s.mockChip}>MOCK</span>}
      </div>

      <div style={s.chartWrap}>
        <LineChart
          data={[]}
          series={series}
          loading={loading}
        />
      </div>
    </div>
  );
}

const FALLBACK_METRICS = [
  { name: 'http.request.duration', service: 'api-gateway' },
  { name: 'http.request.count',    service: 'api-gateway' },
  { name: 'db.query.duration',     service: 'postgres'    },
  { name: 'cache.hit.rate',        service: 'redis'       },
  { name: 'cpu.usage',             service: 'system'      },
  { name: 'memory.usage',          service: 'system'      },
  { name: 'error.rate',            service: 'api-gateway' },
];

const FALLBACK_SERVICES = [
  'api-gateway', 'order-service', 'user-service', 'payment-service',
];

const s = {
  root: {
    flex:          1,
    display:       'flex',
    flexDirection: 'column' as const,
    background:    '#0D1117',
    overflow:      'hidden',
    fontFamily:    'system-ui, -apple-system, sans-serif',
  },
  toolbar: {
    display:      'flex',
    alignItems:   'center',
    gap:          8,
    padding:      '8px 16px',
    background:   '#161B22',
    borderBottom: '1px solid #30363D',
    flexShrink:   0,
    flexWrap:     'wrap' as const,
  },
  select: {
    background:   '#1C2128',
    border:       '1px solid #30363D',
    borderRadius: 4,
    color:        '#C9D1D9',
    fontSize:     12,
    padding:      '4px 8px',
    cursor:       'pointer',
    outline:      'none',
    fontFamily:   'system-ui, -apple-system, sans-serif',
  } as CSSProperties,
  timeGroup: {
    display:    'flex',
    gap:        4,
    alignItems: 'center',
  },
  timeBtn: {
    padding:      '4px 10px',
    border:       '1px solid',
    borderRadius: 4,
    cursor:       'pointer',
    fontSize:     12,
    fontWeight:   500,
    fontFamily:   'system-ui, -apple-system, sans-serif',
    transition:   'all 0.12s ease',
    whiteSpace:   'nowrap' as const,
  } as CSSProperties,
  chartWrap: {
    flex:      1,
    minHeight: 0,
    padding:   12,
  },
  mockChip: {
    fontSize:      9,
    fontWeight:    700,
    color:         '#E3B341',
    background:    'rgba(227,179,65,0.12)',
    border:        '1px solid rgba(227,179,65,0.25)',
    borderRadius:  3,
    padding:       '2px 6px',
    fontFamily:    'ui-monospace, monospace',
    letterSpacing: '0.06em',
  } as CSSProperties,
} as const;
