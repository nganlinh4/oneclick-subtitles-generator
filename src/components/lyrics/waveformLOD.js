// High-DPI canvas + native waveform presentation utilities (pure, no component deps)

// High-DPI canvas utilities for crisp rendering at any zoom level
export const getDevicePixelRatio = () => window.devicePixelRatio || 1;

export const setupHighDPICanvas = (canvas, width, height) => {
  const dpr = getDevicePixelRatio();
  // Set actual canvas size in memory (scaled up for high-DPI)
  canvas.width = width * dpr;
  canvas.height = height * dpr;

  // Scale the canvas back down using CSS
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  // Scale the drawing context so everything draws at the correct size
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  return ctx;
};

/**
 * Add the one display statistic not carried on the native wire object.
 * Rust already built every LOD level; the WebView must never downsample or
 * duplicate the pyramid again.
 */
export const prepareNativeWaveform = (waveform) => {
  const base = waveform.levels[0];
  let peakRootMeanSquare = 0;
  for (const point of base.points) {
    peakRootMeanSquare = Math.max(peakRootMeanSquare, point.rootMeanSquare);
  }
  return Object.freeze({
    durationSeconds: waveform.durationUs / 1_000_000,
    peakRootMeanSquare,
    levels: waveform.levels,
  });
};

/** Select the coarsest native level that still supplies roughly two points per pixel. */
export const selectNativeWaveformLevel = (waveform, visibleDuration, width) => {
  const pixelsPerSecond = width / visibleDuration;
  const targetPointsPerSecond = pixelsPerSecond * 2;
  let selected = waveform.levels[0];
  for (const level of waveform.levels) {
    if (level.pointsPerSecond < targetPointsPerSecond) break;
    selected = level;
  }
  return selected;
};
