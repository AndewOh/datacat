/**
 * LineChart.tsx — Canvas2D 라인 차트 (외부 라이브러리 없음)
 *
 * Features:
 *   - X축: 시간 레이블 (분 단위)
 *   - Y축: 자동 스케일, 4개 눈금
 *   - 가로 점선 그리드 4개
 *   - 마우스 호버 툴팁 (가장 가까운 포인트)
 *   - 빈 데이터: "No data" 중앙 표시
 *   - 다크 테마
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import type { MetricPoint } from '../../api/client';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface MetricSeries {
  labels: Record<string, string>;
  data: MetricPoint[];
}

export interface LineChartProps {
  data: MetricPoint[];
  series?: MetricSeries[];
  title?: string;
  unit?: string;
  color?: string;
  loading?: boolean;
}

const SERIES_COLORS = ['#58A6FF', '#3FB950', '#FF7B72', '#D2A8FF', '#FFA657', '#79C0FF'];

// ─── Constants ────────────────────────────────────────────────────────────────

const BG      = '#0D1117';
const GRID    = '#30363D';
const AXIS_TXT = 'rgba(139,148,158,0.8)';
const AREA_FILL = 'rgba(88,166,255,0.06)';

// Padding inside canvas (px)
const PAD = { top: 16, right: 16, bottom: 36, left: 52 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function niceMax(raw: number): number {
  if (raw <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  let nice = 1;
  if      (normalized <= 1)  nice = 1;
  else if (normalized <= 2)  nice = 2;
  else if (normalized <= 5)  nice = 5;
  else                       nice = 10;
  return nice * magnitude;
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function fmtValue(v: number, unit?: string): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M${unit ? ' ' + unit : ''}`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}k${unit ? ' ' + unit : ''}`;
  const dec = v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(dec)}${unit ? ' ' + unit : ''}`;
}

// ─── Draw function (single series) ───────────────────────────────────────────

function drawMultiSeries(
  canvas: HTMLCanvasElement,
  seriesList: MetricSeries[],
  unit: string | undefined,
  hoverX: number | null,
) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.clientWidth;
  const H   = canvas.clientHeight;
  if (W === 0 || H === 0) return;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const allData = seriesList.flatMap((s) => s.data);
  if (!allData.length) {
    ctx.fillStyle = AXIS_TXT;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No data', W / 2, H / 2);
    return;
  }

  const cx = PAD.left;
  const cy = PAD.top;
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top  - PAD.bottom;
  if (cw <= 0 || ch <= 0) return;

  const minT = Math.min(...allData.map((p) => p.t));
  const maxT = Math.max(...allData.map((p) => p.t));
  const maxV = niceMax(Math.max(...allData.map((p) => p.v)));
  const minV = 0;

  const scaleX = (t: number) => cx + ((t - minT) / Math.max(maxT - minT, 1)) * cw;
  const scaleY = (v: number) => cy + ch - ((v - minV) / (maxV - minV)) * ch;

  const GRID_COUNT = 4;
  ctx.setLineDash([3, 4]);
  ctx.lineWidth   = 1;
  ctx.strokeStyle = GRID;
  for (let i = 0; i <= GRID_COUNT; i++) {
    const fraction = i / GRID_COUNT;
    const v  = minV + (maxV - minV) * fraction;
    const gy = cy + ch - fraction * ch;
    ctx.beginPath();
    ctx.moveTo(cx, gy);
    ctx.lineTo(cx + cw, gy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle    = AXIS_TXT;
    ctx.font         = '10px ui-monospace, monospace';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtValue(v, unit), cx - 6, gy);
    ctx.setLineDash([3, 4]);
  }
  ctx.setLineDash([]);

  const X_LABELS = 5;
  ctx.fillStyle    = AXIS_TXT;
  ctx.font         = '10px ui-monospace, monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= X_LABELS; i++) {
    const fraction = i / X_LABELS;
    const t  = minT + (maxT - minT) * fraction;
    const gx = cx + fraction * cw;
    ctx.fillText(fmtTime(t), gx, cy + ch + 6);
  }

  seriesList.forEach((series, si) => {
    const color = SERIES_COLORS[si % SERIES_COLORS.length];
    const { data } = series;
    if (!data.length) return;

    ctx.beginPath();
    ctx.moveTo(scaleX(data[0].t), scaleY(data[0].v));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(scaleX(data[i].t), scaleY(data[i].v));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.lineJoin    = 'round';
    ctx.stroke();
  });

  if (hoverX !== null) {
    const px = cx + hoverX * cw;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(201,209,217,0.2)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.moveTo(px, cy);
    ctx.lineTo(px, cy + ch);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function draw(
  canvas: HTMLCanvasElement,
  data: MetricPoint[],
  color: string,
  unit: string | undefined,
  hoverIdx: number | null,
) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.clientWidth;
  const H   = canvas.clientHeight;

  if (W === 0 || H === 0) return;

  // Resize canvas buffer if needed
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width  = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // ── Clear ──
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // ── No data ──
  if (!data.length) {
    ctx.fillStyle = AXIS_TXT;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No data', W / 2, H / 2);
    return;
  }

  // Chart drawing area
  const cx  = PAD.left;
  const cy  = PAD.top;
  const cw  = W - PAD.left - PAD.right;
  const ch  = H - PAD.top  - PAD.bottom;

  if (cw <= 0 || ch <= 0) return;

  // ── Scale ──
  const minT = data[0].t;
  const maxT = data[data.length - 1].t;
  const maxV = niceMax(Math.max(...data.map((p) => p.v)));
  const minV = 0;

  const scaleX = (t: number) => cx + ((t - minT) / Math.max(maxT - minT, 1)) * cw;
  const scaleY = (v: number) => cy + ch - ((v - minV) / (maxV - minV)) * ch;

  // ── Grid lines + Y labels ──
  const GRID_COUNT = 4;
  ctx.setLineDash([3, 4]);
  ctx.lineWidth   = 1;
  ctx.strokeStyle = GRID;

  for (let i = 0; i <= GRID_COUNT; i++) {
    const fraction = i / GRID_COUNT;
    const v  = minV + (maxV - minV) * fraction;
    const gy = cy + ch - fraction * ch;

    // Grid line
    ctx.beginPath();
    ctx.moveTo(cx, gy);
    ctx.lineTo(cx + cw, gy);
    ctx.stroke();

    // Y label
    ctx.setLineDash([]);
    ctx.fillStyle    = AXIS_TXT;
    ctx.font         = '10px ui-monospace, monospace';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(fmtValue(v, unit), cx - 6, gy);
    ctx.setLineDash([3, 4]);
  }
  ctx.setLineDash([]);

  // ── X axis labels ──
  const X_LABELS = 5;
  ctx.fillStyle    = AXIS_TXT;
  ctx.font         = '10px ui-monospace, monospace';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';

  for (let i = 0; i <= X_LABELS; i++) {
    const fraction = i / X_LABELS;
    const t  = minT + (maxT - minT) * fraction;
    const gx = cx + fraction * cw;
    ctx.fillText(fmtTime(t), gx, cy + ch + 6);
  }

  // ── Area fill ──
  ctx.beginPath();
  ctx.moveTo(scaleX(data[0].t), scaleY(0));
  for (const pt of data) {
    ctx.lineTo(scaleX(pt.t), scaleY(pt.v));
  }
  ctx.lineTo(scaleX(data[data.length - 1].t), scaleY(0));
  ctx.closePath();
  ctx.fillStyle = AREA_FILL;
  ctx.fill();

  // ── Line ──
  ctx.beginPath();
  ctx.moveTo(scaleX(data[0].t), scaleY(data[0].v));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(scaleX(data[i].t), scaleY(data[i].v));
  }
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // ── Hover ──
  if (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < data.length) {
    const pt = data[hoverIdx];
    const px = scaleX(pt.t);
    const py = scaleY(pt.v);

    // Vertical crosshair
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(201,209,217,0.2)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.moveTo(px, cy);
    ctx.lineTo(px, cy + ch);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dot
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle   = color;
    ctx.fill();
    ctx.strokeStyle = '#0D1117';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Tooltip
    const label     = `${fmtTime(pt.t)}  ${fmtValue(pt.v, unit)}`;
    ctx.font        = '11px ui-monospace, monospace';
    const tw        = ctx.measureText(label).width;
    const tPad      = 6;
    const tW        = tw + tPad * 2;
    const tH        = 22;
    let tx          = px + 10;
    let ty          = py - tH / 2;

    // Clamp within chart area
    if (tx + tW > cx + cw) tx = px - tW - 10;
    if (ty < cy)            ty = cy;
    if (ty + tH > cy + ch) ty = cy + ch - tH;

    // Tooltip background
    ctx.fillStyle   = '#21262D';
    ctx.strokeStyle = '#30363D';
    ctx.lineWidth   = 1;
    roundRect(ctx, tx, ty, tW, tH, 4);
    ctx.fill();
    ctx.stroke();

    // Tooltip text
    ctx.fillStyle    = '#C9D1D9';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, tx + tPad, ty + tH / 2);
  }
}

// Small roundRect helper (native API may not be available in all browsers)
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Component ────────────────────────────────────────────────────────────────

export function LineChart({
  data,
  series,
  unit,
  color = '#58A6FF',
  loading = false,
}: LineChartProps) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);

  const isMulti = series !== undefined && series.length > 0;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (isMulti) {
      drawMultiSeries(canvas, series!, unit, hoverFrac);
    } else {
      draw(canvas, data, color, unit, hoverIdx);
    }
  }, [data, series, color, unit, hoverIdx, hoverFrac, isMulti]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      if (isMulti) {
        drawMultiSeries(canvas, series!, unit, hoverFrac);
      } else {
        draw(canvas, data, color, unit, hoverIdx);
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [data, series, color, unit, hoverIdx, hoverFrac, isMulti]);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      const W    = canvas.clientWidth;
      const cw   = W - PAD.left - PAD.right;
      const frac = Math.max(0, Math.min(1, (mx - PAD.left) / cw));

      if (isMulti) {
        setHoverFrac(frac);
      } else {
        if (!data.length) return;
        const minT = data[0].t;
        const maxT = data[data.length - 1].t;
        const t    = minT + frac * (maxT - minT);
        let closest = 0;
        let minDist = Infinity;
        for (let i = 0; i < data.length; i++) {
          const dist = Math.abs(data[i].t - t);
          if (dist < minDist) { minDist = dist; closest = i; }
        }
        setHoverIdx(closest);
      }
    },
    [data, isMulti],
  );

  const handleMouseLeave = useCallback(() => {
    setHoverIdx(null);
    setHoverFrac(null);
  }, []);

  const legendItems = isMulti ? series!.map((s, i) => ({
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    label: Object.entries(s.labels).map(([k, v]) => `${k}=${v}`).join(' '),
  })) : [];

  return (
    <div style={styles.wrap}>
      {loading && (
        <div style={styles.loadingOverlay}>
          <span style={styles.spinner} />
        </div>
      )}
      <canvas
        ref={canvasRef}
        style={isMulti && legendItems.length > 0 ? styles.canvasWithLegend : styles.canvas}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        aria-label="Line chart"
        role="img"
      />
      {isMulti && legendItems.length > 0 && (
        <div style={styles.legend}>
          {legendItems.map((item) => (
            <div key={item.label} style={styles.legendItem}>
              <span style={{ ...styles.legendDot, background: item.color }} />
              <span style={styles.legendLabel}>{item.label || '(default)'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  wrap: {
    position:      'relative' as const,
    width:         '100%',
    height:        '100%',
    minHeight:     0,
    display:       'flex',
    flexDirection: 'column' as const,
  },
  canvas: {
    display: 'block',
    width:   '100%',
    height:  '100%',
    cursor:  'crosshair',
    flex:    1,
    minHeight: 0,
  },
  canvasWithLegend: {
    display: 'block',
    width:   '100%',
    flex:    1,
    minHeight: 0,
    cursor:  'crosshair',
  },
  legend: {
    display:    'flex',
    flexWrap:   'wrap' as const,
    gap:        '4px 12px',
    padding:    '6px 8px 4px',
    flexShrink: 0,
  },
  legendItem: {
    display:    'flex',
    alignItems: 'center',
    gap:        5,
  },
  legendDot: {
    width:        8,
    height:       8,
    borderRadius: '50%',
    flexShrink:   0,
  },
  legendLabel: {
    fontSize:   10,
    color:      'rgba(201,209,217,0.7)',
    fontFamily: 'ui-monospace, monospace',
    whiteSpace: 'nowrap' as const,
  },
  loadingOverlay: {
    position:       'absolute' as const,
    inset:          0,
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    background:     'rgba(13,17,23,0.6)',
    zIndex:         1,
    borderRadius:   6,
  },
  spinner: {
    display:         'inline-block',
    width:           20,
    height:          20,
    border:          '2px solid rgba(88,166,255,0.25)',
    borderTopColor:  '#58A6FF',
    borderRadius:    '50%',
    animation:       'spin 0.8s linear infinite',
  },
} as const;
