// Visible-state oracle: documented errors/overflow, root offsets, error colours and focus scrolling.

import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';

import {
  beginWorkflowEvidence, captureWorkflowStep, collectVisibleStateFromPage,
  refreshWorkflowEvidenceIndex, validateVisibleState, workflowEvidenceDirectory,
  cleanupWorkflowEvidenceTestRoot, workflowForTest,
} from './workflowEvidenceTestHarness.js';

test.after(cleanupWorkflowEvidenceTestRoot);
test('visible errors and horizontal overflow fail unless exactly and narrowly documented', () => {
  const state = {
    errorAlerts: ['Preview failed: unreadable media'],
    errorToasts: ['Export failed: disk full'],
    horizontalOverflow: true,
    horizontalOverflowPx: 3,
    horizontalScroll: { window: 0, document: 0, body: 0 },
  };
  assert.throws(() => validateVisibleState(state), /visible error alert/);
  assert.doesNotThrow(() => validateVisibleState(state, {
    errorAlerts: [{
      text: 'Preview failed: unreadable media',
      reason: 'This journey proves the explicit damaged-media refusal.',
    }],
    errorToasts: [{
      text: 'Export failed: disk full',
      reason: 'This journey proves the explicit no-space refusal.',
    }],
    horizontalOverflow: {
      maxPixels: 3,
      reason: 'This fixture deliberately measures a three-pixel browser rounding edge.',
    },
  }));
  assert.throws(() => validateVisibleState(state, {
    errorAlerts: [{ text: 'Preview failed', reason: 'Substring matching is deliberately forbidden.' }],
  }), /visible error alert/);
  assert.throws(() => validateVisibleState({
    errorAlerts: [], errorToasts: [], horizontalOverflowPx: 17,
    horizontalScroll: { window: 0, document: 0, body: 0 },
  }, {
    horizontalOverflow: { maxPixels: 17, reason: 'This should be too broad to admit.' },
  }), /1\.\.16px/);
});

test('zero overflow cannot hide a horizontally displaced document', () => {
  const settled = {
    errorAlerts: [],
    errorToasts: [],
    horizontalOverflow: false,
    horizontalOverflowPx: 0,
    horizontalScroll: { window: 0, document: 0, body: 0 },
  };
  assert.doesNotThrow(() => validateVisibleState({
    ...settled,
    // Nested product scrollers are intentionally outside the root-scroll contract.
    details: { timelineScrollLeft: 840, tabStripScrollLeft: 320 },
  }));
  for (const [root, offset] of [
    ['window', 11],
    ['document', 11],
    ['body', -0.25],
  ]) {
    assert.throws(() => validateVisibleState({
      ...settled,
      horizontalScroll: { ...settled.horizontalScroll, [root]: offset },
      // This reproduces the Settings failure shape: the modal and document were displaced even
      // though scrollWidth equalled innerWidth. The Settings oracle separately checks the modal.
      details: { modalScrollLeft: 11 },
    }), /rests at nonzero horizontal document scroll/);
  }
  assert.throws(() => validateVisibleState({
    ...settled,
    horizontalScroll: { window: 0, document: Number.POSITIVE_INFINITY, body: 0 },
  }), /invalid document horizontal scroll offset/);
  assert.throws(() => validateVisibleState({
    ...settled,
    horizontalScroll: undefined,
  }), /must record bounded window\/document\/body/);
});

test('visible state records bounded root offsets even when the document width equals the viewport', () => {
  const priorDocument = globalThis.document;
  const priorWindow = globalThis.window;
  const priorGetComputedStyle = globalThis.getComputedStyle;
  globalThis.document = {
    documentElement: {
      scrollWidth: 1_440,
      scrollHeight: 900,
      scrollLeft: 5_000_000,
    },
    body: {
      innerText: 'settled editor',
      scrollLeft: -5_000_000,
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.window = {
    innerWidth: 1_440,
    innerHeight: 900,
    scrollX: 7.5,
  };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  try {
    const state = collectVisibleStateFromPage();
    assert.equal(state.horizontalOverflowPx, 0);
    assert.deepEqual(state.horizontalScroll, {
      window: 7.5,
      document: 1_000_000,
      body: -1_000_000,
    });
    assert.throws(() => validateVisibleState(state), /rests at nonzero horizontal document scroll/);
  } finally {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = priorGetComputedStyle;
  }
});

test('visible state distinguishes destructive error-coloured controls from semantic error surfaces', () => {
  const priorDocument = globalThis.document;
  const priorWindow = globalThis.window;
  const priorGetComputedStyle = globalThis.getComputedStyle;
  const node = (text) => ({
    innerText: text,
    closest: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
  });
  const clearButton = node('close');
  const refusal = node('The media could not be decoded');
  globalThis.document = {
    documentElement: { scrollWidth: 1_400, scrollHeight: 900, scrollLeft: 0 },
    body: { innerText: 'editor', scrollLeft: 0 },
    querySelector: () => null,
    querySelectorAll: (selector) => {
      if (selector === '.toast-item.live .toast.toast-error'
          || selector === '.toast-item.live .toast') return [];
      if (selector === '[role="alert"], [data-osg-error], .engine-card__error, .update-check-failed') {
        return [refusal];
      }
      if (selector === '.error, [role="alert"]') return [clearButton, refusal];
      return [];
    },
  };
  globalThis.window = { innerWidth: 1_400, innerHeight: 900, scrollX: 0 };
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  try {
    const state = collectVisibleStateFromPage();
    assert.deepEqual(state.errorAlerts, ['The media could not be decoded']);
    assert.doesNotThrow(() => validateVisibleState({
      ...state,
      errorAlerts: [],
      alerts: [],
    }));
  } finally {
    if (priorDocument === undefined) delete globalThis.document;
    else globalThis.document = priorDocument;
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
    if (priorGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = priorGetComputedStyle;
  }
});

test('evidence focus scrolling never moves Settings and still centers off-screen page evidence', async () => {
  const workflow = workflowForTest('focus-scroll');
  const workflowDirectory = workflowEvidenceDirectory(workflow);
  const scratch = mkdtempSync(join(tmpdir(), 'osg-evidence-focus-scroll-'));
  const binary = join(scratch, 'osg-e2e.exe');
  const priorAttempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  const priorBrowser = globalThis.browser;
  const scrolls = [];
  const rectangles = [
    { top: 100, right: 1_300, bottom: 800, left: 100 },
    { top: 950, right: 1_300, bottom: 1_200, left: 100 },
    { top: 950, right: 1_300, bottom: 1_200, left: 100 },
  ];
  writeFileSync(binary, 'guarded');
  try {
    const attempt = beginWorkflowEvidence({
      workflow,
      journey: 'journeys/focus-scroll.journey.js',
      iteration: 1,
      binaryPath: binary,
    });
    process.env.OSG_E2E_EVIDENCE_ATTEMPT = attempt.id;
    globalThis.browser = {
      execute: async (callback, selector) => {
        if (selector !== undefined) {
          const rect = rectangles.shift();
          const insideSettingsModal = selector === '.settings-modal'
            || selector === '.video-processing-section';
          const priorDocument = globalThis.document;
          const priorWindow = globalThis.window;
          globalThis.document = {
            querySelector: () => ({
              closest: (candidate) => (
                candidate === '.settings-modal' && insideSettingsModal ? {} : null
              ),
              getBoundingClientRect: () => rect,
              scrollIntoView: (options) => scrolls.push(options),
            }),
          };
          globalThis.window = { innerWidth: 1_440, innerHeight: 900 };
          try {
            return callback(selector);
          } finally {
            globalThis.document = priorDocument;
            globalThis.window = priorWindow;
          }
        }
        return {
          viewport: [1_440, 900],
          document: [1_440, 900],
          horizontalOverflow: false,
          horizontalOverflowPx: 0,
          horizontalScroll: { window: 0, document: 0, body: 0 },
          errorAlerts: [],
          errorToasts: [],
          alerts: [],
          toasts: [],
          visibleText: 'settled settings surface',
        };
      },
      pause: async () => {},
      takeScreenshot: async () => Buffer.alloc(2_000).toString('base64'),
    };
    await captureWorkflowStep({
      workflow,
      step: 'visible-fixed-surface',
      description: 'A fixed settings surface already inside the viewport stays in place.',
      focusSelector: '.settings-modal',
    });
    assert.deepEqual(scrolls, []);
    await assert.rejects(() => captureWorkflowStep({
      workflow,
      step: 'off-screen-modal-descendant',
      description: 'Capture refuses to claim a Settings target that the screenshot cannot show.',
      focusSelector: '.video-processing-section',
    }), /outside the visible Settings viewport/u);
    assert.deepEqual(scrolls, [], 'a Settings descendant must never mutate modal or page scroll');
    await captureWorkflowStep({
      workflow,
      step: 'off-screen-surface',
      description: 'An off-screen surface is brought immediately into the evidence frame.',
      focusSelector: '.below-fold',
    });
    assert.deepEqual(scrolls, [{ behavior: 'instant', block: 'center', inline: 'nearest' }]);
  } finally {
    globalThis.browser = priorBrowser;
    if (priorAttempt === undefined) delete process.env.OSG_E2E_EVIDENCE_ATTEMPT;
    else process.env.OSG_E2E_EVIDENCE_ATTEMPT = priorAttempt;
    rmSync(workflowDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    refreshWorkflowEvidenceIndex();
  }
});
