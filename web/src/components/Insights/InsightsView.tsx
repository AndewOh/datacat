/**
 * InsightsView.tsx — Phase 6 AI Auto-Ops
 *
 * 레이아웃 (flex row):
 *   [Anomaly Feed ~280px] | [Pattern Detection flex:1] | [AI Chat ~360px]
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import {
  fetchAnomalies,
  fetchPatterns,
  sendChatMessage,
} from '../../api/client';
import type {
  AnomalyReport,
  PatternDetected,
  PatternType,
  Finding,
  ChatResponse,
} from '../../api/client';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000)        return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatMetricLabel(metric: string): string {
  switch (metric) {
    case 'error_rate':    return 'Error Rate';
    case 'p99_latency_ms': return 'P99 Latency';
    default:              return metric;
  }
}

// ─── Pattern icons & colors ───────────────────────────────────────────────────

const PATTERN_META: Record<PatternType, { icon: string; color: string; bg: string }> = {
  Surge:     { icon: '⬆',  color: '#F85149', bg: 'rgba(248,81,73,0.1)'   },
  Waterfall: { icon: '↓',  color: '#58A6FF', bg: 'rgba(88,166,255,0.1)'  },
  Droplet:   { icon: '●',  color: '#E3B341', bg: 'rgba(227,179,65,0.1)'  },
  Wave:      { icon: '∿',  color: '#BC8CFF', bg: 'rgba(188,140,255,0.1)' },
};

const TIME_RANGE_OPTIONS = [
  { label: '15m', ms: 15 * 60 * 1000 },
  { label: '1h',  ms: 60 * 60 * 1000 },
  { label: '6h',  ms: 6 * 60 * 60 * 1000 },
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
] as const;

const FINDING_COLORS: Record<Finding['severity'], string> = {
  info:     '#58A6FF',
  warning:  '#E3B341',
  critical: '#F85149',
};

// ─── Mock data (API fallback) ─────────────────────────────────────────────────

const MOCK_ANOMALIES: AnomalyReport[] = [
  {
    service:     'api-gateway',
    metric:      'error_rate',
    score:       4.2,
    baseline:    0.012,
    current:     0.087,
    detected_at: Date.now() - 2 * 60 * 1000,
  },
  {
    service:     'order-service',
    metric:      'p99_latency_ms',
    score:       2.8,
    baseline:    142,
    current:     389,
    detected_at: Date.now() - 7 * 60 * 1000,
  },
  {
    service:     'payment-service',
    metric:      'error_rate',
    score:       3.5,
    baseline:    0.003,
    current:     0.041,
    detected_at: Date.now() - 14 * 60 * 1000,
  },
];

const MOCK_PATTERNS: PatternDetected[] = [
  {
    pattern:     'Surge',
    service:     'api-gateway',
    confidence:  0.92,
    description: 'Sudden spike in request volume, 8× above baseline over 3 minutes.',
    detected_at: Date.now() - 5 * 60 * 1000,
  },
  {
    pattern:     'Waterfall',
    service:     'order-service',
    confidence:  0.76,
    description: 'Cascading latency increase propagating downstream from DB timeout.',
    detected_at: Date.now() - 11 * 60 * 1000,
  },
  {
    pattern:     'Droplet',
    service:     'user-service',
    confidence:  0.61,
    description: 'Intermittent isolated errors, likely a single faulty instance.',
    detected_at: Date.now() - 18 * 60 * 1000,
  },
  {
    pattern:     'Wave',
    service:     'payment-service',
    confidence:  0.84,
    description: 'Oscillating error rate with ~4 min period — possible retry storm.',
    detected_at: Date.now() - 22 * 60 * 1000,
  },
];

function makeMockChatResponse(message: string): ChatResponse {
  const lower = message.toLowerCase();
  if (lower.includes('slow') || lower.includes('latency')) {
    return {
      reply: 'order-service is showing elevated P99 latency (389ms vs 142ms baseline, z-score 2.8). The Waterfall pattern suggests a DB timeout is propagating downstream.',
      findings: [
        { severity: 'warning', message: 'P99 latency 2.7× above baseline', service: 'order-service', metric: 'p99_latency_ms', value: 389 },
        { severity: 'info',    message: 'DB connection pool saturation detected', service: 'order-service' },
      ],
      suggested_actions: [
        'Check DB connection pool size',
        'Review recent query plans',
        'Scale order-service horizontally',
      ],
    };
  }
  if (lower.includes('error')) {
    return {
      reply: 'Two services are experiencing elevated error rates: api-gateway (8.7%, z-score 4.2) and payment-service (4.1%, z-score 3.5). These are above the critical threshold.',
      findings: [
        { severity: 'critical', message: 'Error rate 7× above baseline', service: 'api-gateway',    metric: 'error_rate', value: 0.087 },
        { severity: 'critical', message: 'Error rate 13× above baseline', service: 'payment-service', metric: 'error_rate', value: 0.041 },
      ],
      suggested_actions: [
        'Check api-gateway error logs',
        'Inspect payment-service dependency health',
        'Enable circuit breaker for payment-service',
      ],
    };
  }
  return {
    reply: `I analyzed the current system state. Here's a summary: 3 anomalies detected across api-gateway, order-service, and payment-service. The most critical is api-gateway with a z-score of 4.2 on error_rate. Would you like details on any specific service?`,
    findings: [
      { severity: 'critical', message: 'api-gateway error rate critically elevated', service: 'api-gateway' },
      { severity: 'warning',  message: 'order-service latency above threshold',      service: 'order-service' },
    ],
    suggested_actions: [
      'Run anomaly analysis',
      'Check api-gateway logs',
      'Detect XView patterns',
    ],
  };
}

// ─── Chat message types ───────────────────────────────────────────────────────

interface ChatMessage {
  id:        string;
  role:      'user' | 'assistant';
  text:      string;
  findings?: Finding[];
  actions?:  string[];
}

const INITIAL_MESSAGE: ChatMessage = {
  id:   'init',
  role: 'assistant',
  text: "안녕하세요! 시스템 상태를 분석해 드릴게요. 예시 질문: '느린 서비스가 있나요?' 또는 '최근 오류를 보여주세요'",
};

// ─── Panel 1: Anomaly Feed ────────────────────────────────────────────────────

function AnomalyFeed() {
  const [anomalies, setAnomalies] = useState<AnomalyReport[]>([]);
  const [loading, setLoading]     = useState(false);
  const [hasRun, setHasRun]       = useState(false);

  const analyze = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchAnomalies({});
      setAnomalies(res.anomalies);
    } catch {
      setAnomalies(MOCK_ANOMALIES);
    } finally {
      setLoading(false);
      setHasRun(true);
    }
  }, []);

  return (
    <div style={s.anomalyPanel}>
      {/* Header */}
      <div style={s.panelHeader}>
        <span style={s.panelTitle}>이상 감지 피드</span>
        <button
          style={{ ...s.actionBtn, ...(loading ? s.actionBtnDisabled : {}) }}
          onClick={analyze}
          disabled={loading}
          aria-label="이상 감지 실행"
        >
          {loading ? <Spinner size={10} /> : null}
          {loading ? '분석 중…' : '분석'}
        </button>
      </div>

      {/* Body */}
      <div style={s.anomalyBody}>
        {loading && !hasRun ? (
          <CenteredState>
            <Spinner size={20} />
            <span style={s.emptyText}>분석 중…</span>
          </CenteredState>
        ) : !hasRun ? (
          <CenteredState>
            <span style={s.emptyIcon}>⚡</span>
            <span style={s.emptyText}>분석 버튼을 눌러 시작하세요</span>
          </CenteredState>
        ) : anomalies.length === 0 ? (
          <CenteredState>
            <span style={s.emptyIcon}>✓</span>
            <span style={s.emptyText}>이상 없음</span>
          </CenteredState>
        ) : (
          <div style={s.anomalyList}>
            {anomalies.map((a, i) => (
              <AnomalyCard key={`${a.service}-${a.metric}-${i}`} anomaly={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AnomalyCard({ anomaly: a }: { anomaly: AnomalyReport }) {
  const scoreColor = a.score > 3 ? '#F85149' : a.score > 2 ? '#E3B341' : '#58A6FF';
  const scoreBg    = a.score > 3 ? 'rgba(248,81,73,0.12)' : a.score > 2 ? 'rgba(227,179,65,0.12)' : 'rgba(88,166,255,0.12)';
  const scoreBorder= a.score > 3 ? 'rgba(248,81,73,0.3)'  : a.score > 2 ? 'rgba(227,179,65,0.3)'  : 'rgba(88,166,255,0.3)';

  return (
    <div style={s.anomalyCard}>
      <div style={s.anomalyCardHeader}>
        <span style={s.anomalyService}>{a.service}</span>
        <span
          style={{
            ...s.scoreBadge,
            color:       scoreColor,
            background:  scoreBg,
            border:      `1px solid ${scoreBorder}`,
          }}
        >
          z={a.score.toFixed(1)}
        </span>
      </div>

      <div style={s.anomalyMetricRow}>
        <span style={s.anomalyMetricLabel}>{formatMetricLabel(a.metric)}</span>
        <span style={s.anomalyTime}>{relativeTime(a.detected_at)}</span>
      </div>

      <div style={s.anomalyValues}>
        <div style={s.anomalyValueGroup}>
          <span style={s.anomalyValueLabel}>기준값</span>
          <span style={s.anomalyValueNum}>{a.metric === 'error_rate' ? `${(a.baseline * 100).toFixed(2)}%` : `${a.baseline.toFixed(0)}ms`}</span>
        </div>
        <span style={s.anomalyArrow}>→</span>
        <div style={{ ...s.anomalyValueGroup, alignItems: 'flex-end' as const }}>
          <span style={s.anomalyValueLabel}>현재값</span>
          <span style={{ ...s.anomalyValueNum, color: scoreColor }}>
            {a.metric === 'error_rate' ? `${(a.current * 100).toFixed(2)}%` : `${a.current.toFixed(0)}ms`}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Panel 2: Pattern Detection ───────────────────────────────────────────────

function PatternDetection() {
  const [rangeMs, setRangeMs]     = useState(15 * 60 * 1000);
  const [patterns, setPatterns]   = useState<PatternDetected[]>([]);
  const [loading, setLoading]     = useState(false);
  const [hasRun, setHasRun]       = useState(false);

  const detect = useCallback(async () => {
    setLoading(true);
    const end   = Date.now();
    const start = end - rangeMs;
    try {
      const res = await fetchPatterns({ start, end });
      setPatterns(res.patterns);
    } catch {
      setPatterns(MOCK_PATTERNS);
    } finally {
      setLoading(false);
      setHasRun(true);
    }
  }, [rangeMs]);

  return (
    <div style={s.patternPanel}>
      {/* Header */}
      <div style={s.panelHeader}>
        <span style={s.panelTitle}>패턴 감지</span>
        <div style={s.patternControls}>
          {TIME_RANGE_OPTIONS.map((opt) => {
            const active = rangeMs === opt.ms;
            return (
              <button
                key={opt.ms}
                style={{
                  ...s.rangeBtn,
                  background:  active ? 'rgba(88,166,255,0.15)' : 'transparent',
                  color:       active ? '#58A6FF' : 'rgba(201,209,217,0.45)',
                  borderColor: active ? 'rgba(88,166,255,0.4)' : 'rgba(48,54,61,0.8)',
                }}
                onClick={() => setRangeMs(opt.ms)}
                aria-pressed={active}
              >
                {opt.label}
              </button>
            );
          })}
          <button
            style={{ ...s.actionBtn, ...(loading ? s.actionBtnDisabled : {}) }}
            onClick={detect}
            disabled={loading}
          >
            {loading ? <Spinner size={10} /> : null}
            {loading ? '감지 중…' : '감지'}
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={s.patternBody}>
        {loading && !hasRun ? (
          <CenteredState>
            <Spinner size={20} />
            <span style={s.emptyText}>패턴 감지 중…</span>
          </CenteredState>
        ) : !hasRun ? (
          <CenteredState>
            <span style={s.emptyIcon}>⬡</span>
            <span style={s.emptyText}>시간 범위를 선택하고 감지를 클릭하세요</span>
          </CenteredState>
        ) : patterns.length === 0 ? (
          <CenteredState>
            <span style={s.emptyIcon}>○</span>
            <span style={s.emptyText}>선택한 시간 범위에서 패턴이 없습니다</span>
          </CenteredState>
        ) : (
          <div style={s.patternGrid}>
            {patterns.map((p, i) => (
              <PatternCard key={`${p.service}-${p.pattern}-${i}`} pattern={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PatternCard({ pattern: p }: { pattern: PatternDetected }) {
  const meta = PATTERN_META[p.pattern];

  return (
    <div style={{ ...s.patternCard, borderColor: meta.color + '33' }}>
      <div style={s.patternCardHeader}>
        <span
          style={{
            ...s.patternIconWrap,
            color:      meta.color,
            background: meta.bg,
          }}
        >
          {meta.icon}
        </span>
        <div style={s.patternCardTitle}>
          <span style={{ ...s.patternType, color: meta.color }}>{p.pattern}</span>
          <span style={s.patternService}>{p.service}</span>
        </div>
        <span style={s.patternTime}>{relativeTime(p.detected_at)}</span>
      </div>

      {/* Confidence bar */}
      <div style={s.confRow}>
        <span style={s.confLabel}>신뢰도</span>
        <span style={{ ...s.confPct, color: meta.color }}>{Math.round(p.confidence * 100)}%</span>
      </div>
      <div style={s.confTrack}>
        <div
          style={{
            ...s.confFill,
            width:      `${p.confidence * 100}%`,
            background: meta.color,
          }}
        />
      </div>

      <p style={s.patternDesc}>{p.description}</p>
    </div>
  );
}

// ─── Panel 3: AI Chat ─────────────────────────────────────────────────────────

function AIChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([INITIAL_MESSAGE]);
  const [input, setInput]       = useState('');
  const [sending, setSending]   = useState(false);
  const scrollRef               = useRef<HTMLDivElement>(null);
  const inputRef                = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMessage = {
      id:   `u-${Date.now()}`,
      role: 'user',
      text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);

    try {
      const res = await sendChatMessage({ message: text });
      const assistantMsg: ChatMessage = {
        id:       `a-${Date.now()}`,
        role:     'assistant',
        text:     res.reply,
        findings: res.findings,
        actions:  res.suggested_actions,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch {
      const mock = makeMockChatResponse(text);
      setMessages((prev) => [
        ...prev,
        {
          id:       `a-${Date.now()}`,
          role:     'assistant',
          text:     mock.reply,
          findings: mock.findings,
          actions:  mock.suggested_actions,
        },
      ]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [input, sending]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  return (
    <div style={s.chatPanel}>
      {/* Header */}
      <div style={s.panelHeader}>
        <span style={s.panelTitle}>AI 어시스턴트</span>
        <span style={s.aiBadge}>AI</span>
      </div>

      {/* Message history */}
      <div style={s.chatHistory} ref={scrollRef}>
        {messages.map((msg) => (
          <ChatBubble key={msg.id} msg={msg} />
        ))}
        {sending && (
          <div style={s.typingRow}>
            <Spinner size={12} />
            <span style={s.typingText}>분석 중…</span>
          </div>
        )}
      </div>

      {/* Input area */}
      <div style={s.chatInputWrap}>
        <textarea
          ref={inputRef}
          style={s.chatInput}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="시스템 상태를 질문하세요… (Enter: 전송, Shift+Enter: 줄바꿈)"
          rows={2}
          disabled={sending}
          aria-label="채팅 메시지 입력"
        />
        <button
          style={{
            ...s.sendBtn,
            opacity: !input.trim() || sending ? 0.4 : 1,
          }}
          onClick={() => void send()}
          disabled={!input.trim() || sending}
          aria-label="메시지 전송"
        >
          ↑
        </button>
      </div>
    </div>
  );
}

function ChatBubble({ msg }: { msg: ChatMessage }) {
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [copiedAction, setCopiedAction] = useState<string | null>(null);

  const copyAction = useCallback((action: string) => {
    void navigator.clipboard.writeText(action).catch(() => undefined);
    setCopiedAction(action);
    setTimeout(() => setCopiedAction(null), 1500);
  }, []);

  if (msg.role === 'user') {
    return (
      <div style={s.userBubbleWrap}>
        <div style={s.userBubble}>
          <span style={s.bubbleText}>{msg.text}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={s.assistantBubbleWrap}>
      <div style={s.assistantBubble}>
        <span style={s.bubbleText}>{msg.text}</span>

        {/* Findings accordion */}
        {msg.findings && msg.findings.length > 0 && (
          <div style={s.findingsSection}>
            <button
              style={s.findingsToggle}
              onClick={() => setFindingsOpen((v) => !v)}
              aria-expanded={findingsOpen}
            >
              <span style={s.findingsToggleIcon}>{findingsOpen ? '▾' : '▸'}</span>
              발견 ({msg.findings.length})
            </button>
            {findingsOpen && (
              <div style={s.findingsList}>
                {msg.findings.map((f, i) => (
                  <div key={i} style={s.findingRow}>
                    <span
                      style={{
                        ...s.findingDot,
                        background: FINDING_COLORS[f.severity],
                        boxShadow:  `0 0 4px ${FINDING_COLORS[f.severity]}88`,
                      }}
                    />
                    <span style={s.findingMsg}>{f.message}</span>
                    {f.service && (
                      <span style={s.findingService}>{f.service}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Suggested actions */}
        {msg.actions && msg.actions.length > 0 && (
          <div style={s.actionsRow}>
            {msg.actions.map((action, i) => (
              <button
                key={i}
                style={{
                  ...s.actionPill,
                  background: copiedAction === action
                    ? 'rgba(86,211,100,0.15)'
                    : 'rgba(88,166,255,0.08)',
                  borderColor: copiedAction === action
                    ? 'rgba(86,211,100,0.4)'
                    : 'rgba(88,166,255,0.25)',
                  color: copiedAction === action ? '#56D364' : '#79C0FF',
                }}
                onClick={() => copyAction(action)}
                title={`실행: ${action}`}
              >
                {copiedAction === action ? '✓ 복사됨' : action}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function Spinner({ size = 16 }: { size?: number }) {
  return (
    <div
      style={{
        width:        size,
        height:       size,
        border:       `${Math.max(1, size / 8)}px solid rgba(88,166,255,0.2)`,
        borderTop:    `${Math.max(1, size / 8)}px solid #58A6FF`,
        borderRadius: '50%',
        flexShrink:   0,
        animation:    'spin 0.7s linear infinite',
      }}
    />
  );
}

function CenteredState({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        flex:           1,
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'center',
        justifyContent: 'center',
        gap:            8,
        padding:        16,
      }}
    >
      {children}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export function InsightsView() {
  return (
    <div style={s.root}>
      <AnomalyFeed />
      <div style={s.divider} />
      <PatternDetection />
      <div style={s.divider} />
      <AIChat />
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  root: {
    flex:       1,
    display:    'flex',
    flexDirection: 'row' as const,
    background: '#0D1117',
    overflow:   'hidden',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    minHeight:  0,
  },

  divider: {
    width:      1,
    background: '#30363D',
    flexShrink: 0,
  },

  // ── Shared panel header ───────────────────────────────────────────────
  panelHeader: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '10px 14px',
    background:     '#161B22',
    borderBottom:   '1px solid #30363D',
    flexShrink:     0,
    gap:            8,
  },
  panelTitle: {
    fontSize:      12,
    fontWeight:    700,
    color:         '#C9D1D9',
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    whiteSpace:    'nowrap' as const,
  },

  // ── Action button ─────────────────────────────────────────────────────
  actionBtn: {
    display:      'flex',
    alignItems:   'center',
    gap:          5,
    padding:      '4px 11px',
    background:   'rgba(88,166,255,0.1)',
    border:       '1px solid rgba(88,166,255,0.3)',
    borderRadius: 4,
    color:        '#58A6FF',
    fontSize:     11,
    fontWeight:   600,
    cursor:       'pointer',
    transition:   'all 0.12s ease',
    flexShrink:   0,
    whiteSpace:   'nowrap' as const,
  } as CSSProperties,
  actionBtnDisabled: {
    opacity: 0.5,
    cursor:  'not-allowed' as const,
  } as CSSProperties,

  // ── Anomaly panel ─────────────────────────────────────────────────────
  anomalyPanel: {
    width:         280,
    flexShrink:    0,
    display:       'flex',
    flexDirection: 'column' as const,
    overflow:      'hidden',
  },
  anomalyBody: {
    flex:      1,
    overflowY: 'auto' as const,
    minHeight: 0,
  },
  anomalyList: {
    display:       'flex',
    flexDirection: 'column' as const,
    padding:       '8px 10px',
    gap:           8,
  },
  anomalyCard: {
    background:   '#161B22',
    border:       '1px solid #30363D',
    borderRadius: 6,
    padding:      '10px 12px',
    display:      'flex',
    flexDirection:'column' as const,
    gap:          6,
  } as CSSProperties,
  anomalyCardHeader: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    gap:            6,
  },
  anomalyService: {
    fontSize:     12,
    fontWeight:   700,
    color:        '#C9D1D9',
    fontFamily:   'ui-monospace, monospace',
    overflow:     'hidden',
    textOverflow: 'ellipsis' as const,
    whiteSpace:   'nowrap' as const,
  } as CSSProperties,
  scoreBadge: {
    fontSize:      10,
    fontWeight:    700,
    fontFamily:    'ui-monospace, monospace',
    padding:       '2px 6px',
    borderRadius:  3,
    flexShrink:    0,
    letterSpacing: '0.02em',
  } as CSSProperties,
  anomalyMetricRow: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
  },
  anomalyMetricLabel: {
    fontSize:  10,
    color:     '#8B949E',
    fontWeight:500,
  },
  anomalyTime: {
    fontSize:   9,
    color:      'rgba(139,148,158,0.55)',
    fontFamily: 'ui-monospace, monospace',
  },
  anomalyValues: {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
    marginTop:  2,
  },
  anomalyValueGroup: {
    display:       'flex',
    flexDirection: 'column' as const,
    gap:           1,
    flex:          1,
  },
  anomalyValueLabel: {
    fontSize:  9,
    color:     'rgba(139,148,158,0.5)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  anomalyValueNum: {
    fontSize:   12,
    fontWeight: 600,
    color:      '#C9D1D9',
    fontFamily: 'ui-monospace, monospace',
  },
  anomalyArrow: {
    fontSize:  12,
    color:     'rgba(139,148,158,0.4)',
    flexShrink:0,
  },

  // ── Pattern panel ─────────────────────────────────────────────────────
  patternPanel: {
    flex:          1,
    display:       'flex',
    flexDirection: 'column' as const,
    overflow:      'hidden',
    minWidth:      0,
  },
  patternControls: {
    display:    'flex',
    alignItems: 'center',
    gap:        4,
  },
  rangeBtn: {
    padding:      '3px 9px',
    border:       '1px solid',
    borderRadius: 4,
    cursor:       'pointer',
    fontSize:     11,
    fontWeight:   500,
    fontFamily:   'system-ui, sans-serif',
    transition:   'all 0.12s ease',
    whiteSpace:   'nowrap' as const,
  } as CSSProperties,
  patternBody: {
    flex:      1,
    overflowY: 'auto' as const,
    padding:   '12px',
    minHeight: 0,
  },
  patternGrid: {
    display:             'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap:                 12,
  },
  patternCard: {
    background:   '#161B22',
    border:       '1px solid',
    borderRadius: 8,
    padding:      '12px 14px',
    display:      'flex',
    flexDirection:'column' as const,
    gap:          8,
  } as CSSProperties,
  patternCardHeader: {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
  },
  patternIconWrap: {
    width:          32,
    height:         32,
    borderRadius:   8,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    fontSize:       16,
    flexShrink:     0,
  } as CSSProperties,
  patternCardTitle: {
    display:       'flex',
    flexDirection: 'column' as const,
    gap:           1,
    flex:          1,
    minWidth:      0,
  },
  patternType: {
    fontSize:     11,
    fontWeight:   700,
    letterSpacing:'0.04em',
  },
  patternService: {
    fontSize:     10,
    color:        'rgba(201,209,217,0.55)',
    fontFamily:   'ui-monospace, monospace',
    overflow:     'hidden',
    textOverflow: 'ellipsis' as const,
    whiteSpace:   'nowrap' as const,
  } as CSSProperties,
  patternTime: {
    fontSize:   9,
    color:      'rgba(139,148,158,0.5)',
    fontFamily: 'ui-monospace, monospace',
    flexShrink: 0,
  },
  confRow: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
  },
  confLabel: {
    fontSize:  9,
    color:     'rgba(139,148,158,0.5)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
  },
  confPct: {
    fontSize:   10,
    fontWeight: 700,
    fontFamily: 'ui-monospace, monospace',
  },
  confTrack: {
    height:       4,
    background:   'rgba(48,54,61,0.8)',
    borderRadius: 2,
    overflow:     'hidden',
  },
  confFill: {
    height:       '100%',
    borderRadius: 2,
    transition:   'width 0.3s ease',
  } as CSSProperties,
  patternDesc: {
    fontSize:   11,
    color:      'rgba(201,209,217,0.6)',
    lineHeight: 1.5,
    margin:     0,
  },

  // ── Chat panel ────────────────────────────────────────────────────────
  chatPanel: {
    width:         360,
    flexShrink:    0,
    display:       'flex',
    flexDirection: 'column' as const,
    overflow:      'hidden',
  },
  aiBadge: {
    fontSize:      9,
    fontWeight:    700,
    color:         '#BC8CFF',
    background:    'rgba(188,140,255,0.12)',
    border:        '1px solid rgba(188,140,255,0.3)',
    borderRadius:  3,
    padding:       '1px 6px',
    fontFamily:    'ui-monospace, monospace',
    letterSpacing: '0.06em',
  } as CSSProperties,
  chatHistory: {
    flex:      1,
    overflowY: 'auto' as const,
    padding:   '12px 12px 4px',
    display:   'flex',
    flexDirection:'column' as const,
    gap:       10,
    minHeight: 0,
  },
  userBubbleWrap: {
    display:        'flex',
    justifyContent: 'flex-end' as const,
  },
  userBubble: {
    maxWidth:     '80%',
    background:   '#1E2A38',
    borderRadius: '12px 12px 2px 12px',
    padding:      '8px 12px',
    border:       '1px solid rgba(88,166,255,0.15)',
  },
  assistantBubbleWrap: {
    display:        'flex',
    justifyContent: 'flex-start' as const,
  },
  assistantBubble: {
    maxWidth:      '90%',
    background:    '#131C26',
    borderRadius:  '2px 12px 12px 12px',
    padding:       '10px 12px',
    border:        '1px solid rgba(48,54,61,0.6)',
    display:       'flex',
    flexDirection: 'column' as const,
    gap:           8,
  },
  bubbleText: {
    fontSize:   12,
    color:      '#C9D1D9',
    lineHeight: 1.55,
    whiteSpace: 'pre-wrap' as const,
  },
  typingRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
    padding:    '4px 0',
  },
  typingText: {
    fontSize:  11,
    color:     'rgba(139,148,158,0.5)',
    fontStyle: 'italic' as const,
  },

  // Findings accordion
  findingsSection: {
    borderTop:  '1px solid rgba(48,54,61,0.5)',
    paddingTop: 6,
  },
  findingsToggle: {
    display:    'flex',
    alignItems: 'center',
    gap:        5,
    background: 'transparent',
    border:     'none',
    color:      '#8B949E',
    fontSize:   10,
    fontWeight: 600,
    cursor:     'pointer',
    padding:    0,
    letterSpacing:'0.03em',
  } as CSSProperties,
  findingsToggleIcon: {
    fontSize:  10,
    color:     '#58A6FF',
  },
  findingsList: {
    display:       'flex',
    flexDirection: 'column' as const,
    gap:           5,
    marginTop:     6,
  },
  findingRow: {
    display:    'flex',
    alignItems: 'center',
    gap:        6,
  },
  findingDot: {
    width:        6,
    height:       6,
    borderRadius: '50%',
    flexShrink:   0,
  } as CSSProperties,
  findingMsg: {
    fontSize:  11,
    color:     'rgba(201,209,217,0.8)',
    flex:      1,
    minWidth:  0,
  },
  findingService: {
    fontSize:   9,
    color:      '#8B949E',
    fontFamily: 'ui-monospace, monospace',
    flexShrink: 0,
    background: 'rgba(48,54,61,0.6)',
    padding:    '1px 5px',
    borderRadius:3,
  } as CSSProperties,

  // Suggested actions
  actionsRow: {
    display:   'flex',
    flexWrap:  'wrap' as const,
    gap:       5,
    borderTop: '1px solid rgba(48,54,61,0.5)',
    paddingTop:6,
  },
  actionPill: {
    padding:      '3px 9px',
    borderRadius: 12,
    border:       '1px solid',
    cursor:       'pointer',
    fontSize:     10,
    fontWeight:   500,
    transition:   'all 0.12s ease',
    whiteSpace:   'nowrap' as const,
  } as CSSProperties,

  // Chat input
  chatInputWrap: {
    display:      'flex',
    alignItems:   'flex-end',
    gap:          8,
    padding:      '10px 12px',
    background:   '#161B22',
    borderTop:    '1px solid #30363D',
    flexShrink:   0,
  },
  chatInput: {
    flex:         1,
    background:   '#1C2128',
    border:       '1px solid #30363D',
    borderRadius: 8,
    color:        '#C9D1D9',
    fontSize:     12,
    padding:      '8px 10px',
    outline:      'none',
    fontFamily:   'system-ui, sans-serif',
    resize:       'none' as const,
    lineHeight:   1.5,
    maxHeight:    80,
    overflowY:    'auto' as const,
    boxSizing:    'border-box' as const,
  } as CSSProperties,
  sendBtn: {
    width:         32,
    height:        32,
    background:    'rgba(88,166,255,0.12)',
    border:        '1px solid rgba(88,166,255,0.3)',
    borderRadius:  8,
    color:         '#58A6FF',
    fontSize:      14,
    fontWeight:    700,
    cursor:        'pointer',
    display:       'flex',
    alignItems:    'center',
    justifyContent:'center',
    flexShrink:    0,
    transition:    'all 0.12s ease',
  } as CSSProperties,

  // Shared empty state
  emptyIcon: {
    fontSize: 24,
    opacity:  0.3,
  },
  emptyText: {
    fontSize:  12,
    color:     'rgba(139,148,158,0.45)',
    textAlign: 'center' as const,
  },
} as const;
