import { useState, useEffect, useCallback } from 'react';
import type { CSSProperties } from 'react';
import {
  fetchLogMetricRules,
  createLogMetricRule,
  deleteLogMetricRule,
} from '../../api/client';
import type { LogMetricRule, CreateRuleRequest } from '../../api/client';

const MOCK_RULES: LogMetricRule[] = [
  {
    rule_id:      'r-001',
    metric_name:  'error.count',
    description:  'Count ERROR logs',
    filter_type:  'severity',
    filter_value: 'ERROR',
    value_field:  '',
    metric_type:  0,
    group_by:     'service',
    enabled:      true,
    created_at:   Date.now() - 86400_000,
  },
  {
    rule_id:      'r-002',
    metric_name:  'payment.duration',
    description:  'Payment API latency gauge',
    filter_type:  'service',
    filter_value: 'payment-service',
    value_field:  'duration_ms',
    metric_type:  1,
    group_by:     '',
    enabled:      true,
    created_at:   Date.now() - 3600_000,
  },
];

const FILTER_TYPES = ['keyword', 'severity', 'service', 'body_regex'] as const;
const GROUP_BY_OPTIONS = [
  { label: 'none',        value: '' },
  { label: 'service',     value: 'service' },
  { label: 'env',         value: 'env' },
  { label: 'service+env', value: 'service,env' },
] as const;

interface FormState {
  metric_name:     string;
  description:     string;
  filter_type:     string;
  filter_value:    string;
  value_field:     string;
  metric_type_str: string;
  group_by:        string;
}

const EMPTY_FORM: FormState = {
  metric_name:     '',
  description:     '',
  filter_type:     'keyword',
  filter_value:    '',
  value_field:     '',
  metric_type_str: 'counter',
  group_by:        '',
};

export function LogMetricsView() {
  const [rules, setRules]           = useState<LogMetricRule[]>([]);
  const [usingMock, setUsingMock]   = useState(false);
  const [showForm, setShowForm]     = useState(false);
  const [form, setForm]             = useState({ ...EMPTY_FORM });
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [deleteError, setDeleteError] = useState('');

  const loadRules = useCallback(async () => {
    try {
      const list = await fetchLogMetricRules('default');
      setRules(list);
      setUsingMock(false);
    } catch {
      setRules(MOCK_RULES);
      setUsingMock(true);
    }
  }, []);

  useEffect(() => { void loadRules(); }, [loadRules]);

  const handleDelete = useCallback(async (ruleId: string) => {
    setDeleteError('');
    try {
      await deleteLogMetricRule(ruleId);
      await loadRules();
    } catch {
      setDeleteError(`Failed to delete rule ${ruleId}`);
    }
  }, [loadRules]);

  const handleFieldChange = useCallback(
    <K extends keyof FormState>(key: K, value: (FormState)[K]) => {
      setForm((prev) => {
        const next = { ...prev, [key]: value };
        if (key === 'value_field') {
          next.metric_type_str = (value as string) ? 'gauge' : 'counter';
        }
        if (key === 'metric_type_str') {
          if (value === 'counter') next.value_field = '';
        }
        return next;
      });
    },
    [],
  );

  const handleSubmit = useCallback(async () => {
    if (!form.metric_name.trim() || !form.filter_type || !form.filter_value.trim()) return;
    setSubmitting(true);
    const req: CreateRuleRequest = {
      metric_name:  form.metric_name.trim(),
      description:  form.description.trim() || undefined,
      filter_type:  form.filter_type,
      filter_value: form.filter_value.trim(),
      value_field:  form.value_field.trim() || undefined,
      metric_type:  form.metric_type_str === 'gauge' ? 1 : 0,
      group_by:     form.group_by || undefined,
    };
    try {
      await createLogMetricRule(req);
      setForm({ ...EMPTY_FORM });
      setShowForm(false);
      setSuccessMsg('Rule created.');
      setTimeout(() => setSuccessMsg(''), 3000);
      await loadRules();
    } catch {
      setSuccessMsg('');
    } finally {
      setSubmitting(false);
    }
  }, [form, loadRules]);

  return (
    <div style={s.root}>
      <div style={s.header}>
        <span style={s.title}>Log Metric Rules</span>
        {usingMock && <span style={s.mockChip}>MOCK</span>}
        {successMsg && <span style={s.successMsg}>{successMsg}</span>}
        {deleteError && <span style={s.errorMsg}>{deleteError}</span>}
        <button
          style={s.newBtn}
          onClick={() => setShowForm((v) => !v)}
          aria-pressed={showForm}
        >
          {showForm ? '× Cancel' : '+ New Rule'}
        </button>
      </div>

      <div style={s.body}>
        <div style={s.rulesList}>
          {rules.length === 0 ? (
            <div style={s.emptyList}>No rules defined.</div>
          ) : (
            rules.map((rule) => (
              <RuleCard key={rule.rule_id} rule={rule} onDelete={handleDelete} />
            ))
          )}
        </div>

        <div style={s.formPane}>
          {showForm ? (
            <NewRuleForm
              form={form}
              submitting={submitting}
              onChange={handleFieldChange}
              onSubmit={handleSubmit}
            />
          ) : (
            <div style={s.emptyState}>
              <span style={s.emptyIcon}>◎</span>
              <span style={s.emptyText}>Click "+ New Rule" to create a log metric rule.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RuleCard({
  rule,
  onDelete,
}: {
  rule: LogMetricRule;
  onDelete: (id: string) => void;
}) {
  const valueLabel = rule.value_field
    ? `field: ${rule.value_field}`
    : 'count';

  return (
    <div style={s.ruleCard}>
      <div style={s.ruleCardTop}>
        <span style={s.ruleMetricName}>{rule.metric_name}</span>
        <button
          style={s.deleteBtn}
          onClick={() => onDelete(rule.rule_id)}
          aria-label={`Delete rule ${rule.metric_name}`}
          title="Delete rule"
        >
          ×
        </button>
      </div>
      <div style={s.ruleDetail}>
        <span style={s.ruleDetailLabel}>Filter</span>
        <span style={s.ruleDetailVal}>{rule.filter_type}: {rule.filter_value}</span>
      </div>
      <div style={s.ruleDetail}>
        <span style={s.ruleDetailLabel}>Value</span>
        <span style={s.ruleDetailVal}>{valueLabel}</span>
      </div>
      {rule.group_by && (
        <div style={s.ruleDetail}>
          <span style={s.ruleDetailLabel}>Group by</span>
          <span style={s.ruleDetailVal}>{rule.group_by}</span>
        </div>
      )}
      {rule.description && (
        <div style={s.ruleDesc}>{rule.description}</div>
      )}
    </div>
  );
}

function NewRuleForm({
  form,
  submitting,
  onChange,
  onSubmit,
}: {
  form: FormState;
  submitting: boolean;
  onChange: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  onSubmit: () => void;
}) {
  const canSubmit = form.metric_name.trim() && form.filter_value.trim() && !submitting;

  return (
    <div style={s.formWrap}>
      <div style={s.formTitle}>New Rule</div>

      <Field label="Metric name">
        <input
          style={s.input}
          type="text"
          placeholder="e.g. error.count"
          value={form.metric_name}
          onChange={(e) => onChange('metric_name', e.target.value)}
        />
      </Field>

      <Field label="Description">
        <input
          style={s.input}
          type="text"
          placeholder="Optional"
          value={form.description}
          onChange={(e) => onChange('description', e.target.value)}
        />
      </Field>

      <Field label="Filter type">
        <select
          style={s.input}
          value={form.filter_type}
          onChange={(e) => onChange('filter_type', e.target.value as typeof form.filter_type)}
        >
          {FILTER_TYPES.map((ft) => (
            <option key={ft} value={ft}>{ft}</option>
          ))}
        </select>
      </Field>

      <Field label="Filter value">
        <input
          style={s.input}
          type="text"
          placeholder="Value to match"
          value={form.filter_value}
          onChange={(e) => onChange('filter_value', e.target.value)}
        />
      </Field>

      <Field label="Value field">
        <input
          style={s.input}
          type="text"
          placeholder="Leave empty for count"
          value={form.value_field}
          onChange={(e) => onChange('value_field', e.target.value)}
        />
      </Field>

      <Field label="Metric type">
        <select
          style={s.input}
          value={form.metric_type_str}
          onChange={(e) => onChange('metric_type_str', e.target.value as 'counter' | 'gauge')}
        >
          <option value="counter">counter</option>
          <option value="gauge">gauge</option>
        </select>
      </Field>

      <Field label="Group by">
        <select
          style={s.input}
          value={form.group_by}
          onChange={(e) => onChange('group_by', e.target.value)}
        >
          {GROUP_BY_OPTIONS.map((g) => (
            <option key={g.value} value={g.value}>{g.label}</option>
          ))}
        </select>
      </Field>

      <button
        style={{
          ...s.submitBtn,
          opacity: canSubmit ? 1 : 0.4,
          cursor:  canSubmit ? 'pointer' : 'not-allowed',
        }}
        disabled={!canSubmit}
        onClick={onSubmit}
      >
        {submitting ? 'Creating…' : 'Create Rule'}
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={s.field}>
      <label style={s.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

const s = {
  root: {
    flex:          1,
    display:       'flex',
    flexDirection: 'column' as const,
    background:    '#0D1117',
    overflow:      'hidden',
    fontFamily:    'system-ui, -apple-system, sans-serif',
  },
  header: {
    display:      'flex',
    alignItems:   'center',
    gap:          10,
    padding:      '10px 16px',
    background:   '#161B22',
    borderBottom: '1px solid #30363D',
    flexShrink:   0,
  },
  title: {
    fontSize:   14,
    fontWeight: 600,
    color:      '#C9D1D9',
    marginRight: 4,
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
  successMsg: {
    fontSize:   11,
    color:      '#3FB950',
    fontFamily: 'system-ui, sans-serif',
  },
  errorMsg: {
    fontSize:   11,
    color:      '#F85149',
    fontFamily: 'system-ui, sans-serif',
  },
  newBtn: {
    marginLeft:   'auto',
    padding:      '5px 12px',
    background:   'rgba(88,166,255,0.12)',
    color:        '#58A6FF',
    border:       '1px solid rgba(88,166,255,0.35)',
    borderRadius: 5,
    fontSize:     12,
    fontWeight:   600,
    cursor:       'pointer',
    transition:   'all 0.12s ease',
  } as CSSProperties,
  body: {
    flex:      1,
    display:   'flex',
    minHeight: 0,
    overflow:  'hidden',
  },
  rulesList: {
    width:        360,
    flexShrink:   0,
    overflowY:    'auto' as const,
    borderRight:  '1px solid #30363D',
    display:      'flex',
    flexDirection:'column' as const,
    gap:          1,
    background:   '#0D1117',
    padding:      8,
  },
  emptyList: {
    padding:    24,
    fontSize:   12,
    color:      'rgba(139,148,158,0.5)',
    textAlign:  'center' as const,
  },
  ruleCard: {
    background:   '#161B22',
    border:       '1px solid #30363D',
    borderRadius: 6,
    padding:      '10px 12px',
    display:      'flex',
    flexDirection:'column' as const,
    gap:          4,
  },
  ruleCardTop: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:   2,
  },
  ruleMetricName: {
    fontSize:   13,
    fontWeight: 600,
    color:      '#58A6FF',
    fontFamily: 'ui-monospace, monospace',
  },
  deleteBtn: {
    background:     'transparent',
    color:          'rgba(201,209,217,0.4)',
    border:         '1px solid transparent',
    borderRadius:   4,
    width:          20,
    height:         20,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    cursor:         'pointer',
    fontSize:       14,
    lineHeight:     1,
    padding:        0,
    transition:     'color 0.1s ease',
  } as CSSProperties,
  ruleDetail: {
    display:    'flex',
    gap:        6,
    alignItems: 'baseline',
  },
  ruleDetailLabel: {
    fontSize:   10,
    fontWeight: 600,
    color:      '#8B949E',
    fontFamily: 'ui-monospace, monospace',
    width:      52,
    flexShrink: 0,
  },
  ruleDetailVal: {
    fontSize:   11,
    color:      '#C9D1D9',
    fontFamily: 'ui-monospace, monospace',
  },
  ruleDesc: {
    fontSize:   11,
    color:      'rgba(139,148,158,0.6)',
    marginTop:  2,
    fontStyle:  'italic' as const,
  },
  formPane: {
    flex:          1,
    minWidth:      0,
    overflowY:     'auto' as const,
    display:       'flex',
    flexDirection: 'column' as const,
  },
  emptyState: {
    flex:           1,
    display:        'flex',
    flexDirection:  'column' as const,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            10,
    color:          'rgba(139,148,158,0.4)',
  },
  emptyIcon: {
    fontSize: 40,
  },
  emptyText: {
    fontSize:   12,
    fontFamily: 'system-ui, sans-serif',
    textAlign:  'center' as const,
  },
  formWrap: {
    padding:       24,
    display:       'flex',
    flexDirection: 'column' as const,
    gap:           14,
    maxWidth:      480,
  },
  formTitle: {
    fontSize:     14,
    fontWeight:   600,
    color:        '#C9D1D9',
    marginBottom: 4,
  },
  field: {
    display:       'flex',
    flexDirection: 'column' as const,
    gap:           4,
  },
  fieldLabel: {
    fontSize:   11,
    fontWeight: 500,
    color:      '#8B949E',
  },
  input: {
    background:   '#1C2128',
    border:       '1px solid #30363D',
    borderRadius: 4,
    color:        '#C9D1D9',
    fontSize:     12,
    padding:      '6px 10px',
    outline:      'none',
    fontFamily:   'system-ui, -apple-system, sans-serif',
    width:        '100%',
    boxSizing:    'border-box' as const,
  } as CSSProperties,
  submitBtn: {
    padding:      '8px 20px',
    background:   'rgba(88,166,255,0.15)',
    color:        '#58A6FF',
    border:       '1px solid rgba(88,166,255,0.4)',
    borderRadius: 5,
    fontSize:     13,
    fontWeight:   600,
    fontFamily:   'system-ui, sans-serif',
    marginTop:    4,
    transition:   'all 0.12s ease',
    alignSelf:    'flex-start' as const,
  } as CSSProperties,
} as const;
