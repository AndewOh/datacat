/**
 * TransactionTable.tsx — 선택된 트랜잭션 상세 테이블
 *
 * props: selectedPoints: XViewPoint[]
 * 컬럼: 시간 | 응답시간(ms) | 상태 | trace_id(앞 8자리)
 * 최대 100개 표시, 다크 테마, 스크롤 가능
 */

import type { XViewPoint } from '../XView/types';

interface TransactionTableProps {
  selectedPoints: XViewPoint[];
}

const MAX_ROWS = 100;

function fmtTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh  = String(d.getHours()).padStart(2, '0');
  const mm  = String(d.getMinutes()).padStart(2, '0');
  const ss  = String(d.getSeconds()).padStart(2, '0');
  const ms  = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function fmtDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(3)}s`;
  if (ms >= 1)    return `${ms.toFixed(1)}ms`;
  return `${(ms * 1000).toFixed(0)}µs`;
}

export function TransactionTable({ selectedPoints }: TransactionTableProps) {
  const rows = selectedPoints.slice(0, MAX_ROWS);
  const overflow = selectedPoints.length - MAX_ROWS;

  if (selectedPoints.length === 0) {
    return (
      <div style={styles.emptyState} aria-label="No transactions selected">
        <div style={styles.emptyIcon} aria-hidden="true">⬡</div>
        <p style={styles.emptyText}>X-View에서 드래그하여 트랜잭션을 선택하세요</p>
        <p style={styles.emptyHint}>shift+drag: 연속 선택 · Esc: 선택 해제</p>
      </div>
    );
  }

  return (
    <div style={styles.root}>
      <div style={styles.tableWrapper} role="region" aria-label="Selected transactions table">
        <table style={styles.table} aria-label="Transaction list">
          <thead>
            <tr>
              <th style={styles.th}>시간</th>
              <th style={{ ...styles.th, textAlign: 'right' as const }}>응답시간</th>
              <th style={styles.th}>상태</th>
              <th style={styles.th}>Trace ID</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((pt, i) => {
              const isError = pt.status === 1;
              return (
                <tr
                  key={pt.spanId}
                  style={i % 2 === 0 ? styles.trEven : styles.trOdd}
                >
                  <td style={styles.td}>
                    <span style={styles.mono}>{fmtTime(pt.x)}</span>
                  </td>
                  <td style={{ ...styles.td, textAlign: 'right' as const }}>
                    <span
                      style={{
                        ...styles.mono,
                        color: pt.y > 1000
                          ? '#F85149'
                          : pt.y > 300
                          ? '#f0c060'
                          : '#3FB950',
                      }}
                    >
                      {fmtDuration(pt.y)}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span
                      style={isError ? styles.errPill : styles.okPill}
                      aria-label={isError ? 'Error' : 'OK'}
                    >
                      {isError ? 'ERR' : 'OK'}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <code style={styles.mono}>
                      {pt.traceId.slice(0, 8)}
                    </code>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {overflow > 0 && (
        <div style={styles.overflow} aria-live="polite">
          상위 {MAX_ROWS}개 표시 · 선택된 {selectedPoints.length.toLocaleString()}개 중 나머지{' '}
          <strong style={{ color: '#C9D1D9' }}>{overflow.toLocaleString()}</strong>개는
          좀 더 좁은 영역으로 다시 드래그해 주세요
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    minHeight: 0,
    overflow: 'hidden',
  },
  tableWrapper: {
    flex: 1,
    overflowY: 'auto' as const,
    overflowX: 'hidden' as const,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  th: {
    padding: '7px 14px',
    textAlign: 'left' as const,
    color: 'rgba(201,209,217,0.4)',
    fontWeight: 600,
    fontSize: 10,
    letterSpacing: '0.06em',
    borderBottom: '1px solid #30363D',
    position: 'sticky' as const,
    top: 0,
    background: '#161B22',
    zIndex: 1,
    userSelect: 'none' as const,
  },
  td: {
    padding: '5px 14px',
    color: '#C9D1D9',
    verticalAlign: 'middle' as const,
    borderBottom: '1px solid rgba(48,54,61,0.4)',
  },
  trEven: { background: 'transparent' },
  trOdd:  { background: 'rgba(255,255,255,0.018)' },
  mono: {
    fontFamily: 'ui-monospace, "Cascadia Code", monospace',
    fontSize: 11,
    color: 'rgba(201,209,217,0.75)',
  },
  okPill: {
    display: 'inline-block',
    fontSize: 9,
    fontWeight: 700,
    color: '#3FB950',
    background: 'rgba(63,185,80,0.12)',
    border: '1px solid rgba(63,185,80,0.3)',
    padding: '1px 5px',
    borderRadius: 3,
    letterSpacing: '0.04em',
    fontFamily: 'ui-monospace, monospace',
  },
  errPill: {
    display: 'inline-block',
    fontSize: 9,
    fontWeight: 700,
    color: '#F85149',
    background: 'rgba(248,81,73,0.12)',
    border: '1px solid rgba(248,81,73,0.3)',
    padding: '1px 5px',
    borderRadius: 3,
    letterSpacing: '0.04em',
    fontFamily: 'ui-monospace, monospace',
  },
  overflow: {
    fontSize: 11,
    color: 'rgba(201,209,217,0.35)',
    padding: '7px 14px',
    borderTop: '1px solid #30363D',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    flexShrink: 0,
  },
  emptyState: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 8,
  },
  emptyIcon: {
    fontSize: 28,
    color: 'rgba(201,209,217,0.12)',
    marginBottom: 4,
  },
  emptyText: {
    fontSize: 13,
    color: 'rgba(201,209,217,0.35)',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    textAlign: 'center' as const,
  },
  emptyHint: {
    fontSize: 11,
    color: 'rgba(201,209,217,0.2)',
    fontFamily: 'ui-monospace, monospace',
    textAlign: 'center' as const,
    letterSpacing: '0.02em',
  },
} as const;
