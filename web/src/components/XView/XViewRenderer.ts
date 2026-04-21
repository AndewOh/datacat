/**
 * XViewRenderer.ts — WebGL2 기반 고성능 scatter plot 렌더러
 *
 * 목표: 100만 포인트, 60fps, 드래그 선택 <16ms
 *
 * 구조:
 *  - VAO + interleaved VBO (position xy + status float) → 캐시 일관성 극대화
 *  - Instanced 아님: gl.drawArrays(POINTS) → GPU 파이프라인 단순 유지
 *  - selectInDataRect: CPU-side AABB 필터 (GPU readback은 너무 느림)
 *  - 정규화 좌표계: 데이터 범위를 [0,1]로 정규화 후 shader에서 NDC 변환
 *  - Y축: log1p 스케일 적용으로 빠른 트랜잭션과 느린 트랜잭션 고르게 분포
 */

import type { XViewPoint, Viewport } from './types';

// ─── Shader source ────────────────────────────────────────────────────────────

const VERTEX_SHADER_SRC = /* glsl */ `#version 300 es
precision highp float;

// Interleaved: xy=position, z=status
in vec3 a_data;

// x: scaleX, y: scaleY, z: translateX, w: translateY  (all in [0,1] space)
uniform vec4 u_transform;

out float v_status;
out float v_selected;

uniform float u_selectedMask; // unused per-vertex in base pass

void main() {
  vec2 pos = a_data.xy * u_transform.xy + u_transform.zw;

  // [0,1] → NDC: multiply by 2 subtract 1, flip Y so y=0 is bottom
  gl_Position = vec4(pos.x * 2.0 - 1.0, pos.y * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 2.5;

  v_status = a_data.z;
  v_selected = 0.0;
}
`;

const FRAGMENT_SHADER_SRC = /* glsl */ `#version 300 es
precision mediump float;

in float v_status;
in float v_selected;

out vec4 fragColor;

void main() {
  // Circular point (discard corners of the point sprite quad)
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = dot(coord, coord);
  if (dist > 0.25) discard;

  // Soft edge anti-alias
  float alpha = 1.0 - smoothstep(0.18, 0.25, dist);

  // success: #4A90E2 (blue), error: #E24A4A (red)
  vec3 color = v_status < 0.5
    ? vec3(0.290, 0.565, 0.886)
    : vec3(0.886, 0.290, 0.290);

  // Slight brighten on error for visual salience
  color = v_status < 0.5 ? color : color * 1.15;

  fragColor = vec4(color, alpha * (v_status < 0.5 ? 0.75 : 0.90));
}
`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RenderStats {
  pointCount: number;
  drawCallMs: number;
  fps: number;
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

export class XViewRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;

  // Uniform locations
  private readonly uTransform: WebGLUniformLocation;

  // CPU-side data cache for selectInDataRect (avoids GPU readback)
  // Stored as log1p-normalized [0,1] values — same space as GPU data
  private cpuData: Float32Array = new Float32Array(0);
  private pointCount: number = 0;

  // Normalized data extents (computed in setData, raw ms values)
  private dataXMin: number = 0;
  private dataXMax: number = 1;
  private dataYMin: number = 0;   // raw ms (clamped >= 0)
  private dataYMax: number = 1;   // raw ms

  // log1p of extent boundaries (pre-computed for Y normalization)
  private logYMin: number = 0;
  private logYMax: number = 0;

  // FPS tracking
  private lastFrameTime: number = 0;
  private frameTimes: number[] = [];

  // Span ID index (parallel array to GPU data, same order)
  private spanIds: string[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const gl = canvas.getContext('webgl2', {
      antialias: false,       // MSAA off — we do our own AA in fragment shader
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      throw new Error('WebGL2 is not supported in this browser. Please use Chrome 56+, Firefox 51+, or Edge 79+.');
    }

    this.gl = gl;

    // Compile shaders & link program
    this.program = this.createProgram(VERTEX_SHADER_SRC, FRAGMENT_SHADER_SRC);

    // Look up uniform locations
    const uTransform = gl.getUniformLocation(this.program, 'u_transform');
    if (!uTransform) throw new Error('u_transform uniform not found');
    this.uTransform = uTransform;

    // Create VAO
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    this.vao = vao;

    // Create VBO
    const vbo = gl.createBuffer();
    if (!vbo) throw new Error('Failed to create VBO');
    this.vbo = vbo;

    // Setup VAO layout: interleaved [x, y, status] → 3 floats per vertex
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);

    const stride = 3 * Float32Array.BYTES_PER_ELEMENT; // 12 bytes
    const aData = gl.getAttribLocation(this.program, 'a_data');

    gl.enableVertexAttribArray(aData);
    gl.vertexAttribPointer(aData, 3, gl.FLOAT, false, stride, 0);

    gl.bindVertexArray(null);

    // Global GL state
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.051, 0.067, 0.090, 1.0); // #0D1117
  }

  /**
   * Upload point data to GPU.
   * Computes normalization ranges from the dataset.
   * Y axis uses log1p scale for perceptual uniformity across response time decades.
   * O(n) — call once per data update, not per frame.
   */
  setData(points: XViewPoint[], xRange?: { start: number; end: number }): void {
    const gl = this.gl;
    this.pointCount = points.length;

    if (points.length === 0 && !xRange) {
      this.cpuData = new Float32Array(0);
      this.spanIds = [];
      return;
    }

    let xMin: number, xMax: number;
    let yMin = points[0]?.y ?? 0, yMax = points[0]?.y ?? 1;

    if (xRange) {
      // 요청한 시간 범위를 X축 extent로 고정 — 버튼(15m/1h/6h/24h)이 바뀔 때
      // 축 라벨이 항상 해당 범위를 반영하도록 한다.
      xMin = xRange.start;
      xMax = xRange.end;
      for (const p of points) {
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
    } else {
      xMin = points[0].x; xMax = points[0].x;
      for (const p of points) {
        if (p.x < xMin) xMin = p.x;
        if (p.x > xMax) xMax = p.x;
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
      }
    }

    // Add 2% padding so boundary points aren't clipped
    // xRange가 있으면 X는 엄격히 범위 끝까지만 표시 (pad 없음)
    const xPad = xRange ? 0 : (xMax - xMin) * 0.02;
    const yPad = (yMax - yMin) * 0.02;
    this.dataXMin = xMin - xPad;
    this.dataXMax = xMax + xPad;
    // Clamp Y min to 0 to avoid log1p of negative (log1p(-1) = -Infinity)
    this.dataYMin = Math.max(0, yMin - yPad);
    this.dataYMax = yMax + yPad;

    // Pre-compute log boundaries for Y normalization
    this.logYMin = Math.log1p(this.dataYMin);
    this.logYMax = Math.log1p(this.dataYMax);

    const xSpan   = this.dataXMax - this.dataXMin;
    const logYRange = this.logYMax - this.logYMin;

    // Build interleaved Float32Array: [nx, ny_log, status, ...]
    // ny is log1p-normalized so equal visual distance = equal decades of response time
    const data = new Float32Array(points.length * 3);
    this.spanIds = new Array(points.length);

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const base = i * 3;
      data[base]     = (p.x - this.dataXMin) / xSpan;
      data[base + 1] = (Math.log1p(p.y) - this.logYMin) / logYRange;
      data[base + 2] = p.status;
      this.spanIds[i] = p.spanId;
    }

    this.cpuData = data;

    // Upload to GPU
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Render one frame.
   * Call from requestAnimationFrame. Fast path: single draw call.
   *
   * @param viewport - visible data range in normalized [0,1] coordinates
   */
  render(viewport: Viewport): void {
    if (this.pointCount === 0) return;

    const gl = this.gl;
    const now = performance.now();

    // Resize canvas to display size (handles DPR and window resize)
    this.syncCanvasSize();

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    // Compute transform: maps normalized data coords → visible viewport
    // visible_coord = (data_coord - xMin) / (xMax - xMin)
    // We need: clip = visible_coord * scale + translate
    const xRange = viewport.xMax - viewport.xMin;
    const yRange = viewport.yMax - viewport.yMin;

    // Scale and translate in [0,1] space
    const scaleX = 1.0 / xRange;
    const scaleY = 1.0 / yRange;
    const translateX = -viewport.xMin / xRange;
    const translateY = -viewport.yMin / yRange;

    gl.uniform4f(this.uTransform, scaleX, scaleY, translateX, translateY);

    gl.drawArrays(gl.POINTS, 0, this.pointCount);

    gl.bindVertexArray(null);

    // FPS tracking (rolling 30-frame average)
    if (this.lastFrameTime > 0) {
      this.frameTimes.push(now - this.lastFrameTime);
      if (this.frameTimes.length > 30) this.frameTimes.shift();
    }
    this.lastFrameTime = now;
  }

  /**
   * Return span IDs of all points within the data-normalized [0,1] selection rect.
   * Operates on cpuData which stores log1p-normalized Y values.
   * The dnBottom/dnTop arguments must also be in [0,1] log-normalized space
   * (use pixelRectToDataNorm to convert from pixel coords).
   *
   * Pure CPU operation — no GPU readback, guaranteed <16ms for 1M points.
   */
  selectInDataRect(
    dnLeft: number,
    dnRight: number,
    dnBottom: number,
    dnTop: number,
  ): string[] {
    if (this.pointCount === 0) return [];

    const result: string[] = [];
    const data = this.cpuData;

    for (let i = 0; i < this.pointCount; i++) {
      const nx = data[i * 3];
      const ny = data[i * 3 + 1];
      if (nx >= dnLeft && nx <= dnRight && ny >= dnBottom && ny <= dnTop) {
        result.push(this.spanIds[i]);
      }
    }

    return result;
  }

  /**
   * Convert a canvas-pixel selection rect to data-normalized [0,1] rect.
   * The resulting bounds are in the same space as cpuData values (log-Y for Y axis).
   * Use the returned bounds directly with selectInDataRect.
   */
  pixelRectToDataNorm(
    rectX: number,
    rectY: number,
    rectW: number,
    rectH: number,
    viewport: Viewport,
  ): { left: number; right: number; bottom: number; top: number } {
    const canvasW = this.canvas.clientWidth;
    const canvasH = this.canvas.clientHeight;
    const xRange = viewport.xMax - viewport.xMin;
    const yRange = viewport.yMax - viewport.yMin;

    // Normalize pixel rect to [0,1] canvas space
    const rLeft   = Math.min(rectX, rectX + rectW) / canvasW;
    const rRight  = Math.max(rectX, rectX + rectW) / canvasW;
    const rTop    = Math.min(rectY, rectY + rectH) / canvasH;
    const rBottom = Math.max(rectY, rectY + rectH) / canvasH;

    // Convert canvas [0,1] → viewport data-normalized [0,1]
    // Y is flipped: canvas top (rTop=0) → data top (high y in viewport)
    const dataLeft   = viewport.xMin + rLeft   * xRange;
    const dataRight  = viewport.xMin + rRight  * xRange;
    const dataTop    = viewport.yMin + (1.0 - rTop)    * yRange;
    const dataBottom = viewport.yMin + (1.0 - rBottom) * yRange;

    return {
      left:   dataLeft,
      right:  dataRight,
      bottom: Math.min(dataTop, dataBottom),
      top:    Math.max(dataTop, dataBottom),
    };
  }

  pixelRectToRawData(
    rectX: number, rectY: number, rectW: number, rectH: number,
    viewport: Viewport,
  ): { left: number; right: number; bottom: number; top: number } {
    const canvasW = this.canvas.clientWidth;
    const canvasH = this.canvas.clientHeight;
    const xRange = viewport.xMax - viewport.xMin;
    const yRange = viewport.yMax - viewport.yMin;

    const rLeft   = Math.min(rectX, rectX + rectW) / canvasW;
    const rRight  = Math.max(rectX, rectX + rectW) / canvasW;
    const rTop    = Math.min(rectY, rectY + rectH) / canvasH;
    const rBottom = Math.max(rectY, rectY + rectH) / canvasH;

    // Canvas [0,1] → viewport data-norm [0,1]
    const dnLeft   = viewport.xMin + rLeft   * xRange;
    const dnRight  = viewport.xMin + rRight  * xRange;
    const dnTop    = viewport.yMin + (1.0 - rTop)    * yRange;
    const dnBottom = viewport.yMin + (1.0 - rBottom) * yRange;

    // Data-norm [0,1] → raw data units
    const dataXRange = this.dataXMax - this.dataXMin;
    const logYRange  = this.logYMax  - this.logYMin;

    const rawLeft   = this.dataXMin + dnLeft   * dataXRange;
    const rawRight  = this.dataXMin + dnRight  * dataXRange;
    // Y: un-normalize log1p  norm = (log1p(y) - logYMin) / logYRange  →  y = expm1(norm * logYRange + logYMin)
    const rawTop    = Math.expm1(Math.max(dnTop,    dnBottom) * logYRange + this.logYMin);
    const rawBottom = Math.expm1(Math.min(dnTop,    dnBottom) * logYRange + this.logYMin);

    return { left: rawLeft, right: rawRight, bottom: rawBottom, top: rawTop };
  }

  selectInRawDataRect(
    rawLeft: number, rawRight: number, rawBottom: number, rawTop: number,
  ): string[] {
    if (this.pointCount === 0) return [];
    const dataXRange = this.dataXMax - this.dataXMin;
    const logYRange  = this.logYMax  - this.logYMin;

    const dnLeft   = (rawLeft   - this.dataXMin) / dataXRange;
    const dnRight  = (rawRight  - this.dataXMin) / dataXRange;
    const dnBottom = logYRange > 0 ? (Math.log1p(rawBottom) - this.logYMin) / logYRange : 0;
    const dnTop    = logYRange > 0 ? (Math.log1p(rawTop)    - this.logYMin) / logYRange : 1;

    return this.selectInDataRect(dnLeft, dnRight, dnBottom, dnTop);
  }

  /**
   * Convert a data-normalized [0,1] rect back to canvas-pixel rect for SVG rendering.
   * Inverse of pixelRectToDataNorm.
   */
  dataNormRectToPixel(
    left: number,
    right: number,
    bottom: number,
    top: number,
    viewport: Viewport,
  ): { x: number; y: number; width: number; height: number } {
    const canvasW = this.canvas.clientWidth;
    const canvasH = this.canvas.clientHeight;
    const xRange = viewport.xMax - viewport.xMin;
    const yRange = viewport.yMax - viewport.yMin;

    const rLeft   = (left  - viewport.xMin) / xRange;
    const rRight  = (right - viewport.xMin) / xRange;
    const rTop    = 1.0 - (top    - viewport.yMin) / yRange; // Y flip
    const rBottom = 1.0 - (bottom - viewport.yMin) / yRange;

    return {
      x:      rLeft   * canvasW,
      y:      rTop    * canvasH,
      width:  (rRight - rLeft)   * canvasW,
      height: (rBottom - rTop)   * canvasH,
    };
  }

  /**
   * Legacy pixel-based selection for backwards compatibility.
   * Delegates to pixelRectToDataNorm + selectInDataRect.
   */
  selectInRect(
    rectX: number,
    rectY: number,
    rectW: number,
    rectH: number,
    viewport: Viewport,
  ): string[] {
    const dn = this.pixelRectToDataNorm(rectX, rectY, rectW, rectH, viewport);
    return this.selectInDataRect(dn.left, dn.right, dn.bottom, dn.top);
  }

  /** Current FPS (rolling 30-frame average) */
  getFps(): number {
    if (this.frameTimes.length === 0) return 0;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return avg > 0 ? Math.round(1000 / avg) : 0;
  }

  /** Data extents (raw ms / epoch ms) for external axis labels */
  getDataExtents(): { xMin: number; xMax: number; yMin: number; yMax: number } {
    return {
      xMin: this.dataXMin,
      xMax: this.dataXMax,
      yMin: this.dataYMin,
      yMax: this.dataYMax,
    };
  }

  /**
   * Map a raw Y value (ms) to log-normalized [0,1] given the stored extents.
   * Used by axis tick rendering to align labels with GPU point positions.
   */
  yMsToNorm(ms: number): number {
    if (this.logYMax === this.logYMin) return 0;
    return (Math.log1p(ms) - this.logYMin) / (this.logYMax - this.logYMin);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.vbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private syncCanvasSize(): void {
    const dpr = window.devicePixelRatio || 1;
    const displayW = Math.floor(this.canvas.clientWidth  * dpr);
    const displayH = Math.floor(this.canvas.clientHeight * dpr);

    if (this.canvas.width !== displayW || this.canvas.height !== displayH) {
      this.canvas.width  = displayW;
      this.canvas.height = displayH;
    }
  }

  private createProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const gl = this.gl;

    const vert = this.compileShader(gl.VERTEX_SHADER, vertSrc);
    const frag = this.compileShader(gl.FRAGMENT_SHADER, fragSrc);

    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create WebGL program');

    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Shader link error: ${info}`);
    }

    gl.deleteShader(vert);
    gl.deleteShader(frag);

    return program;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new Error(`Failed to create shader (type: ${type})`);

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      const typeName = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      throw new Error(`${typeName} shader compile error:\n${info}`);
    }

    return shader;
  }
}
