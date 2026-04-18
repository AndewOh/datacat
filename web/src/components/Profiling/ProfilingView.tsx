/**
 * ProfilingView.tsx — Phase 4 Continuous Profiling 뷰
 *
 * 레이아웃:
 *   상단: 서비스 선택 + 프로파일 타입 + 시간범위
 *   좌측: 프로파일 목록 (타임스탬프 + 크기)
 *   우측: FlamegraphRenderer (선택 프로파일)
 */

import { useState, useEffect, useCallback } from 'react';
import type { CSSProperties } from 'react';
import {
  fetchProfiles,
  fetchFlamegraph,
  fetchServices,
} from '../../api/client';
import type { ProfileInfo, FoldedFrame } from '../../api/client';
import { FlamegraphRenderer } from './FlamegraphRenderer';

// ─── Mock data ────────────────────────────────────────────────────────────────

const MOCK_PROFILES: ProfileInfo[] = [
  { id: 'prof-001', service: 'api-gateway',  type: 'cpu',      timestamp: Date.now() - 1000 * 60 * 2,  size_bytes: 142_300 },
  { id: 'prof-002', service: 'api-gateway',  type: 'cpu',      timestamp: Date.now() - 1000 * 60 * 7,  size_bytes: 138_900 },
  { id: 'prof-003', service: 'api-gateway',  type: 'heap',     timestamp: Date.now() - 1000 * 60 * 12, size_bytes: 210_400 },
  { id: 'prof-004', service: 'api-gateway',  type: 'goroutine',timestamp: Date.now() - 1000 * 60 * 17, size_bytes: 56_800  },
  { id: 'prof-005', service: 'order-service',type: 'cpu',      timestamp: Date.now() - 1000 * 60 * 22, size_bytes: 165_200 },
  { id: 'prof-006', service: 'order-service',type: 'heap',     timestamp: Date.now() - 1000 * 60 * 27, size_bytes: 198_700 },
  { id: 'prof-007', service: 'user-service', type: 'cpu',      timestamp: Date.now() - 1000 * 60 * 32, size_bytes: 132_100 },
];

const MOCK_FOLDED: FoldedFrame[] = [
  { stack: 'main;http.ListenAndServe;net/http.(*Server).Serve', value: 120 },
  { stack: 'main;http.ListenAndServe;net/http.(*Server).Serve;net/http.(*conn).serve', value: 100 },
  { stack: 'main;http.ListenAndServe;net/http.(*Server).Serve;net/http.(*conn).serve;runtime.mallocgc', value: 35 },
  { stack: 'main;http.ListenAndServe;net/http.(*Server).Serve;net/http.(*conn).serve;runtime.gcBgMarkWorker', value: 20 },
  { stack: 'main;http.ListenAndServe;net/http.(*Server).Serve;net/http.(*conn).serve;net/http.(*ServeMux).ServeHTTP', value: 45 },
  { stack: 'main;http.ListenAndServe;net/http.(*Server).Serve;net/http.(*conn).serve;net/http.(*ServeMux).ServeHTTP;handler.AuthMiddleware', value: 25 },
  { stack: 'main;http.ListenAndServe;net/http.(*Server).Serve;net/http.(*conn).serve;net/http.(*ServeMux).ServeHTTP;handler.HandleRequest', value: 20 },
  { stack: 'main;database.Query;database/sql.(*DB).QueryContext', value: 60 },
  { stack: 'main;database.Query;database/sql.(*DB).QueryContext;database/sql.(*driverConn).query', value: 50 },
  { stack: 'main;database.Query;database/sql.(*DB).QueryContext;database/sql.(*driverConn).query;clickhouse.(*rows).Next', value: 30 },
  { stack: 'main;database.Query;database/sql.(*DB).QueryContext;database/sql.(*driverConn).query;clickhouse.(*rows).Next;encoding/binary.Read', value: 12 },
  { stack: 'main;cache.Get;github.com/go-redis/redis.(*Client).Get', value: 40 },
  { stack: 'main;cache.Get;github.com/go-redis/redis.(*Client).Get;net.(*Conn).Read', value: 22 },
  { stack: 'main;cache.Get;github.com/go-redis/redis.(*Client).Get;bufio.(*Reader).ReadLine', value: 18 },
  { stack: 'main;metrics.Record;prometheus.(*CounterVec).WithLabelValues', value: 15 },
  { stack: 'main;metrics.Record;prometheus.(*CounterVec).WithLabelValues;sync.(*RWMutex).Lock', value: 8 },
  { stack: 'main;runtime.goexit', value: 5 },
];

// ─── Constants ────────────────────────────────────────────────────────────────

const PROFILE_TYPES = ['all', 'cpu', 'heap', 'goroutine'] as const;
type ProfileTypeFilter = typeof PROFILE_TYPES[number];

const TIME_RANGE_OPTIONS = [
  { label: '15m', ms: 15 * 60 * 1000 },
  { label: '1h',  ms: 60 * 60 * 1000 },
  { label: '6h',  ms: 6 * 60 * 60 * 1000 },
] as const;

function formatBytes(b: number): string {
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(1)} MB`;
  if (b >= 1_000)     return `${(b / 1_000).toFixed(1)} KB`;
  return `${b} B`;
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function typeColor(t: string): string {
  switch (t) {
    case 'cpu':       return '#FF7B72';
    case 'heap':      return '#79C0FF';
    case 'goroutine': return '#56D364';
    default:          return '#8B949E';
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProfilingView() {
  const [services, setServices]             = useState<string[]>([]);
  const [selectedService, setSelectedService] = useState<string>('all');
  const [profileType, setProfileType]       = useState<ProfileTypeFilter>('cpu');
  const [timeRange, setTimeRange]           = useState<number>(15 * 60 * 1000);

  const [profiles, setProfiles]             = useState<ProfileInfo[]>([]);
  const [loadingList, setLoadingList]       = useState(false);

  const [selectedId, setSelectedId]         = useState<string | null>(null);
  const [foldedData, setFoldedData]         = useState<FoldedFrame[] | null>(null);
  const [loadingFlame, setLoadingFlame]     = useState(false);
  const [flameError, setFlameError]         = useState<string | null>(null);

  const [useMock, setUseMock]               = useState(false);

  // ─── 서비스 목록 로드 ──────────────────────────────────────────────────────
  useEffect(() => {
    fetchServices()
      .then((svcs) => {
        const names = ['all', ...svcs.map((s) => s.name)];
        setServices(names);
      })
      .catch(() => {
        setServices(['all', 'api-gateway', 'order-service', 'user-service']);
      });
  }, []);

  // ─── 프로파일 목록 로드 ────────────────────────────────────────────────────
  const loadProfiles = useCallback(async () => {
    setLoadingList(true);
    setSelectedId(null);
    setFoldedData(null);

    const end   = Date.now();
    const start = end - timeRange;

    try {
      const res = await fetchProfiles({
        service: selectedService === 'all' ? undefined : selectedService,
        start,
        end,
        type:    profileType === 'all' ? undefined : profileType,
      });
      setProfiles(res.profiles);
      setUseMock(false);
    } catch {
      // API 없으면 mock fallback
      const filtered = MOCK_PROFILES.filter((p) => {
        if (selectedService !== 'all' && p.service !== selectedService) return false;
        if (profileType !== 'all' && p.type !== profileType) return false;
        return true;
      });
      setProfiles(filtered);
      setUseMock(true);
    } finally {
      setLoadingList(false);
    }
  }, [selectedService, profileType, timeRange]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  // ─── 프로파일 선택 → 플레임그래프 로드 ─────────────────────────────────────
  const selectProfile = useCallback(async (id: string) => {
    setSelectedId(id);
    setFoldedData(null);
    setFlameError(null);
    setLoadingFlame(true);

    try {
      const res = await fetchFlamegraph(id);
      setFoldedData(res.folded ?? []);
      setUseMock(false);
    } catch {
      // API 없으면 mock
      setFoldedData(MOCK_FOLDED);
      setUseMock(true);
    } finally {
      setLoadingFlame(false);
    }
  }, []);

  const selectedProfile = profiles.find((p) => p.id === selectedId) ?? null;

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      {/* ── 상단 툴바 ── */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarGroup}>
          <label style={styles.label}>서비스</label>
          <select
            style={styles.select}
            value={selectedService}
            onChange={(e) => setSelectedService(e.target.value)}
          >
            {services.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div style={styles.toolbarGroup}>
          <label style={styles.label}>타입</label>
          <div style={styles.segmented}>
            {PROFILE_TYPES.map((t) => (
              <button
                key={t}
                style={{
                  ...styles.segBtn,
                  background:  profileType === t ? 'rgba(88,166,255,0.15)' : 'transparent',
                  color:       profileType === t ? '#58A6FF' : '#8B949E',
                  borderColor: profileType === t ? 'rgba(88,166,255,0.4)' : '#30363D',
                }}
                onClick={() => setProfileType(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div style={styles.toolbarGroup}>
          <label style={styles.label}>범위</label>
          <div style={styles.segmented}>
            {TIME_RANGE_OPTIONS.map((tr) => (
              <button
                key={tr.ms}
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

        <button style={styles.refreshBtn} onClick={loadProfiles}>
          새로고침
        </button>

        {useMock && (
          <span style={styles.mockChip}>MOCK</span>
        )}
      </div>

      {/* ── 본문: 좌측 목록 + 우측 플레임그래프 ── */}
      <div style={styles.body}>
        {/* 좌측 프로파일 목록 */}
        <div style={styles.sidebar}>
          <div style={styles.sidebarHeader}>
            프로파일 목록
            {loadingList && <span style={styles.loadingDot} />}
          </div>

          {loadingList ? (
            <div style={styles.listLoading}>
              <Spinner />
            </div>
          ) : profiles.length === 0 ? (
            <div style={styles.listEmpty}>프로파일 없음</div>
          ) : (
            <div style={styles.listScroll}>
              {profiles.map((p) => (
                <ProfileListItem
                  key={p.id}
                  profile={p}
                  selected={p.id === selectedId}
                  onClick={() => selectProfile(p.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* 우측 플레임그래프 */}
        <div style={styles.main}>
          {!selectedId ? (
            <EmptyState message="좌측에서 프로파일을 선택하세요" />
          ) : loadingFlame ? (
            <div style={styles.loadingWrap}>
              <Spinner size={28} />
              <span style={styles.loadingText}>플레임그래프 로딩 중…</span>
            </div>
          ) : flameError ? (
            <EmptyState message={flameError} isError />
          ) : foldedData ? (
            <div style={styles.flameWrap}>
              {/* 선택된 프로파일 정보 */}
              {selectedProfile && (
                <div style={styles.flameHeader}>
                  <span style={styles.flameService}>{selectedProfile.service}</span>
                  <span
                    style={{
                      ...styles.flameType,
                      color: typeColor(selectedProfile.type),
                      borderColor: typeColor(selectedProfile.type) + '44',
                    }}
                  >
                    {selectedProfile.type}
                  </span>
                  <span style={styles.flameTime}>{formatTs(selectedProfile.timestamp)}</span>
                  <span style={styles.flameSize}>{formatBytes(selectedProfile.size_bytes)}</span>
                </div>
              )}
              <FlamegraphRenderer
                folded={foldedData}
                height={480}
              />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── ProfileListItem ──────────────────────────────────────────────────────────

function ProfileListItem({
  profile,
  selected,
  onClick,
}: {
  profile: ProfileInfo;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      style={{
        ...styles.listItem,
        background:  selected ? '#21262D' : 'transparent',
        borderLeft:  selected ? '2px solid #58A6FF' : '2px solid transparent',
      }}
      onClick={onClick}
    >
      <div style={styles.listItemTop}>
        <span
          style={{
            ...styles.listItemType,
            color:       typeColor(profile.type),
            borderColor: typeColor(profile.type) + '44',
          }}
        >
          {profile.type}
        </span>
        <span style={styles.listItemSize}>{formatBytes(profile.size_bytes)}</span>
      </div>
      <div style={styles.listItemTs}>{formatTs(profile.timestamp)}</div>
      <div style={styles.listItemService}>{profile.service}</div>
    </button>
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

function EmptyState({ message, isError = false }: { message: string; isError?: boolean }) {
  return (
    <div style={styles.emptyState}>
      <div style={{ ...styles.emptyIcon, color: isError ? '#F85149' : 'rgba(139,148,158,0.3)' }}>
        {isError ? '!' : '○'}
      </div>
      <div style={{ ...styles.emptyText, color: isError ? '#F85149' : 'rgba(139,148,158,0.5)' }}>
        {message}
      </div>
    </div>
  );
}

// ─── Spinner ──────────────────────────────────────────────────────────────────

function Spinner({ size = 20 }: { size?: number }) {
  return (
    <div
      style={{
        width:       size,
        height:      size,
        border:      `2px solid rgba(88,166,255,0.2)`,
        borderTop:   `2px solid #58A6FF`,
        borderRadius:'50%',
        animation:   'spin 0.7s linear infinite',
        flexShrink:  0,
      }}
    />
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

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
    gap:          16,
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
    display:      'flex',
    borderRadius: 4,
    overflow:     'hidden',
    border:       '1px solid #30363D',
  },
  segBtn: {
    padding:      '3px 10px',
    border:       'none',
    borderRight:  '1px solid',
    cursor:       'pointer',
    fontSize:     11,
    fontWeight:   500,
    fontFamily:   'system-ui, sans-serif',
    transition:   'all 0.1s ease',
    whiteSpace:   'nowrap' as const,
  } as CSSProperties,
  refreshBtn: {
    padding:      '4px 12px',
    background:   'rgba(88,166,255,0.1)',
    border:       '1px solid rgba(88,166,255,0.3)',
    borderRadius: 4,
    color:        '#58A6FF',
    fontSize:     12,
    fontWeight:   500,
    cursor:       'pointer',
    fontFamily:   'system-ui, sans-serif',
    marginLeft:   'auto',
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
  body: {
    flex:       1,
    display:    'flex',
    minHeight:  0,
    overflow:   'hidden',
  },
  sidebar: {
    width:        240,
    flexShrink:   0,
    display:      'flex',
    flexDirection:'column' as const,
    borderRight:  '1px solid #30363D',
    background:   '#0D1117',
    overflow:     'hidden',
  },
  sidebarHeader: {
    display:      'flex',
    alignItems:   'center',
    gap:          6,
    padding:      '8px 12px',
    fontSize:     11,
    fontWeight:   600,
    color:        '#8B949E',
    letterSpacing:'0.04em',
    textTransform:'uppercase' as const,
    borderBottom: '1px solid #21262D',
    flexShrink:   0,
  },
  loadingDot: {
    width:        6,
    height:       6,
    borderRadius: '50%',
    background:   '#58A6FF',
    animation:    'pulse 1s ease infinite',
  } as CSSProperties,
  listLoading: {
    flex:           1,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
  },
  listEmpty: {
    flex:           1,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    fontSize:       12,
    color:          'rgba(139,148,158,0.4)',
  },
  listScroll: {
    flex:       1,
    overflowY:  'auto' as const,
  },
  listItem: {
    display:        'flex',
    flexDirection:  'column' as const,
    gap:            2,
    width:          '100%',
    padding:        '8px 12px',
    background:     'transparent',
    border:         'none',
    borderBottom:   '1px solid #21262D',
    cursor:         'pointer',
    textAlign:      'left' as const,
    transition:     'background 0.1s ease',
  } as CSSProperties,
  listItemTop: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
  },
  listItemType: {
    fontSize:     10,
    fontWeight:   700,
    border:       '1px solid',
    borderRadius: 3,
    padding:      '1px 5px',
    fontFamily:   'ui-monospace, monospace',
  } as CSSProperties,
  listItemSize: {
    fontSize:   10,
    color:      '#8B949E',
    fontFamily: 'ui-monospace, monospace',
  },
  listItemTs: {
    fontSize:   11,
    color:      '#C9D1D9',
    fontFamily: 'ui-monospace, monospace',
    fontWeight: 500,
  },
  listItemService: {
    fontSize:   10,
    color:      'rgba(139,148,158,0.6)',
    fontFamily: 'system-ui, sans-serif',
    overflow:   'hidden',
    textOverflow:'ellipsis' as const,
    whiteSpace: 'nowrap' as const,
  } as CSSProperties,
  main: {
    flex:        1,
    display:     'flex',
    flexDirection:'column' as const,
    overflow:    'hidden',
    padding:     12,
    minWidth:    0,
  },
  loadingWrap: {
    flex:           1,
    display:        'flex',
    flexDirection:  'column' as const,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            12,
  },
  loadingText: {
    fontSize:   12,
    color:      'rgba(139,148,158,0.6)',
    fontFamily: 'system-ui, sans-serif',
  },
  flameWrap: {
    flex:           1,
    display:        'flex',
    flexDirection:  'column' as const,
    gap:            8,
    overflow:       'hidden',
  },
  flameHeader: {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
    flexShrink: 0,
  },
  flameService: {
    fontSize:   12,
    fontWeight: 600,
    color:      '#C9D1D9',
    fontFamily: 'system-ui, sans-serif',
  },
  flameType: {
    fontSize:     10,
    fontWeight:   700,
    border:       '1px solid',
    borderRadius: 3,
    padding:      '1px 5px',
    fontFamily:   'ui-monospace, monospace',
  } as CSSProperties,
  flameTime: {
    fontSize:   11,
    color:      '#8B949E',
    fontFamily: 'ui-monospace, monospace',
  },
  flameSize: {
    fontSize:     10,
    color:        '#8B949E',
    fontFamily:   'ui-monospace, monospace',
    marginLeft:   'auto',
  } as CSSProperties,
  emptyState: {
    flex:           1,
    display:        'flex',
    flexDirection:  'column' as const,
    alignItems:     'center',
    justifyContent: 'center',
    gap:            10,
  },
  emptyIcon: {
    fontSize:   40,
    lineHeight: 1,
  },
  emptyText: {
    fontSize:   13,
    fontFamily: 'system-ui, sans-serif',
  },
} as const;
