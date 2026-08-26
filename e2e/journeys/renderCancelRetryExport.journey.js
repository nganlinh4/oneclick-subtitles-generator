// A customer cancels one admitted native render, retries the same project through the public
// Render control, and saves the successful result. Distinct public settings make the two queue
// rows visually identifiable; the read-only SQLite oracle supplies the native job IDs which the UI
// intentionally does not expose. The saved file must be byte-identical to the successful job's
// durable artifact and independently decodable.
//
// This is deliberately a single-process queue journey. Relaunch/recovery needs two application
// processes and belongs in a scenario runner; pretending to prove it inside one WebDriver session
// would only exercise React state, not native job recovery.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, readFileSync, readdirSync, statSync,
} from 'node:fs';
import {
  extname, isAbsolute, join, relative, resolve, sep,
} from 'node:path';
import process from 'node:process';

import { durableRenderScenes, durableState } from '../support/database.js';
import { managedArtifactFiles } from '../support/downloadJourneyOracle.js';
import { clickControl } from '../support/editor.js';
import {
  compareFramePixels,
  compareFrames,
  extractFrame,
  listMediaFiles,
  probeMedia,
  savePreviewElementFrame,
} from '../support/nativeMediaOracle.js';
import { REAL_VIDEO } from '../support/realMedia.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'render-cancel-retry-export';
const RENDER_ROW = '.video-rendering-section .rendering-row:has([data-osg-action="render-video"])';
const RENDER_BUTTON = `${RENDER_ROW} [data-osg-action="render-video"]`;
const TERMINAL_TIMEOUT_MS = 10 * 60 * 1_000;
const MEDIA_EXTENSIONS = new Set(['.mkv', '.mov', '.mp4', '.webm']);
const MAX_RECORDED_RENDER_ERRORS = 32;
const COMPARE_AT_SECONDS = 1;
const RENDER_PREVIEW_CANVAS = (
  '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]'
);

/* global $, $$, MutationObserver, browser, describe, document, getComputedStyle, it, window */

const readableRenderLedger = (root) => {
  const state = durableState(root);
  return Object.freeze({
    projects: state.projects,
    jobs: state.jobs.filter(({ kind }) => kind === 'renderVideo'),
    artifacts: state.artifacts.filter(({ kind }) => kind === 'renderedVideo'),
  });
};

const installTransientRenderErrorLedger = () => browser.execute((maximumEvents) => {
  window.__OSG_E2E_RENDER_ERROR_LEDGER__?.observer?.disconnect?.();
  const events = [];
  let overflow = 0;
  const selector = [
    '.video-rendering-section [role="alert"]',
    '.video-rendering-section .error',
    '.video-rendering-section .error-message',
    '.video-rendering-section .video-error',
    '.toast-item.live .toast-error',
    '.toast-item.live .toast-warning',
  ].join(',');
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  };
  const record = (node, requireVisible) => {
    if (requireVisible && !visible(node)) return;
    const message = (node.innerText || node.textContent || '')
      .trim().replace(/\s+/g, ' ').slice(0, 400);
    if (!message || events.includes(message)) return;
    if (events.length >= maximumEvents) {
      overflow += 1;
      return;
    }
    events.push(message);
  };
  const inspect = (candidate, requireVisible) => {
    const node = candidate?.nodeType === 1 ? candidate : candidate?.parentElement;
    if (node === null || node === undefined) return;
    if (node.matches?.(selector)) record(node, requireVisible);
    for (const descendant of node.querySelectorAll?.(selector) ?? []) {
      record(descendant, requireVisible);
    }
  };
  const captureVisible = () => {
    for (const node of document.querySelectorAll(selector)) record(node, true);
  };
  const observer = new MutationObserver((records) => {
    for (const mutation of records) {
      inspect(mutation.target, true);
      for (const added of mutation.addedNodes) inspect(added, false);
    }
    captureVisible();
  });
  observer.observe(document.body, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  window.__OSG_E2E_RENDER_ERROR_LEDGER__ = {
    events, get overflow() { return overflow; }, observer,
  };
  captureVisible();
  return true;
}, MAX_RECORDED_RENDER_ERRORS);

const queueSurface = () => browser.execute(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
  };
  const text = (node) => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
  const statuses = ['pending', 'processing', 'cancelling', 'cancelled', 'completed', 'failed'];
  const rows = [...document.querySelectorAll('.video-rendering-section .queue-item')]
    .map((node, index) => ({
      index,
      status: statuses.find((candidate) => node.classList.contains(candidate)) ?? null,
      current: node.classList.contains('current'),
      text: text(node).slice(0, 1_000),
      canCancel: node.querySelector('.cancel-btn') !== null,
      canDownload: node.querySelector('.download-btn-success') !== null,
    }));
  return {
    rows,
    renderEnabled: document.querySelector(
      '.video-rendering-section [data-osg-action="render-video"]',
    )?.disabled === false,
    settingLabels: [...document.querySelectorAll(
      '.video-rendering-section .rendering-row:has([data-osg-action="render-video"]) '
      + '.custom-dropdown-button .dropdown-value',
    )].map(text),
    inlineErrors: [...document.querySelectorAll(
      '.video-rendering-section .error, .video-rendering-section [role="alert"]',
    )].filter(visible).map(text).filter(Boolean),
    toasts: [...document.querySelectorAll('.toast-item.live .toast')]
      .filter(visible).map((node) => ({ className: node.className, text: text(node) }))
      .filter(({ text: message }) => Boolean(message)),
    recordedErrors: [...(window.__OSG_E2E_RENDER_ERROR_LEDGER__?.events ?? [])],
    recordedErrorOverflow: window.__OSG_E2E_RENDER_ERROR_LEDGER__?.overflow ?? 0,
  };
});

const assertNoRenderFailure = (surface) => {
  assert.deepEqual(surface.inlineErrors, [], 'the render queue shows an inline error');
  assert.deepEqual(
    surface.toasts.filter(({ className }) => /toast-(?:error|warning)/.test(className)),
    [],
    'the render queue shows an error or warning toast',
  );
  assert.equal(
    surface.rows.some(({ status }) => status === 'failed'),
    false,
    `the render queue contains a failed row: ${JSON.stringify(surface.rows)}`,
  );
  assert.equal(
    surface.recordedErrorOverflow,
    0,
    'the bounded transient render-error ledger overflowed',
  );
  assert.deepEqual(
    surface.recordedErrors,
    [],
    'a transient render error or warning appeared during the journey',
  );
};

const chooseRenderSetting = async (dropdownIndex, optionIndex, expectedPrefix) => {
  const buttons = await $$(`${RENDER_ROW} .custom-dropdown-button`);
  assert.equal(buttons.length, 2, 'the render settings row does not expose two public dropdowns');
  const button = buttons[dropdownIndex];
  await button.waitForClickable({
    timeout: 30_000,
    timeoutMsg: `render dropdown ${dropdownIndex} never became clickable`,
  });
  await button.click();
  const menu = await $('.custom-dropdown-clipper');
  await menu.waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: `render dropdown ${dropdownIndex} did not open its public option list`,
  });
  const options = await $$('.custom-dropdown-clipper .dropdown-option');
  assert.ok(optionIndex >= 0 && optionIndex < options.length, (
    `render dropdown ${dropdownIndex} has no option ${optionIndex}`
  ));
  const option = options[optionIndex];
  const optionLabel = (await option.getText()).trim().replace(/\s+/g, ' ');
  assert.ok(optionLabel.startsWith(expectedPrefix), (
    `render option ${optionIndex} did not start with ${expectedPrefix}: ${optionLabel}`
  ));
  await option.waitForClickable({
    timeout: 30_000,
    timeoutMsg: `render option ${optionLabel} never became clickable`,
  });
  // CustomDropdown commits on its public pointer down/up contract, not on a synthetic change.
  await browser.action('pointer')
    .move({ origin: option })
    .down({ button: 0 })
    .pause(75)
    .up({ button: 0 })
    .perform();
  const value = await button.$('.dropdown-value');
  await browser.waitUntil(async () => (
    (await value.getText()).trim().replace(/\s+/g, ' ') === optionLabel
  ), {
    timeout: 30_000,
    interval: 50,
    timeoutMsg: `render dropdown ${dropdownIndex} never selected ${optionLabel}`,
  });
  await menu.waitForExist({
    reverse: true,
    timeout: 30_000,
    interval: 50,
    timeoutMsg: `render dropdown ${dropdownIndex} left its old option portal mounted`,
  });
  return optionLabel;
};

const setRenderSettings = async ({
  root, resolution, resolutionOptionIndex, frameRate, frameRateOptionIndex, frameRatePrefix,
}) => {
  await chooseRenderSetting(0, resolutionOptionIndex, resolution);
  const frameRateLabel = await chooseRenderSetting(1, frameRateOptionIndex, frameRatePrefix);
  let observation = null;
  await waitUntilWithFreshDiagnostic(async () => {
    const scenes = durableRenderScenes(root);
    const durableScene = scenes.at(-1) ?? null;
    const latest = durableScene?.scene?.renderSettings ?? null;
    const surface = await queueSurface();
    observation = { durableScene, latest, labels: surface.settingLabels };
    return latest?.resolution === resolution
      && latest?.frameRate === frameRate
      && surface.settingLabels[0] === resolution
      && surface.settingLabels[1] === frameRateLabel;
  }, {
    timeout: 30_000,
    interval: 100,
    diagnostic: () => `render settings did not become durable: ${JSON.stringify(observation)}`,
  });
  return observation.durableScene;
};

const newJobsSince = (ledger, priorIds) => ledger.jobs.filter(({ id }) => !priorIds.has(id));

const safeArtifactPath = (root, artifact) => {
  const artifactRoot = resolve(root, 'data', 'artifacts');
  const path = resolve(artifactRoot, artifact.relative_path);
  const child = relative(artifactRoot, path);
  assert.ok(
    child.length > 0
      && child !== '..'
      && !child.startsWith(`..${sep}`)
      && !isAbsolute(child),
    `render artifact escaped the isolated artifact root: ${artifact.relative_path}`,
  );
  return path;
};

const fingerprint = (path) => {
  const bytes = readFileSync(path);
  return Object.freeze({
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
};

const assertManagedArtifactLedgerMatchesDisk = (root) => {
  const state = durableState(root);
  const artifactRoot = resolve(root, 'data', 'artifacts');
  const expected = [];
  for (const artifact of state.artifacts) {
    const path = safeArtifactPath(root, artifact);
    if (artifact.state === 'ready') {
      assert.ok(existsSync(path), `ready artifact ${artifact.id} has no managed bytes`);
      const metadata = lstatSync(path);
      assert.equal(metadata.isSymbolicLink(), false, `ready artifact ${artifact.id} is a symlink`);
      assert.equal(metadata.isFile(), true, `ready artifact ${artifact.id} is not a file`);
      assert.equal(
        metadata.size,
        artifact.size_bytes,
        `ready artifact ${artifact.id} byte count disagrees with its durable row`,
      );
      expected.push(relative(artifactRoot, path).split(sep).join('/'));
      continue;
    }
    assert.ok(
      artifact.state === 'pending' || artifact.state === 'failed',
      `artifact ${artifact.id} has an unknown durable state: ${artifact.state}`,
    );
    assert.equal(
      existsSync(path),
      false,
      `${artifact.state} artifact ${artifact.id} retained bytes that could look finished`,
    );
  }
  expected.sort();
  const actual = managedArtifactFiles(root)
    .map((path) => relative(artifactRoot, path).split(sep).join('/'))
    .sort();
  assert.deepEqual(
    actual,
    expected,
    'the artifact root does not exactly match the ready durable artifact ledger',
  );
};

const renderScratchEntries = (root) => {
  const scratch = join(root, 'cache', 'v1', 'render');
  if (!existsSync(scratch)) return [];
  const entries = [];
  const pending = [scratch];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      assert.equal(metadata.isSymbolicLink(), false, 'the render scratch root contains a symlink');
      entries.push(relative(scratch, path));
      if (metadata.isDirectory()) pending.push(path);
    }
  }
  return entries.sort();
};

const waitForStableCustomerExport = async (destination, before) => {
  let last = null;
  let exported = null;
  await browser.waitUntil(() => {
    const created = [...listMediaFiles(destination)].filter((path) => !before.has(path)).sort();
    assert.ok(created.length <= 1, `one customer save created multiple files: ${created.join(', ')}`);
    if (created.length === 0) return false;
    assert.ok(MEDIA_EXTENSIONS.has(extname(created[0]).toLowerCase()), (
      `the customer save created an unexpected file type: ${created[0]}`
    ));
    const stat = statSync(created[0]);
    if (!stat.isFile() || stat.size <= 0) return false;
    const current = { path: created[0], ...fingerprint(created[0]), modified: stat.mtimeMs };
    if (last !== null
        && last.path === current.path
        && last.sizeBytes === current.sizeBytes
        && last.modified === current.modified
        && last.sha256 === current.sha256) {
      exported = current.path;
      return true;
    }
    last = current;
    return false;
  }, {
    timeout: 120_000,
    interval: 150,
    timeoutMsg: 'the staged native save produced no single stable media file',
  });
  return exported;
};

/**
 * Freeze the real render preview at a cue-bearing instant and preserve both what the native
 * compositor published and the exact source frame underneath it.
 *
 * The source-only control is important: a cue index plus a large PNG can still describe a canvas
 * that accidentally contains only the source video. Hiding the already-published canvas for one
 * compositor screenshot exposes the paused `<video>` at the same instant and through the same crop,
 * so their bounded pixel delta proves that the preview actually added visible composition pixels.
 */
const captureRetryPreviewProof = async (root) => {
  const before = await browser.execute((selector) => {
    const canvas = document.querySelector(selector);
    const video = document.querySelector('.video-preview-panel video');
    if (canvas === null || video === null) return null;
    return {
      currentTime: video.currentTime,
      revision: Number(canvas.dataset.osgFrameRevision ?? 0),
    };
  }, RENDER_PREVIEW_CANVAS);
  assert.ok(before !== null, 'the render preview surface is incomplete before job B');

  await browser.execute((seconds) => {
    const video = document.querySelector('.video-preview-panel video');
    if (video === null) throw new Error('the render preview video is missing');
    video.pause();
    video.currentTime = seconds;
  }, COMPARE_AT_SECONDS);

  let published = null;
  const mustAdvance = Math.abs(before.currentTime - COMPARE_AT_SECONDS) >= 0.01;
  await waitUntilWithFreshDiagnostic(async () => {
    published = await browser.execute((selector) => {
      const canvas = document.querySelector(selector);
      const video = document.querySelector('.video-preview-panel video');
      if (canvas === null || video === null) return null;
      return {
        cue: canvas.dataset.osgCueIndex ?? '',
        currentTime: video.currentTime,
        paused: video.paused,
        seeking: video.seeking,
        revision: Number(canvas.dataset.osgFrameRevision ?? 0),
        viewportWidth: Number(canvas.dataset.osgViewportWidth),
        viewportHeight: Number(canvas.dataset.osgViewportHeight),
      };
    }, RENDER_PREVIEW_CANVAS);
    return published !== null
      && published.paused
      && !published.seeking
      && Math.abs(published.currentTime - COMPARE_AT_SECONDS) < 0.05
      && published.revision > 0
      && (!mustAdvance || published.revision > before.revision)
      && published.cue !== ''
      && published.viewportWidth > 0
      && published.viewportHeight > 0;
  }, {
    timeout: 120_000,
    interval: 100,
    diagnostic: () => (
      `the 360p retry preview never published its one-second subtitle frame: ${JSON.stringify(published)}`
    ),
  });

  const composed = join(root, 'evidence', 'retry-render-preview-at-1s.png');
  const sourceOnly = join(root, 'evidence', 'retry-render-source-at-1s.png');
  await savePreviewElementFrame(composed, RENDER_PREVIEW_CANVAS);

  const priorOpacity = await browser.execute((selector) => {
    const canvas = document.querySelector(selector);
    if (canvas === null) return null;
    const value = canvas.style.getPropertyValue('opacity');
    const priority = canvas.style.getPropertyPriority('opacity');
    canvas.style.setProperty('opacity', '0', 'important');
    return { value, priority };
  }, RENDER_PREVIEW_CANVAS);
  assert.ok(priorOpacity !== null, 'the render preview canvas disappeared before its source control');
  try {
    await savePreviewElementFrame(sourceOnly, RENDER_PREVIEW_CANVAS);
  } finally {
    await browser.execute((selector, previous) => {
      const canvas = document.querySelector(selector);
      if (canvas === null) return;
      if (previous.value === '') canvas.style.removeProperty('opacity');
      else canvas.style.setProperty('opacity', previous.value, previous.priority);
    }, RENDER_PREVIEW_CANVAS, priorOpacity);
  }

  const subtitlePixels = compareFramePixels(sourceOnly, composed, {
    channelDeltaThreshold: 24,
  });
  const minimumChangedPixels = Math.max(
    64,
    Math.floor(subtitlePixels.totalPixels * 0.0005),
  );
  assert.ok(
    subtitlePixels.changedPixels >= minimumChangedPixels
      && subtitlePixels.maximumChannelDelta >= 48,
    `the cue-bearing render preview added no substantial visible pixels: ${JSON.stringify(subtitlePixels)}`,
  );

  return Object.freeze({ composed, sourceOnly, published, subtitlePixels });
};

describe('customer render cancellation, retry, and export', () => {
  it('cancels exact job A, completes distinct job B, and decodes B output', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(root, 'the application must run against an isolated data root');
    assert.ok(destination, 'the native save destination must be staged');

    await openProjectWithMedia();
    await importSubtitles();
    await clickControl('.render-video-toggle');
    const section = await $('.video-rendering-section.expanded');
    await section.waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'the public video-rendering section never expanded',
    });
    const renderButton = await $(RENDER_BUTTON);
    await renderButton.waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'the public Render control never appeared',
    });
    assert.equal(await renderButton.isEnabled(), true, 'real media and cues did not enable Render');
    await installTransientRenderErrorLedger();

    // A broadly supported 1080p/30 request is large enough to expose cancellation on the real
    // nineteen-second source without making the proof depend on optional 120fps hardware support.
    const firstScene = await setRenderSettings({
      root,
      resolution: '1080p',
      resolutionOptionIndex: 3,
      frameRate: 30,
      frameRateOptionIndex: 2,
      frameRatePrefix: '30 FPS',
    });
    assert.match(firstScene.projectId, /^[a-f0-9]{32}$/, 'the durable project ID is malformed');
    const beforeFirst = readableRenderLedger(root);
    const beforeFirstIds = new Set(beforeFirst.jobs.map(({ id }) => id));
    await clickControl(RENDER_BUTTON);

    let first = null;
    let firstSurface = null;
    await waitUntilWithFreshDiagnostic(async () => {
      const ledger = readableRenderLedger(root);
      const created = newJobsSince(ledger, beforeFirstIds);
      assert.ok(created.length <= 1, `one Render click created multiple jobs: ${JSON.stringify(created)}`);
      [first = null] = created;
      firstSurface = await queueSurface();
      return first?.state === 'running'
        && firstSurface.rows.length === 1
        && firstSurface.rows[0].status === 'processing'
        && firstSurface.rows[0].current
        && firstSurface.rows[0].canCancel
        && firstSurface.rows[0].text.includes('1080p')
        && firstSurface.rows[0].text.includes('30fps');
    }, {
      timeout: 120_000,
      interval: 75,
      diagnostic: () => `the first render never exposed one owned running job: ${JSON.stringify({ first, firstSurface })}`,
    });
    assert.match(first.id, /^[a-f0-9]{32}$/, 'the durable render job ID is malformed');
    assertNoRenderFailure(firstSurface);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-first-native-job-running',
      description: 'The first public Render click owns one native 1080p/30fps job and one cancellable queue row.',
      details: { jobId: first.id, state: first.state, settings: ['1080p', 30] },
      focusSelector: '.video-rendering-section .queue-manager-panel',
    });

    // Evidence capture can take long enough for a short render to finish. Re-read both durable
    // ownership and the public row immediately before Cancel so the click cannot accidentally hit
    // a completed/reused row whose earlier screenshot happened to show it as running.
    const immediatelyBeforeCancel = readableRenderLedger(root);
    const immediatelyBeforeCancelSurface = await queueSurface();
    const exactBeforeCancel = immediatelyBeforeCancel.jobs.find(({ id }) => id === first.id);
    assert.equal(exactBeforeCancel?.state, 'running', 'job A completed before Cancel could own it');
    assert.equal(immediatelyBeforeCancelSurface.rows.length, 1, 'job A lost its sole queue row');
    assert.deepEqual(
      {
        status: immediatelyBeforeCancelSurface.rows[0].status,
        current: immediatelyBeforeCancelSurface.rows[0].current,
        canCancel: immediatelyBeforeCancelSurface.rows[0].canCancel,
      },
      { status: 'processing', current: true, canCancel: true },
      'job A was no longer the current cancellable row immediately before Cancel',
    );
    assertNoRenderFailure(immediatelyBeforeCancelSurface);
    const cancelButton = await $(
      '.video-rendering-section .queue-item.processing.current .cancel-btn',
    );
    assert.equal(await cancelButton.isDisplayed(), true, 'job A Cancel control is not visible');
    assert.equal(await cancelButton.isEnabled(), true, 'job A Cancel control is not enabled');
    await cancelButton.click();
    let cancelledLedger = null;
    let cancelledSurface = null;
    await waitUntilWithFreshDiagnostic(async () => {
      cancelledLedger = readableRenderLedger(root);
      cancelledSurface = await queueSurface();
      const exact = cancelledLedger.jobs.find(({ id }) => id === first.id);
      return exact?.state === 'cancelled'
        && cancelledSurface.rows.length === 1
        && cancelledSurface.rows[0].status === 'cancelled'
        && !cancelledSurface.rows[0].current
        && !cancelledSurface.rows[0].canCancel;
    }, {
      timeout: 120_000,
      interval: 100,
      diagnostic: () => `job A did not settle as the same cancelled row: ${JSON.stringify({ cancelledLedger, cancelledSurface })}`,
    });
    const cancelledArtifacts = cancelledLedger.artifacts.filter(
      ({ job_id: jobId }) => jobId === first.id,
    );
    assert.equal(
      cancelledArtifacts.some(({ state }) => state === 'ready'),
      false,
      'the cancelled render published a ready rendered-video artifact',
    );
    await waitUntilWithFreshDiagnostic(() => renderScratchEntries(root).length === 0, {
      timeout: 30_000,
      interval: 100,
      diagnostic: () => `cancelled render left scratch entries: ${renderScratchEntries(root).join(', ')}`,
    });
    assertManagedArtifactLedgerMatchesDisk(root);
    assertNoRenderFailure(cancelledSurface);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-exact-first-job-cancelled',
      description: 'The public Cancel control terminally cancelled job A without publishing ready bytes.',
      details: {
        jobId: first.id,
        artifactRows: cancelledArtifacts.length,
        artifactStates: cancelledArtifacts.map(({ state }) => state),
        readyArtifacts: 0,
      },
      focusSelector: '.video-rendering-section .queue-manager-panel',
    });

    // The shipped queue has no invented row-level Retry button. Retrying means pressing the same
    // public Render control again; lower settings make the successful verification bounded.
    const retryScene = await setRenderSettings({
      root,
      resolution: '360p',
      resolutionOptionIndex: 0,
      frameRate: 24,
      frameRateOptionIndex: 0,
      frameRatePrefix: '24 FPS',
    });
    assert.equal(retryScene.projectId, firstScene.projectId, (
      'changing render settings silently switched the active project'
    ));
    const previewProof = await captureRetryPreviewProof(root);
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'retry-render-preview-frame',
      source: previewProof.composed,
      description: 'The real 360p render preview compositor at the one-second cue instant.',
    });
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'retry-render-source-control',
      source: previewProof.sourceOnly,
      description: 'The paused source underneath that preview, proving the cue added visible pixels.',
    });
    const beforeRetry = readableRenderLedger(root);
    const beforeRetryIds = new Set(beforeRetry.jobs.map(({ id }) => id));
    await clickControl(RENDER_BUTTON);

    let retry = null;
    let retrySurface = null;
    await waitUntilWithFreshDiagnostic(async () => {
      const ledger = readableRenderLedger(root);
      const created = newJobsSince(ledger, beforeRetryIds);
      assert.ok(created.length <= 1, `one retry click created multiple jobs: ${JSON.stringify(created)}`);
      [retry = null] = created;
      retrySurface = await queueSurface();
      const retryRow = retrySurface.rows[0];
      const cancelledRow = retrySurface.rows[1];
      return retry !== null
        && retry.id !== first.id
        && ['running', 'succeeded'].includes(retry.state)
        && retrySurface.rows.length === 2
        && ['processing', 'completed'].includes(retryRow?.status)
        && retryRow.text.includes('360p')
        && retryRow.text.includes('24fps')
        && cancelledRow?.status === 'cancelled'
        && cancelledRow.text.includes('1080p')
        && cancelledRow.text.includes('30fps');
    }, {
      timeout: 120_000,
      interval: 100,
      diagnostic: () => `the public retry did not create a distinct owned job: ${JSON.stringify({ retry, retrySurface })}`,
    });
    assertNoRenderFailure(retrySurface);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-distinct-retry-job-admitted',
      description: 'Pressing Render again created distinct job B and retained cancelled job A as a separate row.',
      details: { cancelledJobId: first.id, retryJobId: retry.id, retryState: retry.state },
      focusSelector: '.video-rendering-section .queue-manager-panel',
    });

    let completedLedger = null;
    let completedSurface = null;
    let outputArtifact = null;
    await waitUntilWithFreshDiagnostic(async () => {
      completedLedger = readableRenderLedger(root);
      completedSurface = await queueSurface();
      const exactJob = completedLedger.jobs.find(({ id }) => id === retry.id);
      const artifacts = completedLedger.artifacts.filter(({ job_id: jobId }) => jobId === retry.id);
      [outputArtifact = null] = artifacts;
      return exactJob?.state === 'succeeded'
        && artifacts.length === 1
        && outputArtifact?.state === 'ready'
        && completedSurface.rows.length === 2
        && completedSurface.rows[0].status === 'completed'
        && completedSurface.rows[0].canDownload
        && completedSurface.rows[0].text.includes('360p')
        && completedSurface.rows[0].text.includes('24fps')
        && completedSurface.rows[1].status === 'cancelled';
    }, {
      timeout: TERMINAL_TIMEOUT_MS,
      interval: 500,
      diagnostic: () => `job B never completed with one owned artifact: ${JSON.stringify({ completedLedger, completedSurface })}`,
    });
    assert.equal(outputArtifact.project_id, firstScene.projectId, (
      'the successful render artifact belongs to another project'
    ));
    const finalCancelledArtifacts = completedLedger.artifacts.filter(
      ({ job_id: jobId }) => jobId === first.id,
    );
    assert.equal(
      finalCancelledArtifacts.some(({ state }) => state === 'ready'),
      false,
      'job A acquired ready output after cancellation',
    );
    const internalArtifact = safeArtifactPath(root, outputArtifact);
    assert.ok(existsSync(internalArtifact), 'the successful durable render artifact has no bytes');
    await waitUntilWithFreshDiagnostic(() => renderScratchEntries(root).length === 0, {
      timeout: 30_000,
      interval: 100,
      diagnostic: () => `completed render left scratch entries: ${renderScratchEntries(root).join(', ')}`,
    });
    assertManagedArtifactLedgerMatchesDisk(root);
    assertNoRenderFailure(completedSurface);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-retry-completed-with-owned-output',
      description: 'Job B alone reached Completed and owns one ready rendered-video artifact.',
      details: {
        jobId: retry.id,
        artifactId: outputArtifact.id,
        artifactBytes: outputArtifact.size_bytes,
      },
      focusSelector: '.video-rendering-section .queue-manager-panel',
    });

    const beforeCustomerSave = listMediaFiles(destination);
    await clickControl('.video-rendering-section .queue-item.completed .download-btn-success');
    const exported = await waitForStableCustomerExport(destination, beforeCustomerSave);
    const internalFingerprint = fingerprint(internalArtifact);
    const exportedFingerprint = fingerprint(exported);
    assert.deepEqual(
      exportedFingerprint,
      internalFingerprint,
      'the staged customer file is not byte-identical to job B output',
    );
    assert.equal(
      exportedFingerprint.sizeBytes,
      outputArtifact.size_bytes,
      'the exported byte count disagrees with the successful artifact row',
    );

    const probe = probeMedia(exported);
    const video = probe.streams.find(({ codec_type: type }) => type === 'video');
    const audio = probe.streams.find(({ codec_type: type }) => type === 'audio');
    const duration = Number(probe.format.duration);
    const selectedSource = process.env.OSG_E2E_MEDIA_SELECTION;
    assert.ok(selectedSource && existsSync(selectedSource), (
      'the staged source used by the real select-media boundary is unavailable to the oracle'
    ));
    const sourceProbe = probeMedia(selectedSource);
    const sourceVideo = sourceProbe.streams.find(({ codec_type: type }) => type === 'video');
    assert.ok(video && video.width > 0 && video.height === 360, (
      `the retry export does not contain the requested 360p video: ${JSON.stringify(probe)}`
    ));
    assert.ok(sourceVideo && sourceVideo.width > 0 && sourceVideo.height > 0, (
      `the independently probed staged source has no visible video: ${JSON.stringify(sourceProbe)}`
    ));
    const sourceAspect = sourceVideo.width / sourceVideo.height;
    const roundedWidth = Math.round(video.height * sourceAspect);
    const expectedEvenWidth = roundedWidth % 2 === 0 ? roundedWidth : roundedWidth + 1;
    assert.equal(
      video.width,
      expectedEvenWidth,
      `the 360p retry export changed the staged source aspect (${sourceVideo.width}x${sourceVideo.height})`,
    );
    assert.ok(audio, `the retry export has no audio stream: ${JSON.stringify(probe)}`);
    assert.ok(Number(probe.format.size) > 100_000, 'the retry export is implausibly small');
    assert.ok(
      Math.abs(duration - REAL_VIDEO.durationSeconds) <= REAL_VIDEO.durationToleranceSeconds,
      `the retry export duration ${duration}s does not match the real source`,
    );

    const decodedFrame = join(root, 'evidence', 'retry-export-at-1s.png');
    extractFrame(exported, COMPARE_AT_SECONDS, decodedFrame);
    assert.ok(statSync(decodedFrame).size > 1_000, 'independent decoding produced no visible frame');
    const previewExportSsim = compareFrames(previewProof.composed, decodedFrame);
    const sourceExportSsim = compareFrames(previewProof.sourceOnly, decodedFrame);
    assert.ok(
      previewExportSsim >= 0.95,
      `retry preview/export SSIM ${previewExportSsim} is below the 0.95 WYSIWYG floor`,
    );
    assert.ok(
      previewExportSsim > sourceExportSsim,
      'the decoded retry export is not closer to the cue-bearing render preview than to the '
        + `source-only control (${previewExportSsim} versus ${sourceExportSsim})`,
    );
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'retry-exported-video',
      source: exported,
      description: 'Customer-saved job B output, byte-matched to its durable artifact and independently probed.',
    });
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'retry-decoded-frame',
      source: decodedFrame,
      description: 'FFmpeg-decoded frame from the saved retry output at the matched preview instant.',
    });
    assertNoRenderFailure(await queueSurface());
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-customer-export-independently-decoded',
      description: 'Job B is byte-owned, source-aspect-correct, and its decoded cue matches the real render preview.',
      details: {
        jobId: retry.id,
        artifactId: outputArtifact.id,
        sha256: exportedFingerprint.sha256,
        sizeBytes: exportedFingerprint.sizeBytes,
        durationSeconds: duration,
        dimensions: [video.width, video.height],
        sourceDimensions: [sourceVideo.width, sourceVideo.height],
        previewExportSsim,
        sourceExportSsim,
        previewCompositionChangedPixels: previewProof.subtitlePixels.changedPixels,
      },
      focusSelector: '.video-rendering-section .queue-manager-panel',
    });
  });
});

async function waitUntilWithFreshDiagnostic(predicate, { diagnostic, ...options }) {
  try {
    return await browser.waitUntil(predicate, {
      ...options,
      timeoutMsg: 'condition did not settle before its timeout',
    });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
}
