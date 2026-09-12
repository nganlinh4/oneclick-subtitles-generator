/* global browser, window, document, performance, requestAnimationFrame, cancelAnimationFrame,
   MutationObserver, PerformanceObserver */

// Observe real work; do not replace application data, IPC, rendering or layout results.
export const startFrontendSample = () => browser.execute(() => {
  if (window.__OSG_FRONTEND_SAMPLE__) throw new Error('a frontend sample is already running');
  const stats = {
    elapsedMs: 0, frames: 0, timelinePaints: 0, progressWrites: 0,
    resizeObservations: {}, longTasks: [], maxFrameGapMs: 0,
  };
  const started = performance.now();
  const heap = performance.memory?.usedJSHeapSize ?? null;
  const NativeResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends NativeResizeObserver {
    observe(target, options) {
      const key = String(target.className || target.tagName).slice(0, 150);
      stats.resizeObservations[key] = (stats.resizeObservations[key] || 0) + 1;
      return super.observe(target, options);
    }
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.attributeName === 'data-osg-painted-subtitle-count') stats.timelinePaints += 1;
      if (record.attributeName === 'style'
          && record.target.classList.contains('progress-indicator')) stats.progressWrites += 1;
    }
  });
  observer.observe(document.body, {
    subtree: true, attributes: true, attributeFilter: ['style', 'data-osg-painted-subtitle-count'],
  });
  let longTasks = null;
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    longTasks = new PerformanceObserver((list) => {
      stats.longTasks.push(...list.getEntries().map(entry => entry.duration));
    });
    longTasks.observe({ type: 'longtask' });
  }
  let frame = 0;
  let previous = performance.now();
  const tick = (now) => {
    stats.frames += 1;
    stats.maxFrameGapMs = Math.max(stats.maxFrameGapMs, now - previous);
    previous = now;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  window.__OSG_FRONTEND_SAMPLE__ = () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    longTasks?.disconnect();
    window.ResizeObserver = NativeResizeObserver;
    delete window.__OSG_FRONTEND_SAMPLE__;
    const totalLongTaskMs = stats.longTasks.reduce((sum, value) => sum + value, 0);
    return {
      ...stats, elapsedMs: performance.now() - started,
      heapGrowthBytes: heap === null ? null : performance.memory.usedJSHeapSize - heap,
      totalLongTaskMs,
      maxLongTaskMs: Math.max(0, ...stats.longTasks),
      visibleRows: document.querySelectorAll('.lyric-item[data-lyric-index]').length,
      domElements: document.querySelectorAll('*').length,
    };
  };
});

export const finishFrontendSample = () => browser.execute(() => window.__OSG_FRONTEND_SAMPLE__());
