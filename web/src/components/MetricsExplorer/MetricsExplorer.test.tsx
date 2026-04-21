/**
 * MetricsExplorer render tests
 *
 * Strategy:
 *  - Mock api/client entirely so no real fetch calls happen.
 *  - Mock the LineChart component because it relies on Canvas2D and
 *    ResizeObserver which are unavailable in jsdom (even after shimming,
 *    canvas drawing is a no-op and adds noise to render tests).
 *  - When fetchMetricNames and fetchServices reject, MetricsExplorer falls
 *    back to its FALLBACK_METRICS / FALLBACK_SERVICES constants — convenient
 *    for stable assertions.
 */

import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MetricsExplorer } from './MetricsExplorer';

// ── Mock LineChart (canvas-based — would be a no-op in jsdom) ─────────────────
vi.mock('../Chart/LineChart', () => ({
  LineChart: () => <div data-testid="line-chart-mock" />,
}));

// ── Mock API module ────────────────────────────────────────────────────────────
vi.mock('../../api/client', () => ({
  fetchMetricNames: vi.fn().mockRejectedValue(new Error('mocked — use fallback')),
  fetchServices:    vi.fn().mockRejectedValue(new Error('mocked — use fallback')),
  fetchQueryRange:  vi.fn().mockRejectedValue(new Error('mocked — use fallback')),
}));

import * as apiClient from '../../api/client';
const mockFetchMetricNames = apiClient.fetchMetricNames as ReturnType<typeof vi.fn>;
const mockFetchServices    = apiClient.fetchServices    as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetchMetricNames.mockRejectedValue(new Error('mocked'));
  mockFetchServices.mockRejectedValue(new Error('mocked'));
});

// ── Helper ─────────────────────────────────────────────────────────────────────

function renderExplorer(timeRange = '1h', onTimeRangeChange?: (v: string) => void) {
  return render(
    <MetricsExplorer
      timeRange={timeRange}
      onTimeRangeChange={onTimeRangeChange}
    />,
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('MetricsExplorer — toolbar controls rendered', () => {
  it('renders the Metric selector combobox', async () => {
    renderExplorer();
    const select = await screen.findByRole('combobox', { name: '메트릭' });
    expect(select).toBeInTheDocument();
  });

  it('renders the Aggregation select with all options', async () => {
    renderExplorer();
    const aggSelect = await screen.findByRole('combobox', { name: '집계 함수' });
    expect(aggSelect).toBeInTheDocument();

    const options = Array.from((aggSelect as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toEqual(expect.arrayContaining(['avg', 'sum', 'max', 'min', 'rate']));
  });

  it('defaults the Aggregation select to "avg"', async () => {
    renderExplorer();
    const aggSelect = await screen.findByRole('combobox', { name: '집계 함수' });
    expect((aggSelect as HTMLSelectElement).value).toBe('avg');
  });

  it('renders the Group by select', async () => {
    renderExplorer();
    const groupBySelect = await screen.findByRole('combobox', { name: '그룹화 기준' });
    expect(groupBySelect).toBeInTheDocument();
  });

  it('renders a time-range button for each preset', async () => {
    renderExplorer();
    // TIME_RANGES = ['15m', '1h', '6h', '24h']
    for (const label of ['15m', '1h', '6h', '24h']) {
      expect(await screen.findByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('marks the active time range button with aria-pressed="true"', async () => {
    renderExplorer('6h');
    const active = await screen.findByRole('button', { name: '6h' });
    expect(active).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks non-active time range buttons with aria-pressed="false"', async () => {
    renderExplorer('6h');
    // Wait for active button to be stable
    await screen.findByRole('button', { name: '6h' });

    for (const label of ['15m', '1h', '24h']) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
  });

  it('renders the Service filter combobox', async () => {
    renderExplorer();
    const svcSelect = await screen.findByRole('combobox', { name: '서비스 필터' });
    expect(svcSelect).toBeInTheDocument();
  });

  it('populates the Metric selector with fallback metrics when API fails', async () => {
    renderExplorer();
    const metricSelect = await screen.findByRole('combobox', { name: '메트릭' });
    const options = Array.from((metricSelect as HTMLSelectElement).options).map((o) => o.value);
    // FALLBACK_METRICS starts with 'http.request.duration'
    expect(options).toContain('http.request.duration');
    expect(options).toContain('error.rate');
  });

  it('auto-selects the first fallback metric', async () => {
    renderExplorer();
    const metricSelect = await screen.findByRole('combobox', { name: '메트릭' });
    // First fallback metric
    expect((metricSelect as HTMLSelectElement).value).toBe('http.request.duration');
  });

  it('renders the chart area', async () => {
    renderExplorer();
    expect(await screen.findByTestId('line-chart-mock')).toBeInTheDocument();
  });
});

describe('MetricsExplorer — API data path', () => {
  it('populates the Metric selector from the API when it resolves', async () => {
    mockFetchMetricNames.mockResolvedValueOnce([
      { name: 'api.latency', service: 'api-gateway' },
      { name: 'queue.depth', service: 'worker' },
    ]);

    renderExplorer();

    const metricSelect = await screen.findByRole('combobox', { name: '메트릭' });
    const options = Array.from((metricSelect as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toContain('api.latency');
    expect(options).toContain('queue.depth');
    // Fallback entries should NOT be present
    expect(options).not.toContain('http.request.duration');
  });
});
