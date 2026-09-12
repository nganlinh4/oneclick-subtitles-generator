/* global browser, window, document, performance, requestAnimationFrame, cancelAnimationFrame,
   MutationObserver, PerformanceObserver */

// Observe real work; do not replace application data, IPC, rendering or layout results.
export const startFrontendSample = () => browser.execute(() => {
  if (window.__OSG_FRONTEND_SAMPLE__) throw new Error('a frontend sample is already running');
  const stats = {
    elapsedMs: 0, frames: 0, timelinePaints: 0, progressWrites: 0,
    resizeObservations: {}, longTasks: [], maxFrameGapMs: 0,
    subtitleArrivals: [],
  };
  const started = performance.now();
  const heap = performance.memory?.usedJSHeapSize ?? null;
  const NativeResizeObserver = window.ResizeObserver;
  const observed = new Map();
  window.ResizeObserver = class extends NativeResizeObserver {
    observe(target, options) {
      if (!observed.has(this)) observed.set(this, new Set());
      observed.get(this).add(target);
      const key = String(target.className || target.tagName).slice(0, 150);
      stats.resizeObservations[key] = (stats.resizeObservations[key] || 0) + 1;
      return super.observe(target, options);
    }
    unobserve(target) { observed.get(this)?.delete(target); return super.unobserve(target); }
    disconnect() { observed.delete(this); return super.disconnect(); }
  };
  const addListener = document.addEventListener;
  const removeListener = document.removeEventListener;
  const listeners = [];
  const capture = options => typeof options === 'boolean' ? options : !!options?.capture;
  document.addEventListener = function(type, callback, options) {
    if (!listeners.some(item => item.type === type && item.callback === callback && item.capture === capture(options))) {
      listeners.push({ type, callback, capture: capture(options) });
    }
    return addListener.call(this, type, callback, options);
  };
  document.removeEventListener = function(type, callback, options) {
    const index = listeners.findIndex(item => item.type === type && item.callback === callback && item.capture === capture(options));
    if (index >= 0) listeners.splice(index, 1);
    return removeListener.call(this, type, callback, options);
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.attributeName === 'data-osg-painted-subtitle-count') {
        stats.timelinePaints += 1;
        const count = Number(record.target.dataset.osgPaintedSubtitleCount);
        if (Number.isFinite(count) && stats.subtitleArrivals.at(-1)?.count !== count
            && stats.subtitleArrivals.length < 2048) {
          stats.subtitleArrivals.push({ elapsedMs: performance.now() - started, count });
        }
      }
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
    document.addEventListener = addListener;
    document.removeEventListener = removeListener;
    delete window.__OSG_FRONTEND_SAMPLE__;
    const totalLongTaskMs = stats.longTasks.reduce((sum, value) => sum + value, 0);
    return {
      ...stats, elapsedMs: performance.now() - started,
      heapGrowthBytes: heap === null ? null : performance.memory.usedJSHeapSize - heap,
      totalLongTaskMs,
      maxLongTaskMs: Math.max(0, ...stats.longTasks),
      activeResizeObservations: [...observed.values()].reduce((count, targets) => count + targets.size, 0),
      detachedResizeObservations: [...observed.values()].flatMap(targets => [...targets]).filter(target => !target.isConnected).length,
      retainedDocumentListeners: listeners.reduce((counts, { type }) => ({ ...counts, [type]: (counts[type] || 0) + 1 }), {}),
      visibleRows: document.querySelectorAll('.lyric-item[data-lyric-index]').length,
      domElements: document.querySelectorAll('*').length,
    };
  };
});

export const finishFrontendSample = () => browser.execute(() => window.__OSG_FRONTEND_SAMPLE__());
