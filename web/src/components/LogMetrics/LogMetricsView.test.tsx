/**
 * LogMetricsView render tests
 *
 * Strategy: mock the entire api/client module so no real fetch calls happen.
 * When fetchLogMetricRules rejects the component falls back to MOCK_RULES —
 * we use that path in the "rule list" tests to keep assertions stable without
 * coupling to a particular resolved value.
 *
 * For the form-visibility tests we also reject so the list is visible immediately.
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { LogMetricsView } from './LogMetricsView';

// ── Mock the API module ────────────────────────────────────────────────────────
vi.mock('../../api/client', () => ({
  fetchLogMetricRules: vi.fn().mockRejectedValue(new Error('mocked — use fallback')),
  createLogMetricRule: vi.fn().mockResolvedValue({}),
  deleteLogMetricRule: vi.fn().mockResolvedValue(undefined),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Import the mock so individual tests can override it when needed. */
import * as apiClient from '../../api/client';
const mockFetch = apiClient.fetchLogMetricRules as ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Reset to rejection (→ MOCK_RULES fallback) before each test.
  mockFetch.mockRejectedValue(new Error('mocked'));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('LogMetricsView — rule list', () => {
  it('renders the section title', async () => {
    render(<LogMetricsView />);
    expect(await screen.findByText('Log Metric Rules')).toBeInTheDocument();
  });

  it('shows the metric name for each fallback rule', async () => {
    render(<LogMetricsView />);
    // The component falls back to MOCK_RULES which contains 'error.count'
    expect(await screen.findByText('error.count')).toBeInTheDocument();
    expect(await screen.findByText('payment.duration')).toBeInTheDocument();
  });

  it('shows filter type and value for each rule', async () => {
    render(<LogMetricsView />);
    // error.count rule: filter_type='severity', filter_value='ERROR'
    expect(await screen.findByText('severity: ERROR')).toBeInTheDocument();
    // payment.duration rule: filter_type='service', filter_value='payment-service'
    expect(await screen.findByText('service: payment-service')).toBeInTheDocument();
  });

  it('renders a delete button for each rule', async () => {
    render(<LogMetricsView />);
    // Each RuleCard renders a delete button with aria-label "Delete rule <name>"
    const deleteButtons = await screen.findAllByRole('button', {
      name: /delete rule/i,
    });
    expect(deleteButtons).toHaveLength(2); // MOCK_RULES has 2 entries
  });

  it('shows the MOCK chip when using fallback data', async () => {
    render(<LogMetricsView />);
    expect(await screen.findByText('MOCK')).toBeInTheDocument();
  });

  it('does NOT show the MOCK chip when API returns data', async () => {
    const resolvedRules = [
      {
        rule_id: 'live-001',
        metric_name: 'live.metric',
        description: '',
        filter_type: 'keyword',
        filter_value: 'timeout',
        value_field: '',
        metric_type: 0,
        group_by: '',
        enabled: true,
        created_at: Date.now(),
      },
    ];
    mockFetch.mockResolvedValueOnce(resolvedRules);

    render(<LogMetricsView />);

    // Wait for the live metric to appear
    expect(await screen.findByText('live.metric')).toBeInTheDocument();
    // MOCK chip should not be present
    expect(screen.queryByText('MOCK')).not.toBeInTheDocument();
  });
});

describe('LogMetricsView — form visibility', () => {
  it('renders the "+ New Rule" button', async () => {
    render(<LogMetricsView />);
    const newRuleBtn = await screen.findByRole('button', { name: /new rule/i });
    expect(newRuleBtn).toBeInTheDocument();
  });

  it('does not show the form before the button is clicked', async () => {
    render(<LogMetricsView />);
    // Wait for initial render to settle
    await screen.findByText('Log Metric Rules');
    expect(screen.queryByText('New Rule')).not.toBeInTheDocument();
  });

  it('reveals the form when "+ New Rule" is clicked', async () => {
    render(<LogMetricsView />);
    const btn = await screen.findByRole('button', { name: /new rule/i });
    fireEvent.click(btn);
    expect(await screen.findByText('New Rule')).toBeInTheDocument();
  });
});

describe('LogMetricsView — form fields', () => {
  async function openForm() {
    render(<LogMetricsView />);
    const btn = await screen.findByRole('button', { name: /new rule/i });
    fireEvent.click(btn);
    // Wait for the form title to confirm it's open
    await screen.findByText('New Rule');
  }

  it('shows the Metric name input', async () => {
    await openForm();
    expect(screen.getByPlaceholderText(/e\.g\. error\.count/i)).toBeInTheDocument();
  });

  it('shows the Description input', async () => {
    await openForm();
    expect(screen.getByPlaceholderText(/optional/i)).toBeInTheDocument();
  });

  it('shows the Filter type select with expected options', async () => {
    await openForm();
    // The component renders unlabelled <select> elements; identify the Filter type
    // select by its known option set (keyword, severity, service, body_regex).
    const selects = screen.getAllByRole('combobox');
    const filterTypeSelect = selects.find((el) => {
      const opts = Array.from((el as HTMLSelectElement).options).map((o) => o.value);
      return opts.includes('keyword') && opts.includes('severity') && opts.includes('body_regex');
    });
    expect(filterTypeSelect).toBeDefined();
    expect(filterTypeSelect).toBeInTheDocument();
  });

  it('shows the Filter value input', async () => {
    await openForm();
    expect(screen.getByPlaceholderText(/value to match/i)).toBeInTheDocument();
  });

  it('shows the Value field input', async () => {
    await openForm();
    expect(screen.getByPlaceholderText(/leave empty for count/i)).toBeInTheDocument();
  });

  it('shows the Metric type select', async () => {
    await openForm();
    // The Metric type select contains "counter" and "gauge" options
    const selects = screen.getAllByRole('combobox');
    const metricTypeSelect = selects.find((el) => {
      const opts = Array.from((el as HTMLSelectElement).options).map((o) => o.value);
      return opts.includes('counter') && opts.includes('gauge');
    });
    expect(metricTypeSelect).toBeDefined();
  });

  it('shows the Group by select', async () => {
    await openForm();
    // aria-label is not set on the select; find by its label text instead
    const labels = screen.getAllByText('Group by');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('shows a disabled "Create Rule" button when required fields are empty', async () => {
    await openForm();
    const createBtn = screen.getByRole('button', { name: /create rule/i });
    expect(createBtn).toBeDisabled();
  });

  it('enables "Create Rule" after filling required fields', async () => {
    await openForm();

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. error\.count/i), {
      target: { value: 'my.metric' },
    });
    fireEvent.change(screen.getByPlaceholderText(/value to match/i), {
      target: { value: 'ERROR' },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create rule/i })).not.toBeDisabled();
    });
  });
});
