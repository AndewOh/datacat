import '@testing-library/jest-dom';

// jsdom does not implement ResizeObserver — shim it so components that use it don't throw.
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// jsdom's HTMLCanvasElement.getContext returns null; stub it so canvas-based
// components don't throw when they guard with `if (!ctx) return`.
HTMLCanvasElement.prototype.getContext = function () {
  return null;
} as typeof HTMLCanvasElement.prototype.getContext;
