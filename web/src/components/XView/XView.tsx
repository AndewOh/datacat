/**
 * XView.tsx — WebGL2 scatter plot 컴포넌트
 *
 * Phase 1:
 *  - useXView 훅으로 실시간 데이터 수신
 *  - loading 중: "Loading..." 오버레이
 *  - error 시: 노란색 경고 배너 (mock 데이터로 표시 중)
 *  - 드래그 선택 → onPointsSelected(XViewPoint[]) 콜백
 *  - 하단: "N 트랜잭션 선택됨"
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { XViewRenderer } from './XViewRenderer';
import { XViewInteraction } from './XViewInteraction';
import type { XViewPoint, Viewport, SelectionRect } from './types';

interface XViewProps {
  /** 외부에서 주입된 포인트 배열 (Dashboard에서 useXView 결과를 넘김) */
  points: XViewPoint[];
  loading?: boolean;
  error?: string | null;
  usingMock?: boolean;
  onPointsSelected?: (points: XViewPoint[]) => void;
  /** 하위 호환: spanId string[] 콜백 (Dashboard 기존 코드) */
  onSelectionChange?: (spanIds: string[]) => void;
}

export function XView({
  points,
  loading = false,
  error = null,
  usingMock = false,
  onPointsSelected,
  onSelectionChange,
}: XViewProps) {
  const canvasRef       = useRef<HTMLCanvasElement>(null);
  const rendererRef     = useRef<XViewRenderer | null>(null);
  const interactionRef  = useRef<XViewInteraction | null>(null);
  const rafRef          = useRef<number>(0);
  const viewportRef     = useRef<Viewport>({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 });
  // Keep a stable ref to points so selection callback can access current data
  const pointsRef       = useRef<XViewPoint[]>(points);

  const [selectionRect,  setSelectionRect]  = useState<SelectionRect | null>(null);
  const [selectedCount,  setSelectedCount]  = useState<number>(0);
  const [fps,            setFps]            = useState<number>(0);
  const [webglError,     setWebglError]     = useState<string | null>(null);
  const [isReady,        setIsReady]        = useState(false);

  // Sync pointsRef whenever points prop changes
  useEffect(() => { pointsRef.current = points; }, [points]);

  // Initialize renderer once on mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let renderer: XViewRenderer;
    try {
      renderer = new XViewRenderer(canvas);
      rendererRef.current = renderer;
    } catch (err) {
      setWebglError(err instanceof Error ? err.message : 'WebGL2 initialization failed');
      return;
    }

    const interaction = new XViewInteraction(canvas, {
      onViewportChange: (vp) => { viewportRef.current = vp; },
      onSelectionStart: () => {
        setSelectionRect(null);
        setSelectedCount(0);
      },
      onSelectionChange: (rect) => { setSelectionRect(rect); },
      onSelectionEnd: (rect) => {
        setSelectionRect(rect);
        const ids = renderer.selectInRect(
          rect.x, rect.y, rect.width, rect.height,
          viewportRef.current,
        );
        setSelectedCount(ids.length);
        onSelectionChange?.(ids);

        // XViewPoint 배열로 변환해서 콜백
        if (onPointsSelected) {
          const idSet = new Set(ids);
          const selected = pointsRef.current.filter((p) => idSet.has(p.spanId));
          onPointsSelected(selected);
        }
      },
    });
    interactionRef.current = interaction;

    let fpsCounter = 0;
    const loop = () => {
      renderer.render(viewportRef.current);
      fpsCounter++;
      if (fpsCounter % 30 === 0) setFps(renderer.getFps());
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    setIsReady(true);

    return () => {
      cancelAnimationFrame(rafRef.current);
      interaction.dispose();
      renderer.dispose();
      rendererRef.current = null;
      interactionRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount once

  // Update renderer data whenever points change
  useEffect(() => {
    if (!rendererRef.current) return;
    rendererRef.current.setData(points);
  }, [points]);

  // Escape key clears selection
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setSelectionRect(null);
      setSelectedCount(0);
      onSelectionChange?.([]);
      onPointsSelected?.([]);
    }
  }, [onSelectionChange, onPointsSelected]);

  // WebGL hard error
  if (webglError) {
    return (
      <div style={styles.errorContainer}>
        <div style={styles.errorBox}>
          <span style={styles.errorIcon}>!</span>
          <p style={styles.errorTitle}>WebGL2 not available</p>
          <p style={styles.errorMessage}>{webglError}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.wrapper} onKeyDown={handleKeyDown} tabIndex={0}>

      {/* API 실패 배너 (노란색) */}
      {error && (
        <div style={styles.warnBanner} role="alert" aria-live="polite">
          <span style={styles.warnIcon}>!</span>
          서버에 연결할 수 없습니다. Mock 데이터로 표시 중
        </div>
      )}

      {/* 로딩 오버레이 */}
      {loading && (
        <div style={styles.loadingOverlay} aria-label="Loading data" aria-live="polite">
          <div style={styles.loadingSpinner} />
          <span style={styles.loadingText}>Loading...</span>
        </div>
      )}

      {/* HUD */}
      <div style={styles.hud} aria-live="polite" aria-label="Performance stats">
        <span style={styles.hudItem}>{fps} fps</span>
        <span style={styles.hudDivider}>·</span>
        <span style={styles.hudItem}>{points.length.toLocaleString()} pts</span>
        {usingMock && (
          <>
            <span style={styles.hudDivider}>·</span>
            <span style={{ ...styles.hudItem, color: '#f0c060' }}>mock</span>
          </>
        )}
        {selectedCount > 0 && (
          <>
            <span style={styles.hudDivider}>·</span>
            <span style={{ ...styles.hudItem, color: '#58A6FF' }}>
              {selectedCount.toLocaleString()} selected
            </span>
          </>
        )}
      </div>

      {/* Interaction hint */}
      <div style={styles.hint}>
        drag to select · scroll to zoom · shift+drag to pan · dblclick to reset
      </div>

      {/* WebGL canvas */}
      <canvas
        ref={canvasRef}
        style={{
          ...styles.canvas,
          cursor: 'crosshair',
          opacity: isReady ? 1 : 0,
          transition: 'opacity 0.3s ease',
        }}
        aria-label="X-View scatter plot — transaction response times"
      />

      {/* Selection overlay */}
      {selectionRect && (
        <svg style={styles.selectionOverlay} aria-hidden="true">
          <rect
            x={selectionRect.x}
            y={selectionRect.y}
            width={selectionRect.width}
            height={selectionRect.height}
            fill="rgba(88,166,255,0.07)"
            stroke="rgba(88,166,255,0.65)"
            strokeWidth={1}
            strokeDasharray="4 2"
          />
        </svg>
      )}

      {/* Y-axis label */}
      <div style={styles.yAxisLabel} aria-hidden="true">Response Time</div>
      {/* X-axis label */}
      <div style={styles.xAxisLabel} aria-hidden="true">Time</div>

      {/* 하단 선택 카운터 */}
      {selectedCount > 0 && (
        <div style={styles.selectionBar} aria-live="polite">
          <span style={styles.selectionCount}>
            {selectedCount.toLocaleString()} 트랜잭션 선택됨
          </span>
          <span style={styles.selectionHint}>Esc로 해제</span>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const selectedBarHeight = 28;

const styles = {
  wrapper: {
    position: 'relative' as const,
    width: '100%',
    height: '100%',
    minHeight: 280,
    background: '#0D1117',
    borderRadius: 8,
    overflow: 'hidden',
    outline: 'none',
    border: '1px solid #30363D',
  },
  canvas: {
    display: 'block',
    width: '100%',
    height: '100%',
  },
  // API 실패 — 노란색 경고 배너
  warnBanner: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'rgba(210,153,34,0.18)',
    borderBottom: '1px solid rgba(210,153,34,0.4)',
    color: '#f0c060',
    fontSize: 12,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    padding: '6px 12px',
  },
  warnIcon: {
    fontSize: 14,
    fontWeight: 700,
    color: '#f0c060',
  },
  // 로딩 오버레이
  loadingOverlay: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 15,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    background: 'rgba(13,17,23,0.7)',
    backdropFilter: 'blur(2px)',
  },
  loadingSpinner: {
    width: 28,
    height: 28,
    border: '3px solid rgba(88,166,255,0.2)',
    borderTopColor: '#58A6FF',
    borderRadius: '50%',
    animation: 'spin 0.75s linear infinite',
  },
  loadingText: {
    fontSize: 13,
    color: 'rgba(201,209,217,0.6)',
    fontFamily: 'ui-monospace, monospace',
    letterSpacing: '0.04em',
  },
  selectionOverlay: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none' as const,
  },
  hud: {
    position: 'absolute' as const,
    top: 10,
    right: 12,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    zIndex: 10,
    fontFamily: 'ui-monospace, "Cascadia Code", monospace',
    fontSize: 11,
    color: 'rgba(201,209,217,0.4)',
    pointerEvents: 'none' as const,
  },
  hudItem: { letterSpacing: '0.02em' },
  hudDivider: { color: 'rgba(201,209,217,0.18)' },
  hint: {
    position: 'absolute' as const,
    bottom: selectedBarHeight + 4,
    right: 12,
    fontSize: 10,
    color: 'rgba(201,209,217,0.2)',
    fontFamily: 'system-ui, sans-serif',
    pointerEvents: 'none' as const,
    letterSpacing: '0.01em',
  },
  yAxisLabel: {
    position: 'absolute' as const,
    left: 0,
    top: '50%',
    transform: 'translateX(-50%) translateY(-50%) rotate(-90deg)',
    transformOrigin: 'center center',
    fontSize: 10,
    color: 'rgba(201,209,217,0.18)',
    fontFamily: 'system-ui, sans-serif',
    whiteSpace: 'nowrap' as const,
    pointerEvents: 'none' as const,
    marginLeft: 18,
  },
  xAxisLabel: {
    position: 'absolute' as const,
    bottom: selectedBarHeight + 4,
    left: '50%',
    transform: 'translateX(-50%)',
    fontSize: 10,
    color: 'rgba(201,209,217,0.18)',
    fontFamily: 'system-ui, sans-serif',
    pointerEvents: 'none' as const,
  },
  selectionBar: {
    position: 'absolute' as const,
    bottom: 0,
    left: 0,
    right: 0,
    height: selectedBarHeight,
    background: 'rgba(88,166,255,0.08)',
    borderTop: '1px solid rgba(88,166,255,0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px',
    zIndex: 10,
    pointerEvents: 'none' as const,
  },
  selectionCount: {
    fontSize: 12,
    fontWeight: 600,
    color: '#58A6FF',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  selectionHint: {
    fontSize: 10,
    color: 'rgba(88,166,255,0.5)',
    fontFamily: 'ui-monospace, monospace',
  },
  errorContainer: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100%',
    minHeight: 280,
    background: '#0D1117',
    borderRadius: 8,
    border: '1px solid rgba(248,81,73,0.3)',
  },
  errorBox: {
    textAlign: 'center' as const,
    padding: '32px 40px',
  },
  errorIcon: {
    display: 'inline-block',
    width: 36,
    height: 36,
    lineHeight: '36px',
    borderRadius: '50%',
    background: 'rgba(248,81,73,0.12)',
    color: '#F85149',
    fontSize: 20,
    fontWeight: 700,
    marginBottom: 12,
  },
  errorTitle: {
    color: '#F85149',
    fontSize: 16,
    fontWeight: 600,
    marginBottom: 8,
  },
  errorMessage: {
    color: 'rgba(201,209,217,0.5)',
    fontSize: 13,
    lineHeight: 1.6,
    maxWidth: 420,
  },
} as const;
