// Visible page state (errors, overflow, focus) read from the WebView, its validation, and
// bounded browser/app-log diagnostics.

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

/* global browser, document, getComputedStyle, window */

const MAX_BROWSER_LOGS = 100;
const MAX_BROWSER_LOG_MESSAGE = 2_000;
const MAX_APP_LOG_FILES = 8;
const MAX_APP_LOG_TAIL_BYTES = 16 * 1024;
const MAX_CAPTURED_HORIZONTAL_SCROLL_PX = 1_000_000;

export const collectVisibleStateFromPage = () => {
  const boundedHorizontalScroll = (value) => {
    const offset = Number(value);
    if (!Number.isFinite(offset)) return null;
    return Math.max(-1_000_000, Math.min(1_000_000, offset));
  };
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const textOf = (node) => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
  const uniqueText = (nodes) => [...new Set(nodes.filter(visible).map(textOf).filter(Boolean))];
  const errorToasts = uniqueText([
    ...document.querySelectorAll('.toast-item.live .toast.toast-error'),
  ]).slice(-8);
  const errorAlerts = uniqueText([
    ...document.querySelectorAll('[role="alert"], [data-osg-error], .engine-card__error, .update-check-failed'),
  ].filter((node) => node.closest('.toast-item') === null)).slice(0, 12);
  const overflowPx = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
  return {
    viewport: [window.innerWidth, window.innerHeight],
    document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    horizontalOverflow: overflowPx > 0,
    horizontalOverflowPx: overflowPx,
    // Root scroll position is independent from scrollWidth: a viewport-width document can still be
    // displaced. Deliberately do not inspect nested scrollers; timelines and tab strips may rest at
    // a nonzero local offset without moving the customer-visible document.
    horizontalScroll: {
      window: boundedHorizontalScroll(window.scrollX ?? window.pageXOffset ?? 0),
      document: boundedHorizontalScroll(document.documentElement.scrollLeft),
      body: boundedHorizontalScroll(document.body?.scrollLeft ?? 0),
    },
    previewState: document.querySelector('[data-osg-preview]')?.getAttribute('data-osg-preview') ?? null,
    renderAdmission: document.querySelector('[data-osg-render-admission]')
      ?.getAttribute('data-osg-render-admission') ?? null,
    alerts: [...errorAlerts, ...errorToasts],
    errorAlerts,
    errorToasts,
    toasts: [...document.querySelectorAll('.toast-item.live .toast')]
      .filter(visible).map(textOf).filter(Boolean).slice(-8),
    visibleText: textOf(document.body).slice(0, 4_000),
  };
};

export const visibleState = () => browser.execute(collectVisibleStateFromPage);

const unavailableVisibleState = (error) => ({
  viewport: null,
  document: null,
  horizontalOverflow: false,
  horizontalOverflowPx: 0,
  horizontalScroll: { window: null, document: null, body: null },
  previewState: null,
  renderAdmission: null,
  alerts: [],
  errorAlerts: [],
  errorToasts: [],
  toasts: [],
  visibleText: '',
  captureUnavailable: String(error?.message ?? error).slice(0, 500),
});

export const bestEffortVisibleState = async () => {
  try {
    return await visibleState();
  } catch (error) {
    return unavailableVisibleState(error);
  }
};

const validateTextAllowances = (entries, label) => {
  if (entries === undefined) return [];
  assert.ok(Array.isArray(entries) && entries.length <= 4, `${label} allowance must contain at most four entries`);
  return entries.map((entry) => {
    assert.deepEqual(Object.keys(entry).sort(), ['reason', 'text'], `${label} allowance must name exact text and reason`);
    assert.equal(typeof entry.text, 'string');
    assert.ok(entry.text.length > 0 && entry.text.length <= 500, `${label} allowance text must be bounded`);
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.reason.trim().length >= 8 && entry.reason.length <= 300, `${label} allowance needs a bounded reason`);
    return entry.text;
  });
};

/**
 * Reject customer-visible failures by default. A journey may allow only an exact error string, or
 * a measured overflow of at most 16 px, and must document why that state is the subject under test.
 * Broad booleans, regexes and substring matches are intentionally unsupported.
 */
export const validateVisibleState = (state, allowVisibleProblems = {}) => {
  assert.deepEqual(
    Object.keys(allowVisibleProblems).sort(),
    Object.keys(allowVisibleProblems).filter((key) => (
      key === 'errorAlerts' || key === 'errorToasts' || key === 'horizontalOverflow'
    )).sort(),
    'unknown visible-problem allowance',
  );
  const allowedAlerts = validateTextAllowances(allowVisibleProblems.errorAlerts, 'errorAlerts');
  const allowedToasts = validateTextAllowances(allowVisibleProblems.errorToasts, 'errorToasts');
  const unexpectedAlerts = (state.errorAlerts ?? state.alerts ?? [])
    .filter((text) => !allowedAlerts.includes(text));
  const unexpectedToasts = (state.errorToasts ?? [])
    .filter((text) => !allowedToasts.includes(text));
  assert.deepEqual(unexpectedAlerts, [], `workflow screenshot contains visible error alert(s): ${unexpectedAlerts.join(' | ')}`);
  assert.deepEqual(unexpectedToasts, [], `workflow screenshot contains visible error toast(s): ${unexpectedToasts.join(' | ')}`);

  const horizontalScroll = state.horizontalScroll;
  assert.ok(
    horizontalScroll !== null && typeof horizontalScroll === 'object' && !Array.isArray(horizontalScroll),
    'workflow visible state must record bounded window/document/body horizontal scroll offsets',
  );
  assert.deepEqual(
    Object.keys(horizontalScroll).sort(),
    ['body', 'document', 'window'],
    'workflow visible state must record only window/document/body horizontal scroll offsets',
  );
  for (const [root, offset] of Object.entries(horizontalScroll)) {
    assert.ok(
      Number.isFinite(offset) && Math.abs(offset) <= MAX_CAPTURED_HORIZONTAL_SCROLL_PX,
      `workflow visible state has an invalid ${root} horizontal scroll offset`,
    );
  }
  const displacedRoots = Object.entries(horizontalScroll)
    .filter(([, offset]) => offset !== 0)
    .map(([root, offset]) => `${root}=${offset}px`);
  assert.deepEqual(
    displacedRoots,
    [],
    `workflow screenshot rests at nonzero horizontal document scroll: ${displacedRoots.join(', ')}`,
  );

  const overflowPx = state.horizontalOverflowPx ?? (state.horizontalOverflow ? 1 : 0);
  if (overflowPx > 0) {
    const allowance = allowVisibleProblems.horizontalOverflow;
    assert.ok(allowance && typeof allowance === 'object', `workflow screenshot overflows horizontally by ${overflowPx}px`);
    assert.deepEqual(
      Object.keys(allowance).sort(),
      ['maxPixels', 'reason'],
      'horizontal overflow allowance must name maxPixels and reason',
    );
    assert.ok(Number.isSafeInteger(allowance.maxPixels) && allowance.maxPixels >= 1 && allowance.maxPixels <= 16,
      'horizontal overflow allowance must be 1..16px');
    assert.equal(typeof allowance.reason, 'string');
    assert.ok(allowance.reason.trim().length >= 8 && allowance.reason.length <= 300,
      'horizontal overflow allowance needs a bounded reason');
    assert.ok(overflowPx <= allowance.maxPixels,
      `workflow screenshot overflows by ${overflowPx}px, above allowed ${allowance.maxPixels}px`);
  }
  return state;
};

export const boundedBrowserDiagnostics = async (state) => {
  const diagnostic = { capturedAt: new Date().toISOString(), visibleState: state };
  for (const [name, method] of [
    ['url', 'getUrl'],
    ['title', 'getTitle'],
    ['windowRect', 'getWindowRect'],
  ]) {
    try {
      const value = await browser[method]();
      diagnostic[name] = typeof value === 'string' ? value.slice(0, 2_000) : value;
    } catch (error) {
      diagnostic[`${name}Unavailable`] = String(error?.message ?? error).slice(0, 500);
    }
  }
  // The embedded Tauri provider does not implement WebDriver's `se/log` endpoint. Calling it makes
  // the transport retry and print four warnings while adding no diagnostic evidence; app JSONL and
  // the bounded DOM snapshot are the supported authorities in this channel.
  if (process.env.OSG_E2E_OFFSCREEN_WINDOW === '1') {
    diagnostic.browserLogsUnavailable = 'embedded Tauri WebDriver does not implement se/log';
  } else {
    try {
      const logs = await browser.getLogs('browser');
      diagnostic.browserLogs = logs.slice(-MAX_BROWSER_LOGS).map((entry) => ({
        level: String(entry.level ?? '').slice(0, 32),
        source: String(entry.source ?? '').slice(0, 100),
        timestamp: Number.isFinite(entry.timestamp) ? entry.timestamp : null,
        message: String(entry.message ?? '').slice(0, MAX_BROWSER_LOG_MESSAGE),
      }));
    } catch (error) {
      diagnostic.browserLogsUnavailable = String(error?.message ?? error).slice(0, 500);
    }
  }
  return diagnostic;
};

export const appLogTails = () => {
  const runRoot = process.env.OSG_E2E_DATA_ROOT;
  if (!runRoot) return [];
  const logsRoot = join(runRoot, 'logs');
  if (!existsSync(logsRoot)) return [];
  const files = [];
  const visit = (directory, depth) => {
    if (depth > 2 || files.length >= MAX_APP_LOG_FILES) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      files.push({ path: directory, discoveryError: String(error?.message ?? error).slice(0, 500) });
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_APP_LOG_FILES) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile()) files.push({ path, discoveryError: null });
    }
  };
  visit(logsRoot, 0);
  return files.map(({ discoveryError, path }) => {
    const file = relative(logsRoot, path).replaceAll('\\', '/');
    if (discoveryError !== null) return { file, unavailable: discoveryError };
    try {
      const bytes = readFileSync(path);
      const tail = bytes.subarray(Math.max(0, bytes.byteLength - MAX_APP_LOG_TAIL_BYTES));
      return {
        file,
        size: bytes.byteLength,
        tail: tail.toString('utf8'),
        tailTruncated: bytes.byteLength > MAX_APP_LOG_TAIL_BYTES,
      };
    } catch (error) {
      return { file, unavailable: String(error?.message ?? error).slice(0, 500) };
    }
  });
};
