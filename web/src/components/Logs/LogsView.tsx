/**
 * LogsView.tsx — Phase 3 Logs Explorer
 *
 * 레이아웃:
 *   상단: 시간범위 + 서비스 필터 + 심각도 필터 + 검색어
 *   메인: 로그 테이블 (클릭 확장)
 *   하단: 라이브테일 토글 (WebSocket)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { fetchLogs, fetchServices } from '../../api/client';
import type { LogEntry, LogSeverity } from '../../api/client';

// ─── Mock data ────────────────────────────────────────────────────────────────

const MOCK_SERVICES = ['api-gateway', 'order-service', 'user-service', 'payment-service'];

const MOCK_MESSAGES: Record<LogSeverity, string[]> = {
  DEBUG: [
    'cache lookup: key=user:1234 hit=true ttl=290s',
    'DB connection pool: active=4 idle=6 max=20',
    'request context: trace_id=%s span_id=%s',
    'rate limiter: tokens remaining=98/100',
  ],
  INFO: [
    'HTTP 200 GET /api/v1/orders?limit=20 duration=12ms',
    'HTTP 201 POST /api/v1/orders body_size=342 duration=38ms',
    'service started on :8080 version=1.4.2',
    'config loaded: env=production region=ap-northeast-2',
    'user login: user_id=u_9182 method=jwt',
  ],
  WARN: [
    'HTTP 429 POST /api/v1/checkout rate_limit_exceeded client=10.0.0.42',
    'DB query slow: duration=820ms query=SELECT * FROM orders WHERE ...',
    'memory usage high: 78% threshold=75%',
    'retry attempt 2/3 for external payment API',
  ],
  ERROR: [
    'HTTP 500 POST /api/v1/payment unhandled panic: nil pointer dereference',
    'DB connection timeout after 5s: host=clickhouse:9000',
    'failed to publish event to Kafka: topic=order.created err=connection refused',
    'JWT validation failed: token expired at 2026-04-18T12:00:00Z',
  ],
};

function makeMockLog(i: number): LogEntry {
  const severities: LogSeverity[] = ['DEBUG', 'DEBUG', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];
  const sev = severities[Math.floor(Math.random() * severities.length)];
  const msgs = MOCK_MESSAGES[sev];
  const msg  = msgs[Math.floor(Math.random() * msgs.length)];
  const svc  = MOCK_SERVICES[Math.floor(Math.random() * MOCK_SERVICES.length)];
  const traceId = Math.random() > 0.5
    ? `${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`
    : undefined;

  return {
    id:        `log-${Date.now()}-${i}`,
    timestamp: Date.now() - i * 4000 - Math.floor(Math.random() * 2000),
    severity:  sev,
    service:   svc,
    message:   msg.replace('%s', Math.random().toString(16).slice(2, 10)),
    trace_id:  traceId,
    attrs: traceId ? {
      span_id:    Math.random().toString(16).slice(2, 10),
      pod:        `${svc}-${Math.floor(Math.random() * 5)}`,
      region:     'ap-northeast-2',
      version:    '1.4.2',
    } : undefined,
  };
}

const MOCK_LOGS: LogEntry[] = Array.from({ length: 24 }, (_, i) => makeMockLog(i));

// ─── Constants ────────────────────────────────────────────────────────────────

const SEVERITIES: Array<LogSeverity | 'ALL'> = ['ALL', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

const SEV_COLORS: Record<LogSeverity, string> = {
  DEBUG: '#8B949E',
  INFO:  '#58A6FF',
  WARN:  '#E3B341',
  ERROR: '#F85149',
};

const SEV_BG: Record<LogSeverity, string> = {
  DEBUG: 'rgba(139,148,158,0.1)',
  INFO:  'rgba(88,166,255,0.1)',
  WARN:  'rgba(227,179,65,0.1)',
  ERROR: 'rgba(248,81,73,0.1)',
};

const TIME_RANGE_OPTIONS = [
  { label: '15m', ms: 15 * 60 * 1000 },
  { label: '1h',  ms: 60 * 60 * 1000 },
  { label: '6h',  ms: 6 * 60 * 60 * 1000 },
] as const;

function formatTs(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString('ko-KR', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LogsView() {
  const [services, setServices]           = useState<string[]>(['all']);
  const [selectedService, setService]     = useState('all');
  const [severity, setSeverity]           = useState<LogSeverity | 'ALL'>('ALL');
  const [query, setQuery]                 = useState('');
  const [timeRange, setTimeRange]         = useState<number>(15 * 60 * 1000);

  const [logs, setLogs]                   = useState<LogEntry[]>([]);
  const [loading, setLoading]             = useState(false);
  const [useMock, setUseMock]             = useState(false);

  const [expandedId, setExpandedId]       = useState<string | null>(null);
  const [liveTail, setLiveTail]           = useState(false);

  const wsRef        = useRef<WebSocket | null>(null);
  const liveBufRef   = useRef<LogEntry[]>([]);

  // ─── 서비스 목록 ────────────────────────────────────────────────────────────
  useEffect(() => {
    fetchServices()
      .then((svcs) => setServices(['all', ...svcs.map((s) => s.name)]))
      .catch(() => setServices(['all', ...MOCK_SERVICES]));
  }, []);

  // ─── 로그 로드 ──────────────────────────────────────────────────────────────
  const loadLogs = useCallback(async () => {
    if (liveTail) return; // 라이브테일 중엔 정적 조회 안 함
    setLoading(true);

    const end   = Date.now();
    const start = end - timeRange;

    try {
      const res = await fetchLogs({
        service:  selectedService === 'all' ? undefined : selectedService,
        severity: severity === 'ALL' ? undefined : severity,
        query:    query || undefined,
        start,
        end,
        limit:    200,
      });
      setLogs(res.logs);
      setUseMock(false);
    } catch {
      // API 없으면 mock
      let filtered = MOCK_LOGS;
      if (selectedService !== 'all') {
        filtered = filtered.filter((l) => l.service === selectedService);
      }
      if (severity !== 'ALL') {
        filtered = filtered.filter((l) => l.severity === severity);
      }
      if (query) {
        const q = query.toLowerCase();
        filtered = filtered.filter((l) => l.message.toLowerCase().includes(q));
      }
      setLogs(filtered);
      setUseMock(true);
    } finally {
      setLoading(false);
    }
  }, [selectedService, severity, query, timeRange, liveTail]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  // ─── 라이브테일 WebSocket ────────────────────────────────────────────────────
  const startLiveTail = useCallback(() => {
    const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000')
      .replace(/^http/, 'ws');

    const params = new URLSearchParams();
    if (selectedService !== 'all') params.set('service', selectedService);
    if (severity !== 'ALL')        params.set('severity', severity);
    if (query)                     params.set('q', query);

    try {
      const ws = new WebSocket(`${API_BASE}/api/v1/logs/stream?${params.toString()}`);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        try {
          const entry = JSON.parse(ev.data as string) as LogEntry;
          liveBufRef.current = [entry, ...liveBufRef.current].slice(0, 500);
          setLogs([...liveBufRef.current]);
        } catch {
          // ignore parse errors
        }
      };

      ws.onerror = () => {
        // WS 실패 시 mock 스트리밍으로 폴백
        startMockStream();
      };
    } catch {
      startMockStream();
    }
  }, [selectedService, severity, query]);

  const mockIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startMockStream = useCallback(() => {
    setUseMock(true);
    liveBufRef.current = [...MOCK_LOGS];
    setLogs([...liveBufRef.current]);

    mockIntervalRef.current = setInterval(() => {
      const newEntry = makeMockLog(0);
      liveBufRef.current = [newEntry, ...liveBufRef.current].slice(0, 500);
      setLogs([...liveBufRef.current]);
    }, 2500);
  }, []);

  const stopLiveTail = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    if (mockIntervalRef.current) {
      clearInterval(mockIntervalRef.current);
      mockIntervalRef.current = null;
    }
    liveBufRef.current = [];
  }, []);

  const toggleLiveTail = useCallback(() => {
    if (liveTail) {
      stopLiveTail();
      setLiveTail(false);
      void loadLogs();
    } else {
      setLiveTail(true);
      startLiveTail();
    }
  }, [liveTail, stopLiveTail, startLiveTail, loadLogs]);

  // cleanup
  useEffect(() => () => stopLiveTail(), [stopLiveTail]);

  // ─── trace_id 클릭 → X-View ─────────────────────────────────────────────────
  const jumpToTrace = useCallback((traceId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    window.location.hash = `#/?trace_id=${encodeURIComponent(traceId)}`;
  }, []);

  // ─── 렌더 ──────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      {/* ── 상단 툴바 ── */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarGroup}>
          <label style={styles.label}>서비스</label>
          <select
            style={styles.select}
            value={selectedService}
            onChange={(e) => setService(e.target.value)}
            disabled={liveTail}
          >
            {services.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div style={styles.toolbarGroup}>
          <label style={styles.label}>심각도</label>
          <div style={styles.segmented}>
            {SEVERITIES.map((s) => {
              const active = severity === s;
              const color  = s === 'ALL' ? '#8B949E' : SEV_COLORS[s as LogSeverity];
              return (
                <button
                  key={s}
                  disabled={liveTail}
                  style={{
                    ...styles.segBtn,
                    background:  active ? (s === 'ALL' ? 'rgba(139,148,158,0.15)' : SEV_BG[s as LogSeverity]) : 'transparent',
                    color:       active ? color : 'rgba(139,148,158,0.5)',
                    borderColor: active ? color + '55' : '#30363D',
                  }}
                  onClick={() => setSeverity(s)}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>

        <div style={styles.toolbarGroup}>
          <label style={styles.label}>범위</label>
          <div style={styles.segmented}>
            {TIME_RANGE_OPTIONS.map((tr) => (
              <button
                key={tr.ms}
                disabled={liveTail}
                style={{
                  ...styles.segBtn,
                  background:  timeRange === tr.ms ? 'rgba(88,166,255,0.15)' : 'transparent',
                  color:       timeRange === tr.ms ? '#58A6FF' : '#8B949E',
                  borderColor: timeRange === tr.ms ? 'rgba(88,166,255,0.4)' : '#30363D',
                }}
                onClick={() => setTimeRange(tr.ms)}
              >
                {tr.label}
              </button>
            ))}
          </div>
        </div>

        {/* 검색 */}
        <div style={styles.searchWrap}>
          <input
            type="text"
            placeholder="메시지 검색..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={liveTail}
            style={styles.searchInput}
          />
        </div>

        {useMock && <span style={styles.mockChip}>MOCK</span>}
      </div>

      {/* ── 로그 테이블 ── */}
      <div style={styles.tableWrap}>
        {loading ? (
          <div style={styles.loadingWrap}>
            <Spinner />
            <span style={styles.loadingText}>로그 로딩 중…</span>
          </div>
        ) : logs.length === 0 ? (
          <div style={styles.emptyWrap}>
            <span style={styles.emptyText}>조건에 맞는 로그가 없습니다</span>
          </div>
        ) : (
          <div style={styles.tableScroll}>
            {/* 헤더 */}
            <div style={styles.tableHeader}>
              <div style={{ ...styles.colTime }}>시간</div>
              <div style={{ ...styles.colSev  }}>심각도</div>
              <div style={{ ...styles.colSvc  }}>서비스</div>
              <div style={{ ...styles.colMsg  }}>메시지</div>
              <div style={{ ...styles.colTrace}}>trace_id</div>
            </div>

            {/* 로그 행 */}
            {logs.map((log) => (
              <LogRow
                key={log.id}
                log={log}
                expanded={expandedId === log.id}
                onToggle={() =>
                  setExpandedId((prev) => (prev === log.id ? null : log.id))
                }
                onTraceClick={jumpToTrace}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── 하단 라이브테일 바 ── */}
      <div style={styles.liveBar}>
        <button
          style={{
            ...styles.liveBtn,
            background:   liveTail ? 'rgba(86,211,100,0.12)' : 'rgba(139,148,158,0.08)',
            border:       `1px solid ${liveTail ? 'rgba(86,211,100,0.4)' : '#30363D'}`,
            color:        liveTail ? '#56D364' : '#8B949E',
          }}
          onClick={toggleLiveTail}
        >
          <span
            style={{
              ...styles.liveDot,
              background: liveTail ? '#56D364' : '#8B949E',
              animation:  liveTail ? 'pulse 1s ease infinite' : 'none',
            }}
          />
          {liveTail ? '라이브테일 ON — 클릭해서 끄기' : '라이브테일 OFF — 클릭해서 켜기'}
        </button>

        <span style={styles.liveCount}>
          로그 {logs.length.toLocaleString()}건
        </span>
      </div>
    </div>
  );
}

// ─── LogRow ───────────────────────────────────────────────────────────────────

function LogRow({
  log,
  expanded,
  onToggle,
  onTraceClick,
}: {
  log: LogEntry;
  expanded: boolean;
  onToggle: () => void;
  onTraceClick: (id: string, e: React.MouseEvent) => void;
}) {
  const sevColor = SEV_COLORS[log.severity];
  const sevBg    = SEV_BG[log.severity];

  return (
    <div
      style={{
        ...styles.row,
        background: expanded ? '#161B22' : 'transparent',
        borderLeft: expanded ? `2px solid ${sevColor}` : '2px solid transparent',
      }}
      onClick={onToggle}
      role="row"
      aria-expanded={expanded}
    >
      {/* 메인 행 */}
      <div style={styles.rowMain}>
        <div style={styles.colTime}>
          <span style={styles.tsText}>{formatTs(log.timestamp)}</span>
        </div>

        <div style={styles.colSev}>
          <span
            style={{
              ...styles.sevBadge,
              color:       sevColor,
              background:  sevBg,
              borderColor: sevColor + '44',
            }}
          >
            {log.severity}
          </span>
        </div>

        <div style={styles.colSvc}>
          <span style={styles.svcText}>{log.service}</span>
        </div>

        <div style={styles.colMsg}>
          <span style={styles.msgText}>{log.message}</span>
        </div>

        <div style={styles.colTrace}>
          {log.trace_id ? (
            <button
              style={styles.traceBtn}
              onClick={(e) => onTraceClick(log.trace_id!, e)}
              title="X-View에서 트레이스 보기"
            >
              {log.trace_id.slice(0, 8)}…
            </button>
          ) : (
            <span style={styles.noTrace}>—</span>
          )}
        </div>
      </div>

      {/* 확장 attrs */}
      {expanded && log.attrs && (
        <div style={styles.attrsWrap}>
          {Object.entries(log.attrs).map(([k, v]) => (
            <div key={k} style={styles.attrRow}>
              <span style={styles.attrKey}>{k}</span>
              <span style={styles.attrVal}>{v}</span>
            </div>
          ))}
          <div style={styles.attrRow}>
            <span style={styles.attrKey}>timestamp</span>
            <span style={styles.attrVal}>{new Date(log.timestamp).toISOString()}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <div
      style={{
        width:        20,
        height:       20,
        border:       '2px solid rgba(88,166,255,0.2)',
        borderTop:    '2px solid #58A6FF',
        borderRadius: '50%',
        animation:    'spin 0.7s linear infinite',
      }}
    />
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const COL_TIME  = 88;
const COL_SEV   = 72;
const COL_SVC   = 128;
const COL_TRACE = 100;

const styles = {
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
    gap:          12,
    padding:      '8px 16px',
    background:   '#161B22',
    borderBottom: '1px solid #30363D',
    flexShrink:   0,
    flexWrap:     'wrap' as const,
  },
  toolbarGroup: {
    display:    'flex',
    alignItems: 'center',
    gap:        6,
  },
  label: {
    fontSize:   11,
    color:      '#8B949E',
    fontWeight: 500,
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,
  select: {
    background:   '#1C2128',
    border:       '1px solid #30363D',
    borderRadius: 4,
    color:        '#C9D1D9',
    fontSize:     12,
    padding:      '3px 8px',
    cursor:       'pointer',
    outline:      'none',
  } as CSSProperties,
  segmented: {
    display:    'flex',
    borderRadius:4,
    overflow:   'hidden',
    border:     '1px solid #30363D',
  },
  segBtn: {
    padding:    '3px 8px',
    border:     'none',
    borderRight:'1px solid',
    cursor:     'pointer',
    fontSize:   10,
    fontWeight: 700,
    fontFamily: 'ui-monospace, monospace',
    transition: 'all 0.1s ease',
    letterSpacing: '0.04em',
  } as CSSProperties,
  searchWrap: {
    flex:      1,
    minWidth:  160,
    maxWidth:  300,
  },
  searchInput: {
    width:        '100%',
    background:   '#1C2128',
    border:       '1px solid #30363D',
    borderRadius: 4,
    color:        '#C9D1D9',
    fontSize:     12,
    padding:      '4px 10px',
    outline:      'none',
    fontFamily:   'system-ui, sans-serif',
    boxSizing:    'border-box' as const,
  } as CSSProperties,
  mockChip: {
    fontSize:     9,
    fontWeight:   700,
    color:        '#E3B341',
    background:   'rgba(227,179,65,0.12)',
    border:       '1px solid rgba(227,179,65,0.25)',
    borderRadius: 3,
    padding:      '2px 6px',
    fontFamily:   'ui-monospace, monospace',
    letterSpacing:'0.06em',
  } as CSSProperties,
  tableWrap: {
    flex:       1,
    display:    'flex',
    flexDirection:'column' as const,
    overflow:   'hidden',
    minHeight:  0,
  },
  tableScroll: {
    flex:     1,
    overflowY:'auto' as const,
  },
  tableHeader: {
    display:      'flex',
    alignItems:   'center',
    padding:      '5px 12px',
    background:   '#161B22',
    borderBottom: '1px solid #30363D',
    position:     'sticky' as const,
    top:          0,
    zIndex:       2,
  },
  colTime: {
    width:    COL_TIME,
    flexShrink:0,
    fontSize: 10,
    fontWeight:600,
    color:    '#8B949E',
    letterSpacing:'0.04em',
    textTransform:'uppercase' as const,
  } as CSSProperties,
  colSev: {
    width:    COL_SEV,
    flexShrink:0,
    fontSize: 10,
    fontWeight:600,
    color:    '#8B949E',
    letterSpacing:'0.04em',
    textTransform:'uppercase' as const,
  } as CSSProperties,
  colSvc: {
    width:    COL_SVC,
    flexShrink:0,
    fontSize: 10,
    fontWeight:600,
    color:    '#8B949E',
    letterSpacing:'0.04em',
    textTransform:'uppercase' as const,
    overflow: 'hidden',
    textOverflow:'ellipsis' as const,
    whiteSpace:'nowrap' as const,
  } as CSSProperties,
  colMsg: {
    flex:     1,
    minWidth: 0,
    fontSize: 10,
    fontWeight:600,
    color:    '#8B949E',
    letterSpacing:'0.04em',
    textTransform:'uppercase' as const,
  } as CSSProperties,
  colTrace: {
    width:    COL_TRACE,
    flexShrink:0,
    fontSize: 10,
    fontWeight:600,
    color:    '#8B949E',
    letterSpacing:'0.04em',
    textTransform:'uppercase' as const,
    textAlign:'right' as const,
  } as CSSProperties,
  row: {
    borderBottom: '1px solid rgba(48,54,61,0.5)',
    cursor:       'pointer',
    transition:   'background 0.08s ease',
    borderLeft:   '2px solid transparent',
  } as CSSProperties,
  rowMain: {
    display:    'flex',
    alignItems: 'center',
    padding:    '5px 12px',
    gap:        0,
  },
  tsText: {
    fontSize:   11,
    color:      '#8B949E',
    fontFamily: 'ui-monospace, monospace',
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,
  sevBadge: {
    display:      'inline-block',
    fontSize:     9,
    fontWeight:   700,
    fontFamily:   'ui-monospace, monospace',
    letterSpacing:'0.06em',
    padding:      '1px 5px',
    borderRadius: 3,
    border:       '1px solid',
  } as CSSProperties,
  svcText: {
    fontSize:     11,
    color:        'rgba(201,209,217,0.7)',
    fontFamily:   'ui-monospace, monospace',
    overflow:     'hidden',
    textOverflow: 'ellipsis' as const,
    whiteSpace:   'nowrap' as const,
    display:      'block' as const,
  } as CSSProperties,
  msgText: {
    fontSize:   12,
    color:      '#C9D1D9',
    fontFamily: 'ui-monospace, monospace',
    overflow:   'hidden',
    textOverflow:'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
    display:    'block' as const,
  } as CSSProperties,
  traceBtn: {
    background:   'transparent',
    border:       'none',
    color:        '#58A6FF',
    fontSize:     10,
    fontFamily:   'ui-monospace, monospace',
    cursor:       'pointer',
    padding:      '1px 4px',
    borderRadius: 3,
    textDecoration:'underline',
    textAlign:    'right' as const,
    width:        '100%',
  } as CSSProperties,
  noTrace: {
    fontSize:   11,
    color:      'rgba(139,148,158,0.3)',
    display:    'block',
    textAlign:  'right' as const,
  } as CSSProperties,
  attrsWrap: {
    display:        'flex',
    flexWrap:       'wrap' as const,
    gap:            '4px 16px',
    padding:        '6px 12px 8px calc(12px + 2px)',
    background:     'rgba(22,27,34,0.5)',
    borderTop:      '1px solid rgba(48,54,61,0.5)',
  },
  attrRow: {
    display:    'flex',
    gap:        6,
    alignItems: 'baseline',
  },
  attrKey: {
    fontSize:   10,
    color:      '#8B949E',
    fontFamily: 'ui-monospace, monospace',
    fontWeight: 500,
  },
  attrVal: {
    fontSize:   10,
    color:      '#E3B341',
    fontFamily: 'ui-monospace, monospace',
  },
  loadingWrap: {
    flex:           1,
    display:        'flex',
    flexDirection:  'column' as const,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            10,
  },
  loadingText: {
    fontSize:   12,
    color:      'rgba(139,148,158,0.5)',
    fontFamily: 'system-ui, sans-serif',
  },
  emptyWrap: {
    flex:           1,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontSize:   13,
    color:      'rgba(139,148,158,0.4)',
    fontFamily: 'system-ui, sans-serif',
  },
  liveBar: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '6px 16px',
    background:     '#161B22',
    borderTop:      '1px solid #30363D',
    flexShrink:     0,
  },
  liveBtn: {
    display:      'flex',
    alignItems:   'center',
    gap:          7,
    padding:      '4px 12px',
    borderRadius: 4,
    cursor:       'pointer',
    fontSize:     11,
    fontWeight:   600,
    fontFamily:   'system-ui, sans-serif',
    transition:   'all 0.15s ease',
  } as CSSProperties,
  liveDot: {
    width:        7,
    height:       7,
    borderRadius: '50%',
    flexShrink:   0,
  } as CSSProperties,
  liveCount: {
    fontSize:   11,
    color:      'rgba(139,148,158,0.5)',
    fontFamily: 'ui-monospace, monospace',
  },
} as const;
