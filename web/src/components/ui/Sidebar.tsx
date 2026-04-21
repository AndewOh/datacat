/**
 * Sidebar.tsx — 서비스 목록 (API 연동)
 *
 * - fetchServices 결과 기반 서비스 목록
 * - 각 항목에 p99 응답시간 표시
 * - 에러율 > 1%면 빨간 뱃지
 * - "All Services" 항목 맨 위
 */

import { useEffect, useState } from 'react';
import { fetchServices } from '../../api/client';
import type { Service, XViewStats } from '../../api/client';

interface SidebarProps {
  selectedService: string | null;
  onSelectService: (id: string | null) => void;
  stats: XViewStats | null;
}

function fmtP99(ns: number): string {
  if (!ns) return '';
  const ms = ns / 1_000_000;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms.toFixed(0)}ms`;
}

export function Sidebar({ selectedService, onSelectService, stats }: SidebarProps) {
  const [services, setServices] = useState<Service[]>([]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchServices(ctrl.signal)
      .then((list) => { if (!ctrl.signal.aborted) setServices(list); })
      .catch(() => { /* silent — API 없으면 빈 목록 */ });
    return () => ctrl.abort();
  }, []);

  const errRate = stats ? (stats.errors / Math.max(stats.total, 1)) * 100 : 0;
  const showErrBadge = errRate > 1;

  return (
    <aside style={styles.sidebar} aria-label="서비스 목록">
      {/* Logo */}
      <div style={styles.logoArea}>
        <span style={styles.logoText}>datacat</span>
        <span style={styles.logoDot}>.</span>
      </div>

      <nav style={styles.nav}>
        <p style={styles.sectionLabel}>서비스</p>

        {/* All Services */}
        <button
          style={{
            ...styles.serviceBtn,
            background: selectedService === null
              ? 'rgba(88,166,255,0.10)'
              : 'transparent',
            borderLeft: selectedService === null
              ? '2px solid #58A6FF'
              : '2px solid transparent',
          }}
          onClick={() => onSelectService(null)}
          aria-current={selectedService === null ? 'page' : undefined}
        >
          <span style={{ ...styles.statusDot, background: '#3FB950', boxShadow: '0 0 5px #3FB950' }} />
          <span style={styles.serviceName}>전체 서비스</span>
          {stats && (
            <span style={styles.p99}>
              {fmtP99(stats.p99_ns)}
            </span>
          )}
          {showErrBadge && selectedService === null && (
            <span style={styles.errBadge}>{errRate.toFixed(1)}%</span>
          )}
        </button>

        {/* Per-service items from API */}
        {services.map((svc) => {
          const isActive = selectedService === svc.name;
          return (
            <button
              key={`${svc.name}:${svc.env}`}
              style={{
                ...styles.serviceBtn,
                background: isActive ? 'rgba(88,166,255,0.10)' : 'transparent',
                borderLeft: isActive ? '2px solid #58A6FF' : '2px solid transparent',
              }}
              onClick={() => onSelectService(svc.name)}
              aria-current={isActive ? 'page' : undefined}
            >
              <span
                style={{
                  ...styles.statusDot,
                  background: '#58A6FF',
                  boxShadow: '0 0 5px rgba(88,166,255,0.5)',
                }}
              />
              <span style={styles.serviceName}>{svc.name}</span>
              <span style={styles.envLabel}>{svc.env}</span>
            </button>
          );
        })}

        {/* 서비스 없을 때 — API 미실행 안내 */}
        {services.length === 0 && (
          <p style={styles.emptyNote}>서비스 목록 로드 중...</p>
        )}
      </nav>

      <div style={styles.footer}>
        <p style={styles.footerText}>v0.1.0-phase1</p>
      </div>
    </aside>
  );
}

const styles = {
  sidebar: {
    width: 200,
    flexShrink: 0,
    background: '#161B22',
    borderRight: '1px solid #30363D',
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'hidden',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  logoArea: {
    padding: '18px 16px 14px',
    borderBottom: '1px solid rgba(48,54,61,0.8)',
    display: 'flex',
    alignItems: 'baseline',
    gap: 1,
    flexShrink: 0,
  },
  logoText: {
    fontSize: 16,
    fontWeight: 700,
    color: '#C9D1D9',
    letterSpacing: '-0.02em',
    fontFamily: 'ui-monospace, monospace',
  },
  logoDot: {
    fontSize: 20,
    fontWeight: 700,
    color: '#58A6FF',
    lineHeight: 1,
  },
  nav: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '10px 0',
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'rgba(201,209,217,0.3)',
    letterSpacing: '0.08em',
    padding: '0 16px',
    marginBottom: 4,
  },
  serviceBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    width: '100%',
    padding: '7px 12px 7px 14px',
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left' as const,
    transition: 'background 0.1s ease',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    flexShrink: 0,
  },
  serviceName: {
    flex: 1,
    fontSize: 12,
    color: '#C9D1D9',
    fontFamily: 'ui-monospace, monospace',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  envLabel: {
    fontSize: 9,
    color: 'rgba(201,209,217,0.3)',
    fontFamily: 'ui-monospace, monospace',
    flexShrink: 0,
  },
  p99: {
    fontSize: 10,
    color: 'rgba(201,209,217,0.4)',
    fontFamily: 'ui-monospace, monospace',
    flexShrink: 0,
  },
  errBadge: {
    fontSize: 9,
    fontWeight: 700,
    color: '#F85149',
    background: 'rgba(248,81,73,0.12)',
    border: '1px solid rgba(248,81,73,0.3)',
    borderRadius: 3,
    padding: '1px 4px',
    fontFamily: 'ui-monospace, monospace',
    flexShrink: 0,
  },
  emptyNote: {
    fontSize: 11,
    color: 'rgba(201,209,217,0.25)',
    padding: '8px 16px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  footer: {
    padding: '10px 16px',
    borderTop: '1px solid rgba(48,54,61,0.8)',
    flexShrink: 0,
  },
  footerText: {
    fontSize: 10,
    color: 'rgba(201,209,217,0.2)',
    fontFamily: 'ui-monospace, monospace',
  },
} as const;
