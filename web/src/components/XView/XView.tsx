/**
 * XView.tsx — WebGL2 scatter plot 컴포넌트
 *
 * Phase 1:
 *  - useXView 훅으로 실시간 데이터 수신
 *  - loading 중: "Loading..." 오버레이
 *  - error 시: 노란색 경고 배너 (mock 데이터로 표시 중)
 *  - 드래그 선택 → onPointsSelected(XViewPoint[]) 콜백
 *  - 하단: "N 트랜잭션 선택됨"
 *
 * Fixes applied:
 *  - Bug 1: Selection stored in data-norm [0,1] coords → survives pan/zoom/refresh.
 *           Committed selection is painted on the axis canvas inside the RAF loop,
 *           so it tracks viewport movement at 60fps without any React re-renders.
 *  - Bug 2: 2D canvas axis overlay with log-scale Y ticks + time X ticks.
 *  - Bug 3: Y axis uses log1p scale in renderer → even distribution across decades.
 *  - Bug 4: On data refresh, re-run selectInDataRect to update count/callbacks.
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { XViewRenderer } from './XViewRenderer';
import { XViewInteraction } from './XViewInteraction';
import type { XViewPoint, Viewport, SelectionRect } from './types';

// ─── Layout constants ─────────────────────────────────────────────────────────

/** Left margin reserved for Y-axis ticks (CSS px) */
const AXIS_LEFT   = 52;
/** Bottom margin reserved for X-axis ticks (CSS px) */
const AXIS_BOTTOM = 28;

// ─── Axis rendering ───────────────────────────────────────────────────────────

/**
 * Y-axis tick values in raw ms — log-decade boundaries plus mid-points.
 * drawAxes will filter to whichever fall within dataYMin..dataYMax.
 */
const Y_TICK_VALUES_MS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  1_000, 2_000, 5_000, 10_000, 20_000, 30_000,
];

function formatMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms >= 1_000)  return `${(ms / 1000).toFixed(1)}s`;
  return `${ms.toFixed(0)}ms`;
}

function formatTime(epochMs: number): string {
  const d  = new Date(epochMs);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Pick a reasonable X-axis tick interval given the visible time range (ms) */
function xTickIntervalMs(rangeMs: number): number {
  if (rangeMs <= 2  * 60_000)   return 15_000;       // ≤2 min  → 15s
  if (rangeMs <= 10 * 60_000)   return 60_000;        // ≤10 min → 1 min
  if (rangeMs <= 30 * 60_000)   return 5 * 60_000;    // ≤30 min → 5 min
  if (rangeMs <= 2  * 3600_000) return 15 * 60_000;   // ≤2 h    → 15 min
  return 60 * 60_000;                                  // >2 h    → 1 h
}

interface DrawFrameOptions {
  ctx: CanvasRenderingContext2D;
  canvasW: number;   // physical pixels
  canvasH: number;
  dpr: number;
  viewport: Viewport;
  dataXMin: number;  // epoch ms
  dataXMax: number;
  dataYMin: number;  // raw ms (used for log mapping)
  dataYMax: number;
  /** Committed selection in raw data units — null = no selection */
  dataNormSel: { left: number; right: number; bottom: number; top: number } | null;
}

/**
 * Paint axes, grid lines, tick labels, and the committed selection rectangle
 * onto the 2D overlay canvas.  Called every RAF frame so everything tracks
 * pan/zoom without touching React state.
 */
function drawFrame({
  ctx,
  canvasW,
  canvasH,
  dpr,
  viewport,
  dataXMin,
  dataXMax,
  dataYMin,
  dataYMax,
  dataNormSel,
}: DrawFrameOptions): void {
  ctx.clearRect(0, 0, canvasW, canvasH);

  // Physical-pixel margins
  const LEFT   = AXIS_LEFT   * dpr;
  const BOTTOM = AXIS_BOTTOM * dpr;
  const plotW  = canvasW - LEFT;
  const plotH  = canvasH - BOTTOM;

  if (plotW <= 0 || plotH <= 0) return;

  // ─ Plot border lines ────────────────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(201,209,217,0.08)';
  ctx.lineWidth   = 1 * dpr;
  ctx.beginPath();
  ctx.moveTo(LEFT, 0);
  ctx.lineTo(LEFT, plotH);
  ctx.lineTo(canvasW, plotH);
  ctx.stroke();

  // ─ Y-axis ticks (log scale) ─────────────────────────────────────────────────
  const logYMin   = Math.log1p(dataYMin);
  const logYMax   = Math.log1p(dataYMax);
  const logYRange = logYMax - logYMin;
  const vpYRange  = viewport.yMax - viewport.yMin;

  ctx.font      = `${Math.round(10 * dpr)}px ui-monospace, "Cascadia Code", monospace`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(201,209,217,0.45)';

  for (const tickMs of Y_TICK_VALUES_MS) {
    if (tickMs < dataYMin || tickMs > dataYMax) continue;

    // Normalize tick in the same log space the renderer uses
    const normY = logYRange > 0
      ? (Math.log1p(tickMs) - logYMin) / logYRange
      : 0.5;

    // Map data-norm → viewport fraction → canvas Y (Y flipped)
    const vpFrac  = (normY - viewport.yMin) / vpYRange;
    if (vpFrac < 0 || vpFrac > 1) continue;
    const canvasY = (1.0 - vpFrac) * plotH;

    // Tick line
    ctx.strokeStyle = 'rgba(201,209,217,0.15)';
    ctx.lineWidth   = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(LEFT - 5 * dpr, canvasY);
    ctx.lineTo(LEFT, canvasY);
    ctx.stroke();

    // Grid line (faint, spans full plot width)
    ctx.strokeStyle = 'rgba(201,209,217,0.04)';
    ctx.beginPath();
    ctx.moveTo(LEFT, canvasY);
    ctx.lineTo(canvasW, canvasY);
    ctx.stroke();

    // Label
    ctx.fillText(formatMs(tickMs), LEFT - 7 * dpr, canvasY);
  }

  // ─ X-axis ticks (time) ──────────────────────────────────────────────────────
  const xRange    = dataXMax - dataXMin;
  const visXMin   = dataXMin + viewport.xMin * xRange;
  const visXMax   = dataXMin + viewport.xMax * xRange;
  const visXRange = visXMax - visXMin;

  const intervalMs = xTickIntervalMs(visXRange);
  const firstTick  = Math.ceil(visXMin / intervalMs) * intervalMs;

  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle    = 'rgba(201,209,217,0.45)';

  for (let t = firstTick; t <= visXMax; t += intervalMs) {
    const normX  = (t - dataXMin) / xRange;
    const vpFrac = (normX - viewport.xMin) / (viewport.xMax - viewport.xMin);
    if (vpFrac < 0 || vpFrac > 1) continue;
    const canvasX = LEFT + vpFrac * plotW;

    // Tick line
    ctx.strokeStyle = 'rgba(201,209,217,0.15)';
    ctx.lineWidth   = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(canvasX, plotH);
    ctx.lineTo(canvasX, plotH + 5 * dpr);
    ctx.stroke();

    // Grid line
    ctx.strokeStyle = 'rgba(201,209,217,0.04)';
    ctx.beginPath();
    ctx.moveTo(canvasX, 0);
    ctx.lineTo(canvasX, plotH);
    ctx.stroke();

    // Label
    ctx.fillStyle = 'rgba(201,209,217,0.45)';
    ctx.fillText(formatTime(t), canvasX, plotH + 6 * dpr);
  }

  // ─ Axis labels ──────────────────────────────────────────────────────────────
  ctx.fillStyle    = 'rgba(201,209,217,0.22)';
  ctx.font         = `${Math.round(10 * dpr)}px system-ui, sans-serif`;

  // Y label (rotated)
  ctx.save();
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.translate(11 * dpr, plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Response Time', 0, 0);
  ctx.restore();

  // X label
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('Time', LEFT + plotW / 2, canvasH - 1 * dpr);

  // ─ Committed selection rect (Bug 1 fix — drawn here so it tracks pan/zoom) ──
  if (dataNormSel) {
    // Raw → data-norm
    const xDataRange = dataXMax - dataXMin;
    const logYMin2   = Math.log1p(dataYMin);
    const logYMax2   = Math.log1p(dataYMax);
    const logYRange2 = logYMax2 - logYMin2;

    const dnLeft   = xDataRange > 0 ? (dataNormSel.left   - dataXMin) / xDataRange : 0;
    const dnRight  = xDataRange > 0 ? (dataNormSel.right  - dataXMin) / xDataRange : 1;
    const dnBottom = logYRange2 > 0 ? (Math.log1p(dataNormSel.bottom) - logYMin2) / logYRange2 : 0;
    const dnTop    = logYRange2 > 0 ? (Math.log1p(dataNormSel.top)    - logYMin2) / logYRange2 : 1;

    // Data-norm → viewport fraction
    const rLeft   = (dnLeft   - viewport.xMin) / (viewport.xMax - viewport.xMin);
    const rRight  = (dnRight  - viewport.xMin) / (viewport.xMax - viewport.xMin);
    const rTopF   = 1.0 - (dnTop    - viewport.yMin) / vpYRange;
    const rBottomF= 1.0 - (dnBottom - viewport.yMin) / vpYRange;

    const sx  = LEFT + Math.min(rLeft, rRight)     * plotW;
    const sy  = Math.min(rTopF,  rBottomF) * plotH;
    const sw  = Math.abs(rRight  - rLeft)   * plotW;
    const sh  = Math.abs(rBottomF - rTopF)  * plotH;

    // Only draw if at least partially inside the plot area
    if (sw > 0 && sh > 0) {
      ctx.save();
      ctx.fillStyle   = 'rgba(88,166,255,0.07)';
      ctx.fillRect(sx, sy, sw, sh);
      ctx.strokeStyle = 'rgba(88,166,255,0.65)';
      ctx.lineWidth   = 1 * dpr;
      ctx.setLineDash([4 * dpr, 2 * dpr]);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

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
  const axisCanvasRef   = useRef<HTMLCanvasElement>(null);
  const rendererRef     = useRef<XViewRenderer | null>(null);
  const interactionRef  = useRef<XViewInteraction | null>(null);
  const rafRef          = useRef<number>(0);
  const viewportRef     = useRef<Viewport>({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 });

  // Keep stable refs to points and callbacks — accessible inside RAF closure
  const pointsRef             = useRef<XViewPoint[]>(points);
  const onSelectionChangeRef  = useRef(onSelectionChange);
  const onPointsSelectedRef   = useRef(onPointsSelected);
  useEffect(() => { pointsRef.current = points; }, [points]);
  useEffect(() => { onSelectionChangeRef.current = onSelectionChange; }, [onSelectionChange]);
  useEffect(() => { onPointsSelectedRef.current  = onPointsSelected;  }, [onPointsSelected]);

  // Bug 1: Selection stored as data-normalized [0,1] rect — stable across pan/zoom/refresh.
  // A ref is used so the RAF loop can read it without causing re-renders.
  const dataNormSelRef = useRef<{
    left: number; right: number; bottom: number; top: number;
  } | null>(null);

  // React state only needed for UI that lives outside the canvas (HUD counter, selection bar)
  const [selectedCount, setSelectedCount] = useState<number>(0);
  const [fps,           setFps]           = useState<number>(0);
  const [webglError,    setWebglError]    = useState<string | null>(null);
  const [isReady,       setIsReady]       = useState(false);

  // Live drag rect (pixel-space, transient while dragging) — rendered via SVG overlay
  const [dragRect, setDragRect] = useState<SelectionRect | null>(null);

  // ─── Initialize renderer once on mount ──────────────────────────────────────
  useEffect(() => {
    const canvas     = canvasRef.current;
    const axisCanvas = axisCanvasRef.current;
    if (!canvas || !axisCanvas) return;

    let renderer: XViewRenderer;
    try {
      renderer = new XViewRenderer(canvas);
      rendererRef.current = renderer;
    } catch (err) {
      setWebglError(err instanceof Error ? err.message : 'WebGL2 initialization failed');
      return;
    }

    const interaction = new XViewInteraction(canvas, {
      onViewportChange: (vp) => {
        viewportRef.current = vp;
        // No state update needed — RAF loop reads viewportRef directly
      },
      onSelectionStart: () => {
        setDragRect(null);
        dataNormSelRef.current = null;
        setSelectedCount(0);
      },
      onSelectionChange: (rect) => {
        // Show live drag rect via SVG (pixel-perfect, no conversion needed while dragging)
        setDragRect(rect);
      },
      onSelectionEnd: (rect) => {
        setDragRect(null);

        // Bug 1: Convert final pixel rect to data-norm and store in ref.
        // The RAF loop picks up dataNormSelRef every frame → no stale coords.
        const dn = renderer.pixelRectToRawData(
          rect.x, rect.y, rect.width, rect.height,
          viewportRef.current,
        );
        dataNormSelRef.current = dn;

        // Run selection against CPU data
        const ids = renderer.selectInRawDataRect(dn.left, dn.right, dn.bottom, dn.top);
        setSelectedCount(ids.length);
        onSelectionChangeRef.current?.(ids);

        if (onPointsSelectedRef.current) {
          const idSet = new Set(ids);
          onPointsSelectedRef.current(pointsRef.current.filter((p) => idSet.has(p.spanId)));
        }
      },
    });
    interactionRef.current = interaction;

    const axisCtx = axisCanvas.getContext('2d');

    let fpsCounter = 0;
    const loop = () => {
      const vp = viewportRef.current;
      renderer.render(vp);

      // Draw axes + committed selection rect every frame (tracks pan/zoom automatically)
      if (axisCtx) {
        const dpr   = window.devicePixelRatio || 1;
        const physW = Math.floor(axisCanvas.clientWidth  * dpr);
        const physH = Math.floor(axisCanvas.clientHeight * dpr);
        if (axisCanvas.width !== physW || axisCanvas.height !== physH) {
          axisCanvas.width  = physW;
          axisCanvas.height = physH;
        }
        const extents = renderer.getDataExtents();
        drawFrame({
          ctx: axisCtx,
          canvasW: physW,
          canvasH: physH,
          dpr,
          viewport: vp,
          dataXMin: extents.xMin,
          dataXMax: extents.xMax,
          dataYMin: extents.yMin,
          dataYMax: extents.yMax,
          dataNormSel: dataNormSelRef.current,
        });
      }

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
      rendererRef.current  = null;
      interactionRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // mount once

  // ─── Bug 4: Re-run selection when data refreshes ────────────────────────────
  // Guard: only fire callbacks when the set of selected IDs actually changes.
  const prevSelectedIdsRef = useRef<string>('');
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    renderer.setData(points);

    const dn = dataNormSelRef.current;
    if (dn) {
      const ids    = renderer.selectInRawDataRect(dn.left, dn.right, dn.bottom, dn.top);
      const idsKey = ids.join(',');
      if (idsKey !== prevSelectedIdsRef.current) {
        prevSelectedIdsRef.current = idsKey;
        setSelectedCount(ids.length);
        onSelectionChangeRef.current?.(ids);
        if (onPointsSelectedRef.current) {
          const idSet = new Set(ids);
          onPointsSelectedRef.current(points.filter((p) => idSet.has(p.spanId)));
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]); // dataNormSelRef is a ref — intentionally excluded

  // ─── Escape key clears selection ────────────────────────────────────────────
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      dataNormSelRef.current = null;
      setDragRect(null);
      setSelectedCount(0);
      prevSelectedIdsRef.current = '';
      onSelectionChangeRef.current?.([]);
      onPointsSelectedRef.current?.([]);
    }
  }, []);

  // ─── WebGL hard error ───────────────────────────────────────────────────────
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

      {/* Axis canvas: covers entire wrapper — draws margins, ticks, and committed selection.
          z-index 5 so it renders above WebGL canvas but below HUD and drag SVG. */}
      <canvas
        ref={axisCanvasRef}
        style={styles.axisCanvas}
        aria-hidden="true"
      />

      {/* WebGL canvas: inset by axis margins so axes stay clear */}
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

      {/* SVG overlay: only for live drag rect (ephemeral, always current CSS pixels).
          Committed selection is painted on the axis canvas instead. */}
      {dragRect && (
        <svg style={styles.selectionOverlay} aria-hidden="true">
          <rect
            x={dragRect.x}
            y={dragRect.y}
            width={dragRect.width}
            height={dragRect.height}
            fill="rgba(88,166,255,0.07)"
            stroke="rgba(88,166,255,0.65)"
            strokeWidth={1}
            strokeDasharray="4 2"
          />
        </svg>
      )}

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
  // Axis canvas covers the full wrapper.
  // drawFrame paints margins (AXIS_LEFT × AXIS_BOTTOM) internally.
  // z-index 5: above WebGL canvas, below HUD/SVG.
  axisCanvas: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none' as const,
    zIndex: 5,
  },
  // WebGL canvas: inset so it doesn't paint under the axis labels.
  // Interaction events are still canvas-relative (getBoundingClientRect handles the offset).
  canvas: {
    display: 'block',
    position: 'absolute' as const,
    top: 0,
    left: AXIS_LEFT,
    width: `calc(100% - ${AXIS_LEFT}px)`,
    height: `calc(100% - ${AXIS_BOTTOM}px)`,
  },
  // SVG sits over the WebGL canvas in the same inset region.
  // Used only for the live drag rect (committed selection lives on axis canvas).
  selectionOverlay: {
    position: 'absolute' as const,
    top: 0,
    left: AXIS_LEFT,
    width: `calc(100% - ${AXIS_LEFT}px)`,
    height: `calc(100% - ${AXIS_BOTTOM}px)`,
    pointerEvents: 'none' as const,
    zIndex: 8,
  },
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
    zIndex: 10,
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
