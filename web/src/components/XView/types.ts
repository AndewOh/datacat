export interface XViewPoint {
  x: number;       // timestamp (epoch ms)
  y: number;       // response time (ms)
  status: 0 | 1;  // 0: success (blue), 1: error (red)
  spanId: string;
  traceId: string;
}

export interface Viewport {
  // Normalized [0,1] range for visible data area
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface SelectionRect {
  // Canvas pixel coordinates
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface XViewStats {
  totalPoints: number;
  visiblePoints: number;
  selectedCount: number;
  fps: number;
}

/**
 * Generates mock XViewPoints for development/testing.
 * Distributes across a 5-minute window with realistic response time distribution.
 */
export function generateMockPoints(count: number): XViewPoint[] {
  const now = Date.now();
  const windowMs = 5 * 60 * 1000; // 5 minutes
  const points: XViewPoint[] = [];

  for (let i = 0; i < count; i++) {
    const x = now - Math.random() * windowMs;

    // Bimodal distribution: most requests fast, some slow
    let y: number;
    const r = Math.random();
    if (r < 0.7) {
      // Fast cluster: 10–200ms
      y = 10 + Math.random() * 190;
    } else if (r < 0.92) {
      // Medium cluster: 200–1000ms
      y = 200 + Math.random() * 800;
    } else {
      // Slow tail: 1000–8000ms
      y = 1000 + Math.random() * 7000;
    }

    // ~5% error rate, higher for slow requests
    const isError = y > 2000 ? Math.random() < 0.4 : Math.random() < 0.05;

    points.push({
      x,
      y,
      status: isError ? 1 : 0,
      spanId: `span_${i.toString(16).padStart(8, '0')}`,
      traceId: `trace_${Math.floor(i / 4).toString(16).padStart(16, '0')}`,
    });
  }

  return points;
}
