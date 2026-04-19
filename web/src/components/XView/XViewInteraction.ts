/**
 * XViewInteraction.ts — 드래그 선택, 줌, 패닝 이벤트 핸들러
 *
 * Viewport는 정규화된 [0,1] 데이터 공간 좌표를 사용한다.
 * - 줌: 마우스 위치 기준으로 확대/축소
 * - 패닝: Shift+드래그 또는 중간 버튼 드래그
 * - 선택: 좌클릭 드래그 → 직사각형 영역
 */

import type { Viewport, SelectionRect } from './types';

export interface InteractionCallbacks {
  onViewportChange: (vp: Viewport) => void;
  onSelectionStart: () => void;
  onSelectionChange: (rect: SelectionRect | null) => void;
  onSelectionEnd: (rect: SelectionRect) => void;
  /** Called on click (< 4px drag) — clears the committed selection entirely */
  onClearSelection: () => void;
}

type PointerMode = 'idle' | 'selecting' | 'panning';

export class XViewInteraction {
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: InteractionCallbacks;

  private viewport: Viewport = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
  private mode: PointerMode = 'idle';

  // Drag tracking (canvas CSS pixels)
  private dragStart: { x: number; y: number } | null = null;
  private dragCurrent: { x: number; y: number } | null = null;

  // Pan tracking
  private panViewportSnapshot: Viewport | null = null;

  // Cleanup refs
  private readonly handlers: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement, callbacks: InteractionCallbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.attach();
  }

  setViewport(vp: Viewport): void {
    this.viewport = vp;
  }

  getViewport(): Viewport {
    return { ...this.viewport };
  }

  dispose(): void {
    for (const off of this.handlers) off();
    this.handlers.length = 0;
  }

  // ─── Private: event wiring ──────────────────────────────────────────────────

  private attach(): void {
    const canvas = this.canvas;

    const onMouseDown = (e: MouseEvent) => this.handleMouseDown(e);
    const onMouseMove = (e: MouseEvent) => this.handleMouseMove(e);
    const onMouseUp   = (e: MouseEvent) => this.handleMouseUp(e);
    const onWheel     = (e: WheelEvent) => this.handleWheel(e);
    const onDblClick  = (e: MouseEvent) => this.handleDblClick(e);

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);

    this.handlers.push(
      () => canvas.removeEventListener('mousedown', onMouseDown),
      () => canvas.removeEventListener('mousemove', onMouseMove),
      () => canvas.removeEventListener('mouseup', onMouseUp),
      () => canvas.removeEventListener('wheel', onWheel),
      () => canvas.removeEventListener('dblclick', onDblClick),
    );
  }

  // ─── Private: event handlers ────────────────────────────────────────────────

  private handleMouseDown(e: MouseEvent): void {
    e.preventDefault();
    const pos = this.clientToCanvas(e);

    if (e.shiftKey || e.button === 1) {
      // Pan mode
      this.mode = 'panning';
      this.dragStart = pos;
      this.panViewportSnapshot = { ...this.viewport };
      this.canvas.style.cursor = 'grabbing';
    } else if (e.button === 0) {
      // Selection mode
      this.mode = 'selecting';
      this.dragStart = pos;
      this.dragCurrent = pos;
      this.callbacks.onSelectionStart();
      this.callbacks.onSelectionChange(null);
    }
  }

  private handleMouseMove(e: MouseEvent): void {
    if (this.mode === 'idle' || !this.dragStart) return;

    const pos = this.clientToCanvas(e);
    this.dragCurrent = pos;

    if (this.mode === 'selecting') {
      const rect = this.computeRect(this.dragStart, pos);
      this.callbacks.onSelectionChange(rect);
    } else if (this.mode === 'panning' && this.panViewportSnapshot) {
      this.applyPan(this.dragStart, pos, this.panViewportSnapshot);
    }
  }

  private handleMouseUp(_e: MouseEvent): void {
    if (this.mode === 'selecting' && this.dragStart && this.dragCurrent) {
      const rect = this.computeRect(this.dragStart, this.dragCurrent);
      if (rect.width > 4 || rect.height > 4) {
        this.callbacks.onSelectionEnd(rect);
      } else {
        // Click without meaningful drag → clear committed selection
        this.callbacks.onSelectionChange(null);
        this.callbacks.onClearSelection();
      }
    }

    this.mode = 'idle';
    this.dragStart = null;
    this.dragCurrent = null;
    this.panViewportSnapshot = null;
    this.canvas.style.cursor = 'crosshair';
  }

  private handleWheel(e: WheelEvent): void {
    e.preventDefault();

    const pos = this.clientToCanvas(e);
    const zoomFactor = e.deltaY > 0 ? 1.15 : 0.87;

    this.applyZoom(pos, zoomFactor);
  }

  private handleDblClick(_: MouseEvent): void {
    // Reset to full view
    this.viewport = { xMin: 0, xMax: 1, yMin: 0, yMax: 1 };
    this.callbacks.onViewportChange({ ...this.viewport });
  }

  // ─── Private: transform helpers ─────────────────────────────────────────────

  private applyZoom(canvasPos: { x: number; y: number }, factor: number): void {
    const vp = this.viewport;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;

    // Canvas position → normalized data [0,1]
    const nx = canvasPos.x / w;
    const ny = 1.0 - canvasPos.y / h; // Y flip

    // Map normalized canvas → viewport data coords
    const dataX = vp.xMin + nx * (vp.xMax - vp.xMin);
    const dataY = vp.yMin + ny * (vp.yMax - vp.yMin);

    // Scale viewport around the cursor point
    let newXMin = dataX + (vp.xMin - dataX) * factor;
    let newXMax = dataX + (vp.xMax - dataX) * factor;
    let newYMin = dataY + (vp.yMin - dataY) * factor;
    let newYMax = dataY + (vp.yMax - dataY) * factor;

    // Clamp to [0,1] — don't zoom past data extents
    newXMin = Math.max(0, newXMin);
    newXMax = Math.min(1, newXMax);
    newYMin = Math.max(0, newYMin);
    newYMax = Math.min(1, newYMax);

    // Enforce minimum range (avoid infinite zoom)
    const minRange = 0.001;
    if (newXMax - newXMin < minRange || newYMax - newYMin < minRange) return;

    this.viewport = { xMin: newXMin, xMax: newXMax, yMin: newYMin, yMax: newYMax };
    this.callbacks.onViewportChange({ ...this.viewport });
  }

  private applyPan(
    from: { x: number; y: number },
    to: { x: number; y: number },
    snapshot: Viewport
  ): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;

    const xRange = snapshot.xMax - snapshot.xMin;
    const yRange = snapshot.yMax - snapshot.yMin;

    // Delta in normalized coords
    const dx = ((to.x - from.x) / w) * xRange;
    const dy = ((to.y - from.y) / h) * yRange;

    // Pan: subtract (moving right shifts view left)
    let newXMin = snapshot.xMin - dx;
    let newXMax = snapshot.xMax - dx;
    let newYMin = snapshot.yMin + dy; // Y flipped
    let newYMax = snapshot.yMax + dy;

    // Clamp to [0,1]
    if (newXMin < 0) { newXMax -= newXMin; newXMin = 0; }
    if (newXMax > 1) { newXMin -= (newXMax - 1); newXMax = 1; }
    if (newYMin < 0) { newYMax -= newYMin; newYMin = 0; }
    if (newYMax > 1) { newYMin -= (newYMax - 1); newYMax = 1; }

    this.viewport = { xMin: newXMin, xMax: newXMax, yMin: newYMin, yMax: newYMax };
    this.callbacks.onViewportChange({ ...this.viewport });
  }

  private computeRect(
    from: { x: number; y: number },
    to: { x: number; y: number }
  ): SelectionRect {
    return {
      x: Math.min(from.x, to.x),
      y: Math.min(from.y, to.y),
      width: Math.abs(to.x - from.x),
      height: Math.abs(to.y - from.y),
    };
  }

  private clientToCanvas(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }
}
