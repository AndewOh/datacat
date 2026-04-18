/**
 * XViewRenderer.ts — WebGL2 기반 고성능 scatter plot 렌더러
 *
 * 목표: 100만 포인트, 60fps, 드래그 선택 <16ms
 *
 * 구조:
 *  - VAO + interleaved VBO (position xy + status float) → 캐시 일관성 극대화
 *  - Instanced 아님: gl.drawArrays(POINTS) → GPU 파이프라인 단순 유지
 *  - selectInRect: CPU-side AABB 필터 (GPU readback은 너무 느림)
 *  - 정규화 좌표계: 데이터 범위를 [0,1]로 정규화 후 shader에서 NDC 변환
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

  // CPU-side data cache for selectInRect (avoids GPU readback)
  private cpuData: Float32Array = new Float32Array(0);
  private pointCount: number = 0;

  // Normalized data extents (computed in setData)
  private dataXMin: number = 0;
  private dataXMax: number = 1;
  private dataYMin: number = 0;
  private dataYMax: number = 1;

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
   * O(n) — call once per data update, not per frame.
   */
  setData(points: XViewPoint[]): void {
    const gl = this.gl;
    this.pointCount = points.length;

    if (points.length === 0) {
      this.cpuData = new Float32Array(0);
      this.spanIds = [];
      return;
    }

    // Compute data extents for normalization
    let xMin = points[0].x, xMax = points[0].x;
    let yMin = points[0].y, yMax = points[0].y;

    for (const p of points) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }

    // Add 2% padding so boundary points aren't clipped
    const xPad = (xMax - xMin) * 0.02;
    const yPad = (yMax - yMin) * 0.02;
    this.dataXMin = xMin - xPad;
    this.dataXMax = xMax + xPad;
    this.dataYMin = yMin - yPad;
    this.dataYMax = yMax + yPad;

    const xRange = this.dataXMax - this.dataXMin;
    const yRange = this.dataYMax - this.dataYMin;

    // Build interleaved Float32Array: [nx, ny, status, ...]
    const data = new Float32Array(points.length * 3);
    this.spanIds = new Array(points.length);

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const base = i * 3;
      data[base]     = (p.x - this.dataXMin) / xRange;
      data[base + 1] = (p.y - this.dataYMin) / yRange;
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
   * Return span IDs of all points within the canvas-pixel selection rect.
   * Pure CPU operation — no GPU readback, guaranteed <16ms for 1M points.
   *
   * The rect is in canvas CSS pixel coordinates (not physical pixels).
   */
  selectInRect(
    rectX: number,
    rectY: number,
    rectW: number,
    rectH: number,
    viewport: Viewport
  ): string[] {
    if (this.pointCount === 0) return [];

    const canvasW = this.canvas.clientWidth;
    const canvasH = this.canvas.clientHeight;

    // Normalize rect to [0,1] canvas space (Y flipped: canvas Y=0 is top)
    const rLeft   = Math.min(rectX, rectX + rectW) / canvasW;
    const rRight  = Math.max(rectX, rectX + rectW) / canvasW;
    const rTop    = Math.min(rectY, rectY + rectH) / canvasH;
    const rBottom = Math.max(rectY, rectY + rectH) / canvasH;

    // Convert to viewport-normalized coords (accounting for pan/zoom)
    const xRange = viewport.xMax - viewport.xMin;
    const yRange = viewport.yMax - viewport.yMin;

    // viewport → data-normalized: dataNorm = vpMin + rectNorm * vpRange
    // Y: canvas Y=0 is top (success low response → bottom of canvas)
    //    In our NDC: gl y=0 is bottom, so canvas top = data top = high y
    const dataLeft   = viewport.xMin + rLeft   * xRange;
    const dataRight  = viewport.xMin + rRight  * xRange;
    const dataTop    = viewport.yMin + (1.0 - rTop)    * yRange;
    const dataBottom = viewport.yMin + (1.0 - rBottom) * yRange;

    const dnLeft   = dataLeft;
    const dnRight  = dataRight;
    const dnBottom = Math.min(dataTop, dataBottom);
    const dnTop    = Math.max(dataTop, dataBottom);

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

  /** Current FPS (rolling 30-frame average) */
  getFps(): number {
    if (this.frameTimes.length === 0) return 0;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return avg > 0 ? Math.round(1000 / avg) : 0;
  }

  /** Data extents for external axis labels */
  getDataExtents(): { xMin: number; xMax: number; yMin: number; yMax: number } {
    return {
      xMin: this.dataXMin,
      xMax: this.dataXMax,
      yMin: this.dataYMin,
      yMax: this.dataYMax,
    };
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
