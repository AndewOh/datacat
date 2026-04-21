/**
 * useMetrics.ts — 메트릭 데이터 페치 훅
 *
 * - fetchQueryRange 호출 → loading/error/series (multi-series)
 * - API 실패 시 mock 데이터 폴백 (sin 파동 + 노이즈)
 * - 30초마다 자동 갱신
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchQueryRange, fetchMetricNames } from '../api/client';
import type { MetricPoint, MetricSeries, MetricInfo } from '../api/client';

// ─── Time range helpers ───────────────────────────────────────────────────────

function parseTimeRange(range: string): { start: number; end: number; step: number } {
  const now = Date.now();
  const MAP: Record<string, number> = {
    '15m': 15 * 60_000,
    '1h':  60 * 60_000,
    '6h':  6  * 60 * 60_000,
    '24h': 24 * 60 * 60_000,
  };
  const durationMs = MAP[range] ?? MAP['15m'];
  const start = now - durationMs;
  // step: aim for ~120 data points
  const step = Math.max(15_000, Math.round(durationMs / 120));
  return { start, end: now, step };
}

// ─── Mock data generator ──────────────────────────────────────────────────────

/**
 * Generates a deterministic mock MetricSeries array using a sin wave + gaussian noise.
 * Different metrics get different amplitudes, periods, and offsets so each panel
 * looks visually distinct.
 */
function generateMockSeries(
  query: string,
  start: number,
  end: number,
  step: number,
): MetricSeries[] {
  // Use query hash to produce per-metric variation
  const seed = query.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const amplitude  = 50 + (seed % 80);
  const baseline   = 20 + (seed % 60);
  const period     = 60_000 * (3 + (seed % 7));   // 3–9 min period
  const phaseShift = (seed % 100) / 100 * Math.PI * 2;

  const data: MetricPoint[] = [];
  for (let t = start; t <= end; t += step) {
    const sine  = Math.sin((t / period) * Math.PI * 2 + phaseShift);
    // Simple deterministic "noise" using a linear congruential approach
    const noise = (((t * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 20;
    const v = Math.max(0, baseline + amplitude * sine + noise);
    data.push({ t, v: Math.round(v * 100) / 100 });
  }

  return [{ labels: { service: 'mock', env: 'dev' }, data }];
}

// ─── useMetrics ───────────────────────────────────────────────────────────────

interface UseMetricsParams {
  query: string;
  timeRange: string;   // '15m' | '1h' | '6h' | '24h'
  tenantId?: string;
}

interface UseMetricsResult {
  series: MetricSeries[];
  metric: string;
  loading: boolean;
  error: string | null;
  usingMock: boolean;
}

export function useMetrics({ query, timeRange, tenantId }: UseMetricsParams): UseMetricsResult {
  const [series, setSeries]       = useState<MetricSeries[]>([]);
  const [metric, setMetric]       = useState<string>(query);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [usingMock, setUsingMock] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!query) return;
    setLoading(true);
    const { start, end, step } = parseTimeRange(timeRange);

    try {
      const resp = await fetchQueryRange({ query, start, end, step, tenantId });
      setSeries(resp.series.map((s) => ({ labels: s.labels, data: s.data })));
      setMetric(resp.metric);
      setUsingMock(false);
      setError(null);
    } catch {
      // Fallback to mock
      setSeries(generateMockSeries(query, start, end, step));
      setMetric(query);
      setUsingMock(true);
      setError(null);
    } finally {
      setLoading(false);
    }
  }, [query, timeRange, tenantId]);

  // Initial load + time range change
  useEffect(() => {
    void load();
  }, [load]);

  // 30s auto-refresh
  useEffect(() => {
    timerRef.current = setInterval(() => { void load(); }, 30_000);
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, [load]);

  return { series, metric, loading, error, usingMock };
}

// ─── useMetricNames ───────────────────────────────────────────────────────────

interface UseMetricNamesResult {
  names: MetricInfo[];
  loading: boolean;
}

const FALLBACK_NAMES: MetricInfo[] = [
  { name: 'http.request.duration',   service: 'api-gateway' },
  { name: 'http.request.count',      service: 'api-gateway' },
  { name: 'db.query.duration',       service: 'postgres'    },
  { name: 'cache.hit.rate',          service: 'redis'       },
  { name: 'cpu.usage',               service: 'system'      },
  { name: 'memory.usage',            service: 'system'      },
  { name: 'error.rate',              service: 'api-gateway' },
  { name: 'queue.depth',             service: 'kafka'       },
];

export function useMetricNames(): UseMetricNamesResult {
  const [names, setNames]     = useState<MetricInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetchMetricNames()
      .then((list) => {
        if (!cancelled) setNames(list.length ? list : FALLBACK_NAMES);
      })
      .catch(() => {
        if (!cancelled) setNames(FALLBACK_NAMES);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, []);

  return { names, loading };
}
