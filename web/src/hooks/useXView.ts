/**
 * useXView.ts — XView 데이터 페칭 및 상태 관리 훅
 *
 * Phase 1: GET /api/v1/xview 연동
 *   - API 실패 시 mock 100k 포인트로 자동 폴백
 *   - 30초마다 자동 갱신
 *   - 반환: { points, stats, loading, error, refetch }
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { XViewPoint } from '../components/XView/types';
import type { XViewStats, XViewParams } from '../api/client';
import { fetchXView } from '../api/client';

// ─── Mock generator ────────────────────────────────────────────────────────────

const MOCK_COUNT = 100_000;

function generateMockPoints(count: number, start: number, end: number): XViewPoint[] {
  const points: XViewPoint[] = [];
  const windowMs = end - start;

  for (let i = 0; i < count; i++) {
    const x = start + Math.random() * windowMs;

    // 로그 정규분포 근사: 10ms ~ 2000ms
    const u1 = Math.random();
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1 + 1e-9)) * Math.cos(2 * Math.PI * u2);
    // 중심 ~200ms, 분산 적당히
    const y = Math.max(5, Math.exp(5.3 + z * 1.2));

    // 성공 95%, 에러 5% (느린 요청은 에러율 더 높음)
    const isError = y > 1500 ? Math.random() < 0.35 : Math.random() < 0.05;

    points.push({
      x,
      y,
      status: isError ? 1 : 0,
      spanId:  `span_${i.toString(16).padStart(8, '0')}`,
      traceId: `trace_${Math.floor(i / 4).toString(16).padStart(16, '0')}`,
    });
  }

  return points;
}

function makeMockStats(points: XViewPoint[]): XViewStats {
  const errors = points.filter((p) => p.status === 1).length;
  const sorted = [...points].sort((a, b) => a.y - b.y);
  const ns = (ms: number) => Math.round(ms * 1_000_000);
  return {
    total:   points.length,
    errors,
    p50_ns:  ns(sorted[Math.floor(sorted.length * 0.50)]?.y ?? 0),
    p95_ns:  ns(sorted[Math.floor(sorted.length * 0.95)]?.y ?? 0),
    p99_ns:  ns(sorted[Math.floor(sorted.length * 0.99)]?.y ?? 0),
  };
}

// ─── Wire → internal shape conversion ─────────────────────────────────────────

function wireToXViewPoint(w: { t: number; d: number; s: 0 | 1 }, idx: number): XViewPoint {
  return {
    x:       w.t,
    y:       w.d / 1_000_000,   // ns → ms
    status:  w.s,
    spanId:  `span_${idx.toString(16).padStart(8, '0')}`,
    traceId: `trace_${Math.floor(idx / 4).toString(16).padStart(16, '0')}`,
  };
}

// ─── Time range helper ─────────────────────────────────────────────────────────

export function timeRangeToParams(range: string): { start: number; end: number } {
  const now = Date.now();
  const MS: Record<string, number> = {
    '15m': 15 * 60 * 1000,
    '1h':  60 * 60 * 1000,
    '6h':  6  * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
  };
  return { start: now - (MS[range] ?? 15 * 60 * 1000), end: now };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface UseXViewOptions {
  service?: string | null;
  timeRange: string;  // '15m' | '1h' | '6h' | '24h'
  tenantId?: string;
  refreshIntervalMs?: number;
}

export interface UseXViewResult {
  points: XViewPoint[];
  stats: XViewStats | null;
  loading: boolean;
  error: string | null;
  usingMock: boolean;
  refetch: () => void;
  lastUpdatedAt: number | null;
}

export function useXView({
  service,
  timeRange,
  tenantId,
  refreshIntervalMs = 30_000,
}: UseXViewOptions): UseXViewResult {
  const [points, setPoints]               = useState<XViewPoint[]>([]);
  const [stats, setStats]                 = useState<XViewStats | null>(null);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState<string | null>(null);
  const [usingMock, setUsingMock]         = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doFetch = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);

    const { start, end } = timeRangeToParams(timeRange);
    const params: XViewParams = {
      start,
      end,
      ...(service   ? { service }   : {}),
      ...(tenantId  ? { tenantId }  : {}),
    };

    try {
      const res = await fetchXView(params, ctrl.signal);
      if (ctrl.signal.aborted) return;

      const converted = res.points.map((w, i) => wireToXViewPoint(w, i));
      setPoints(converted);
      setStats(res.stats);
      setUsingMock(false);
      setLastUpdatedAt(Date.now());
    } catch (err) {
      if (ctrl.signal.aborted) return;

      // API 실패 → mock 폴백
      const msg = err instanceof Error ? err.message : 'Unknown error';
      setError(msg);

      const { start: s, end: e } = timeRangeToParams(timeRange);
      const mocks = generateMockPoints(MOCK_COUNT, s, e);
      setPoints(mocks);
      setStats(makeMockStats(mocks));
      setUsingMock(true);
      setLastUpdatedAt(Date.now());
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [service, timeRange, tenantId]);

  // 파라미터 변경 시 즉시 fetch
  useEffect(() => {
    void doFetch();
    return () => { abortRef.current?.abort(); };
  }, [doFetch]);

  // 30초 자동 갱신
  useEffect(() => {
    if (refreshIntervalMs <= 0) return;
    timerRef.current = setInterval(() => { void doFetch(); }, refreshIntervalMs);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [doFetch, refreshIntervalMs]);

  return { points, stats, loading, error, usingMock, refetch: doFetch, lastUpdatedAt };
}
