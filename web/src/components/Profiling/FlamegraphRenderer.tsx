/**
 * FlamegraphRenderer.tsx
 *
 * Canvas2D 기반 icicle(top-down flame) 차트.
 * 외부 라이브러리 없이 folded-format 데이터를 직접 파싱/렌더링한다.
 *
 * 인터랙션:
 *   - 호버: 함수명 + 샘플수 + % 툴팁
 *   - 클릭: 해당 frame 줌인 (해당 frame을 전체 너비로 확대)
 *   - 더블클릭: 전체 복원
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import type { CSSProperties } from 'react';
import type { FoldedFrame } from '../../api/client';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Frame {
  name: string;
  value: number;      // 누적 샘플 수 (자신 + 자식)
  selfValue: number;  // 자신만의 샘플 수
  children: Frame[];
  depth: number;
  xOffset: number;    // [0, 1] 정규화 X 시작
  width: number;      // [0, 1] 정규화 너비
}

interface Tooltip {
  x: number;
  y: number;
  frame: Frame;
  totalValue: number;
}

interface Props {
  folded: FoldedFrame[];
  height?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const ROW_HEIGHT = 20;
const PADDING    = { top: 4, bottom: 4, left: 0, right: 0 };
const MIN_RENDER_WIDTH_PX = 2; // 이 픽셀 미만 프레임은 텍스트 생략

// Warm palette: 함수명 해시 → 빨강/오렌지/노랑 계열
function frameColor(name: string, depth: number): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }

  // hue: 0 ~ 55 (빨강 → 오렌지 → 노랑)
  const hue = hash % 56;
  // 깊이가 깊을수록 약간 어두워짐 (55% → 40% lightness)
  const lightness = Math.max(38, 56 - depth * 1.4);
  // saturation: 약간 변화
  const sat = 80 + (hash % 20);

  return `hsl(${hue}, ${sat}%, ${lightness}%)`;
}

// ─── folded 파서 ──────────────────────────────────────────────────────────────

function parseFolded(folded: FoldedFrame[]): Frame {
  const root: Frame = {
    name:      'all',
    value:     0,
    selfValue: 0,
    children:  [],
    depth:     0,
    xOffset:   0,
    width:     1,
  };

  for (const { stack, value } of folded) {
    const parts = stack.split(';').filter(Boolean);
    let node = root;
    node.value += value;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      let child = node.children.find((c) => c.name === name);
      if (!child) {
        child = {
          name,
          value:     0,
          selfValue: 0,
          children:  [],
          depth:     i + 1,
          xOffset:   0,
          width:     0,
        };
        node.children.push(child);
      }
      child.value += value;
      if (i === parts.length - 1) {
        child.selfValue += value;
      }
      node = child;
    }
  }

  // x 오프셋/너비 계산 (BFS)
  function layoutNode(frame: Frame, xOffset: number, width: number) {
    frame.xOffset = xOffset;
    frame.width   = width;

    let cx = xOffset;
    for (const child of frame.children) {
      const cw = (child.value / frame.value) * width;
      layoutNode(child, cx, cw);
      cx += cw;
    }
  }

  layoutNode(root, 0, 1);

  return root;
}

// ─── 모든 frame을 깊이-우선으로 수집 ─────────────────────────────────────────

function collectFrames(root: Frame): Frame[] {
  const result: Frame[] = [];
  function dfs(f: Frame) {
    result.push(f);
    for (const c of f.children) dfs(c);
  }
  dfs(root);
  return result;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function FlamegraphRenderer({ folded, height = 400 }: Props) {
  const canvasRef  = useRef<HTMLCanvasElement>(null);
  const wrapRef    = useRef<HTMLDivElement>(null);

  // zoom 상태: 어떤 frame 기준으로 확대했는지
  const [zoomedFrame, setZoomedFrame] = useState<Frame | null>(null);
  const [tooltip, setTooltip]         = useState<Tooltip | null>(null);

  // 마지막으로 계산된 tree 를 ref 에 보관 (이벤트 핸들러에서 사용)
  const treeRef   = useRef<Frame | null>(null);
  const framesRef = useRef<Frame[]>([]);

  // ─── 파싱 ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!folded || folded.length === 0) return;
    const tree = parseFolded(folded);
    treeRef.current   = tree;
    framesRef.current = collectFrames(tree);
  }, [folded]);

  // ─── 렌더링 ────────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !treeRef.current) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.offsetWidth;
    const cssH = height;

    if (canvas.width  !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width  = cssW * dpr;
      canvas.height = cssH * dpr;
    }

    const ctxRaw = canvas.getContext('2d');
    if (!ctxRaw) return;
    // Non-nullable alias for use inside nested closures
    const ctx: CanvasRenderingContext2D = ctxRaw;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    const root  = treeRef.current;
    const pivot = zoomedFrame ?? root;

    // zoom 기준 frame 의 x/w 를 전체 너비로 매핑하는 transform
    const pivotX = pivot.xOffset;
    const pivotW = pivot.width;

    function toScreenX(nx: number): number {
      return PADDING.left + ((nx - pivotX) / pivotW) * (cssW - PADDING.left - PADDING.right);
    }
    function toScreenW(nw: number): number {
      return (nw / pivotW) * (cssW - PADDING.left - PADDING.right);
    }

    // zoom 기준 depth 를 0으로 정규화
    const baseDepth = pivot.depth;

    function drawFrame(frame: Frame) {
      const px = toScreenX(frame.xOffset);
      const pw = toScreenW(frame.width);
      const py = PADDING.top + (frame.depth - baseDepth) * ROW_HEIGHT;

      // 화면 밖이면 스킵
      if (px + pw < 0 || px > cssW || py > cssH) return;
      // zoom 기준 depth 보다 위는 그리지 않음
      if (frame.depth < baseDepth) {
        for (const c of frame.children) drawFrame(c);
        return;
      }

      // 너무 좁으면 자식도 스킵
      if (pw < MIN_RENDER_WIDTH_PX) return;

      const color = frame.name === 'all' ? '#21262D' : frameColor(frame.name, frame.depth - baseDepth);
      ctx.fillStyle = color;
      ctx.fillRect(px + 0.5, py + 0.5, Math.max(0, pw - 1), ROW_HEIGHT - 1);

      // 텍스트
      if (pw > 24) {
        ctx.fillStyle = 'rgba(230,237,243,0.92)';
        ctx.font      = '11px ui-monospace, monospace';
        ctx.textBaseline = 'middle';

        const maxW  = pw - 8;
        let label   = frame.name === 'all' ? 'root' : frame.name;
        // 짧은 버전: 마지막 점 이후 (패키지명 생략)
        const shortLabel = label.includes('.') ? label.split('.').pop()! : label;

        // ellipsis 처리
        let text = label;
        if (ctx.measureText(text).width > maxW) {
          text = shortLabel;
          if (ctx.measureText(text).width > maxW) {
            // 문자 수 줄이기
            while (text.length > 1 && ctx.measureText(text + '…').width > maxW) {
              text = text.slice(0, -1);
            }
            text = text + '…';
          }
        }

        ctx.fillText(text, px + 4, py + ROW_HEIGHT / 2);
      }

      // 자식 재귀
      for (const c of frame.children) drawFrame(c);
    }

    drawFrame(root);

    // zoom 중이면 상단에 "클릭된 frame 이름" 표시
    if (pivot !== root) {
      ctx.fillStyle   = 'rgba(88,166,255,0.12)';
      ctx.fillRect(0, 0, cssW, 18);
      ctx.fillStyle   = '#58A6FF';
      ctx.font        = '11px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Zoomed: ${pivot.name}  — 더블클릭으로 전체 복원`, 8, 9);
    }
  }, [height, zoomedFrame]);

  // ─── ResizeObserver ────────────────────────────────────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    draw();
    return () => ro.disconnect();
  }, [draw]);

  // ─── 마우스 이벤트 ──────────────────────────────────────────────────────────
  const hitTest = useCallback((clientX: number, clientY: number): Frame | null => {
    const canvas = canvasRef.current;
    if (!canvas || !treeRef.current) return null;

    const rect   = canvas.getBoundingClientRect();
    const mx     = clientX - rect.left;
    const my     = clientY - rect.top;

    const pivot     = zoomedFrame ?? treeRef.current;
    const baseDepth = pivot.depth;
    const cssW      = canvas.offsetWidth;

    function toScreenX(nx: number): number {
      return PADDING.left + ((nx - pivot.xOffset) / pivot.width) * (cssW - PADDING.left - PADDING.right);
    }
    function toScreenW(nw: number): number {
      return (nw / pivot.width) * (cssW - PADDING.left - PADDING.right);
    }

    let hit: Frame | null = null;

    function check(frame: Frame) {
      if (frame.depth < baseDepth) {
        for (const c of frame.children) check(c);
        return;
      }
      const px = toScreenX(frame.xOffset);
      const pw = toScreenW(frame.width);
      const py = PADDING.top + (frame.depth - baseDepth) * ROW_HEIGHT;

      if (pw < MIN_RENDER_WIDTH_PX) return;
      if (mx >= px && mx <= px + pw && my >= py && my <= py + ROW_HEIGHT) {
        hit = frame;
        return;
      }
      for (const c of frame.children) check(c);
    }

    check(treeRef.current!);
    return hit;
  }, [zoomedFrame]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const frame = hitTest(e.clientX, e.clientY);
    if (frame) {
      const total = treeRef.current?.value ?? 1;
      setTooltip({ x: e.clientX, y: e.clientY, frame, totalValue: total });
    } else {
      setTooltip(null);
    }
  }, [hitTest]);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const frame = hitTest(e.clientX, e.clientY);
    if (frame && frame.name !== 'all') {
      setZoomedFrame(frame);
    }
  }, [hitTest]);

  const handleDoubleClick = useCallback(() => {
    setZoomedFrame(null);
  }, []);

  // zoom 변경 시 재렌더
  useEffect(() => { draw(); }, [draw, zoomedFrame]);

  // ─── 빈 데이터 ────────────────────────────────────────────────────────────
  if (!folded || folded.length === 0) {
    return (
      <div style={styles.empty}>
        <span style={styles.emptyText}>플레임그래프 데이터 없음</span>
      </div>
    );
  }

  const totalSamples = treeRef.current?.value ?? 0;

  return (
    <div ref={wrapRef} style={{ ...styles.wrap, height }}>
      {/* 범례 */}
      <div style={styles.legend}>
        <span style={styles.legendText}>
          총 샘플: <strong>{totalSamples.toLocaleString()}</strong>
        </span>
        <span style={styles.legendHint}>클릭: 줌  |  더블클릭: 전체 복원</span>
      </div>

      <canvas
        ref={canvasRef}
        style={styles.canvas}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        role="img"
        aria-label="Flamegraph visualization"
      />

      {/* 툴팁 */}
      {tooltip && (
        <div
          style={{
            ...styles.tooltip,
            left: tooltip.x + 14,
            top:  tooltip.y - 10,
          }}
        >
          <div style={styles.tooltipName}>{tooltip.frame.name}</div>
          <div style={styles.tooltipRow}>
            <span style={styles.tooltipLabel}>샘플</span>
            <span style={styles.tooltipValue}>{tooltip.frame.value.toLocaleString()}</span>
          </div>
          <div style={styles.tooltipRow}>
            <span style={styles.tooltipLabel}>비율</span>
            <span style={styles.tooltipValue}>
              {((tooltip.frame.value / tooltip.totalValue) * 100).toFixed(2)}%
            </span>
          </div>
          {tooltip.frame.selfValue > 0 && (
            <div style={styles.tooltipRow}>
              <span style={styles.tooltipLabel}>self</span>
              <span style={styles.tooltipValue}>{tooltip.frame.selfValue.toLocaleString()}</span>
            </div>
          )}
          <div style={styles.tooltipRow}>
            <span style={styles.tooltipLabel}>depth</span>
            <span style={styles.tooltipValue}>{tooltip.frame.depth}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  wrap: {
    position:   'relative' as const,
    width:      '100%',
    overflow:   'hidden',
    background: '#0D1117',
    borderRadius: 6,
    border:     '1px solid #30363D',
  },
  legend: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'space-between',
    padding:        '4px 10px',
    borderBottom:   '1px solid #21262D',
    background:     '#161B22',
  },
  legendText: {
    fontSize:   11,
    color:      '#8B949E',
    fontFamily: 'system-ui, sans-serif',
  } as CSSProperties,
  legendHint: {
    fontSize:   10,
    color:      'rgba(139,148,158,0.5)',
    fontFamily: 'system-ui, sans-serif',
  } as CSSProperties,
  canvas: {
    display:    'block',
    width:      '100%',
    cursor:     'pointer',
  } as CSSProperties,
  empty: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    height:         120,
    background:     '#0D1117',
    borderRadius:   6,
    border:         '1px solid #30363D',
  },
  emptyText: {
    fontSize:   13,
    color:      'rgba(139,148,158,0.5)',
    fontFamily: 'system-ui, sans-serif',
  },
  tooltip: {
    position:     'fixed' as const,
    zIndex:       9999,
    background:   '#1C2128',
    border:       '1px solid #30363D',
    borderRadius: 6,
    padding:      '8px 10px',
    pointerEvents:'none' as const,
    minWidth:     180,
    boxShadow:    '0 4px 16px rgba(0,0,0,0.6)',
  },
  tooltipName: {
    fontSize:     11,
    fontWeight:   600,
    color:        '#C9D1D9',
    fontFamily:   'ui-monospace, monospace',
    marginBottom: 6,
    wordBreak:    'break-all' as const,
    maxWidth:     280,
  },
  tooltipRow: {
    display:        'flex',
    justifyContent: 'space-between',
    gap:            16,
    marginTop:      2,
  },
  tooltipLabel: {
    fontSize:   11,
    color:      '#8B949E',
    fontFamily: 'system-ui, sans-serif',
  },
  tooltipValue: {
    fontSize:   11,
    fontWeight: 600,
    color:      '#E3B341',
    fontFamily: 'ui-monospace, monospace',
  },
} as const;
