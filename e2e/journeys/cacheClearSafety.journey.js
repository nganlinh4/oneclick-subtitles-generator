// Clearing Settings cache must remove only product-created, rebuildable native cache entries. The
// active project, subtitle track, render scene and every byte of its source media remain
// byte-identical. Activation must materialize Rust's revision-zero virtual default before the
// preview becomes ready, so even an untouched project's appearance is durable across upgrades.

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { cacheSafetySnapshot, fingerprintFile } from '../support/cacheSafetyOracle.js';
import { clickControl } from '../support/editor.js';
import {
  importSubtitles,
  openProjectWithMedia,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'cache-clear-safety';

/* global $, browser, describe, document, it, MutationObserver, window */

const previewState = () => browser.execute(() => {
  const video = document.querySelector('.video-preview video.video-player');
  const canvas = document.querySelector(
    '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
  );
  return {
    video: video === null ? null : {
      duration: Number.isFinite(video.duration) ? video.duration : null,
      currentTime: video.currentTime,
      readyState: video.readyState,
      width: video.videoWidth,
      height: video.videoHeight,
      error: video.error?.code ?? null,
    },
    canvas: canvas === null ? null : {
      revision: Number(canvas.dataset.osgFrameRevision ?? 0),
      cue: canvas.dataset.osgCueIndex ?? null,
      width: canvas.width,
      height: canvas.height,
    },
    previewReadiness: document.querySelector('.video-preview [data-osg-preview]')
      ?.getAttribute('data-osg-preview') ?? null,
    waveformState: document.querySelector('[data-osg-waveform-state]')
      ?.getAttribute('data-osg-waveform-state') ?? null,
    cueTexts: [...document.querySelectorAll('.lyric-text')]
      .map((node) => (node.innerText || '').trim()).filter(Boolean),
    visibleErrors: [...document.querySelectorAll('.error, [role="alert"]')]
      .filter((node) => node.getClientRects().length > 0)
      .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 8),
  };
});

const cacheSurface = () => browser.execute(() => {
  const section = document.querySelector('.cache-section');
  return {
    state: section?.getAttribute('data-cache-state') ?? null,
    summary: section?.querySelector('.cache-total')?.innerText?.trim() ?? null,
    categories: [...(section?.querySelectorAll('[data-cache-category]') ?? [])]
      .map((node) => ({
        category: node.getAttribute('data-cache-category'),
        text: (node.innerText || '').trim(),
      })),
    successToasts: [...document.querySelectorAll('.toast-success p')]
      .map((node) => (node.innerText || '').trim()).filter(Boolean),
    errorToasts: [...document.querySelectorAll('.toast-error p')]
      .map((node) => (node.innerText || '').trim()).filter(Boolean),
  };
});

const liveToastLayout = () => browser.execute(() => {
  const asRect = (node) => {
    if (node === null) return null;
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height,
    };
  };
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    historyButton: asRect(document.querySelector('.toast-history-button')),
    toasts: [...document.querySelectorAll('.toast-item.live .toast')]
      .map((node) => ({ message: (node.innerText || '').trim(), rect: asRect(node) })),
  };
});

const rectanglesOverlap = (left, right) => (
  left.left < right.right && left.right > right.left
  && left.top < right.bottom && left.bottom > right.top
);

const toastLayoutIsSettled = ({ viewport, historyButton, toasts }) => (
  toasts.length > 0
  && toasts.every(({ rect }) => (
    rect.left >= 0 && rect.top >= 0
    && rect.right <= viewport.width && rect.bottom <= viewport.height
    && (historyButton === null || !rectanglesOverlap(rect, historyButton))
  ))
);

describe('cache clear preserves the active customer project', () => {
  it('clears only real native cache entries and keeps media, subtitles and scene byte-identical', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const stagedSource = process.env.OSG_E2E_MEDIA_SELECTION;
    assert.ok(root, 'the application must run in an isolated data root');
    assert.ok(stagedSource, 'the real-media selection must be staged inside the isolated root');

    await openProjectWithMedia();
    await importSubtitles();
    await seekPreviewTo(1);
    await waitForCanvasSubtitleFrame(120_000);
    let waveformWitness = null;
    try {
      await browser.waitUntil(async () => {
        waveformWitness = await previewState();
        return waveformWitness.waveformState === 'ready';
      }, {
        timeout: 120_000,
        interval: 200,
        timeoutMsg: 'the product never published a native waveform',
      });
    } catch (error) {
      throw new Error(
        `the product never published a native waveform: ${JSON.stringify(waveformWitness)}`,
        { cause: error },
      );
    }

    const sourceBefore = fingerprintFile(stagedSource);
    const before = cacheSafetySnapshot(root);
    assert.ok(before.protectedState.active.active_media_id, 'the project has no active media');
    assert.ok(before.protectedState.active.active_track_id, 'the project has no active subtitle track');
    assert.ok(before.protectedState.renderScene, 'the ready preview has no durable render scene');
    assert.ok(before.protectedState.cues.length >= 3, 'the imported subtitle track is incomplete');
    const createdWaveforms = before.cacheEntries.filter((entry) => (
      entry.category === 'waveform'
      && entry.kind === 'waveformCache'
      && entry.retention === 'cache'
      && entry.state === 'ready'
      && entry.media_owned === 0
      && entry.artifactExists
    ));
    assert.ok(createdWaveforms.length > 0,
      `the ready waveform created no disposable native cache artifact: ${JSON.stringify(before.cacheEntries)}`);
    for (const location of before.protectedState.locations) {
      assert.equal(location.sha256, sourceBefore.sha256,
        `an active media location disagrees with the selected source bytes: ${location.path}`);
      assert.equal(location.sizeBytes, before.protectedState.media.size_bytes,
        `an active media location has the wrong size: ${location.path}`);
    }

    const initialPreview = await previewState();
    assert.equal(initialPreview.previewReadiness, 'ready');
    assert.deepEqual(initialPreview.visibleErrors, []);
    assert.ok(initialPreview.canvas?.revision > 0, 'the native subtitle frame is absent');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-active-project-before-clear',
      description: 'Real media, imported subtitles and the native scene are active before cache management.',
      details: {
        projectId: before.protectedState.active.project_id,
        mediaContentBlake3: before.protectedState.media.content_hash,
        sourceSha256: sourceBefore.sha256,
        renderSceneRecordPresent: before.protectedState.renderScene !== null,
        cueCount: before.protectedState.cues.length,
        nativeCacheEntryCount: before.cacheEntries.length,
        nativeWaveformCacheCount: createdWaveforms.length,
      },
      focusSelector: '.preview-section',
    });

    await clickControl('[data-app-action="open-settings"]');
    await $('.settings-modal').waitForDisplayed({
      timeout: 30_000,
      timeoutMsg: 'Settings did not open for cache management',
    });
    await clickControl('[data-settings-tab="cache"]');
    await browser.waitUntil(async () => (await cacheSurface()).state === 'ready', {
      timeout: 60_000,
      interval: 100,
      timeoutMsg: 'the native cache inventory never settled',
    });
    const cacheBefore = await cacheSurface();
    const inventoried = cacheSafetySnapshot(root);
    assert.deepEqual(inventoried.protectedState, before.protectedState,
      'opening the native cache inventory changed protected project state');
    assert.deepEqual(cacheBefore.errorToasts, [], 'cache inspection showed an error');
    assert.equal(cacheBefore.categories.length, new Set(
      inventoried.cacheEntries.map(({ category }) => category),
    ).size, 'the cache grid does not match SQLite categories');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-native-cache-before-clear',
      description: 'Settings reports only the native cache categories that actually exist.',
      details: {
        summary: cacheBefore.summary,
        categories: cacheBefore.categories.map(({ category }) => category),
        cacheEntryCount: inventoried.cacheEntries.length,
      },
      focusSelector: '.settings-modal',
    });

    await browser.execute(() => {
      const section = document.querySelector('.cache-section');
      if (section === null) throw new Error('the cache surface disappeared before clearing');
      window.__OSG_E2E_CACHE_CLEAR_WITNESS__ = {
        states: [section.getAttribute('data-cache-state')],
      };
      const observer = new MutationObserver((records) => {
        const state = section.getAttribute('data-cache-state');
        const states = window.__OSG_E2E_CACHE_CLEAR_WITNESS__.states;
        for (const record of records) {
          if (record.oldValue !== null && states.at(-1) !== record.oldValue) {
            states.push(record.oldValue);
          }
        }
        if (states.at(-1) !== state) states.push(state);
      });
      observer.observe(section, {
        attributes: true,
        attributeFilter: ['data-cache-state'],
        attributeOldValue: true,
      });
      window.__OSG_E2E_CACHE_CLEAR_OBSERVER__ = observer;
    });
    await clickControl('.clear-cache-btn');

    let clearWitness = null;
    try {
      await browser.waitUntil(async () => {
        const surface = await cacheSurface();
        clearWitness = await browser.execute(() => ({
          states: [...(window.__OSG_E2E_CACHE_CLEAR_WITNESS__?.states ?? [])],
        }));
        return surface.state === 'ready'
          && clearWitness.states.includes('clearing')
          && surface.successToasts.length > 0;
      }, {
        timeout: 60_000,
        interval: 100,
        timeoutMsg: 'the compiled cache-clear command did not complete',
      });
    } catch (error) {
      throw new Error(
        `the compiled cache-clear command did not complete: ${JSON.stringify({ clearWitness })}`,
        { cause: error },
      );
    }
    await browser.execute(() => {
      window.__OSG_E2E_CACHE_CLEAR_OBSERVER__?.disconnect();
      delete window.__OSG_E2E_CACHE_CLEAR_OBSERVER__;
    });

    const after = cacheSafetySnapshot(root);
    const sourceAfter = fingerprintFile(stagedSource);
    assert.deepEqual(after.protectedState, before.protectedState,
      'Clear Cache changed durable project, track, scene or media ownership');
    assert.deepEqual(sourceAfter, sourceBefore, 'Clear Cache changed the staged source bytes');
    assert.equal(after.cacheEntries.length, 0, 'Clear Cache left an unleased native cache entry');

    const disposableBefore = inventoried.cacheEntries.filter((entry) => (
      entry.retention === 'cache' && entry.media_owned === 0
    ));
    assert.ok(disposableBefore.length > 0,
      'Clear Cache cannot pass without a product-created disposable entry');
    const deletedDisposables = disposableBefore.map((entry) => ({
      artifactId: entry.artifact_id,
      databaseRowRemoved: !after.artifacts.some(({ id }) => id === entry.artifact_id),
      bytesRemoved: !existsSync(join(root, 'data', 'artifacts', entry.relative_path)),
    }));
    assert.ok(deletedDisposables.every(({ databaseRowRemoved, bytesRemoved }) => (
      databaseRowRemoved && bytesRemoved
    )), `Clear Cache left disposable artifact ownership or bytes: ${JSON.stringify(deletedDisposables)}`);
    const deletionProof = 'proved-database-row-and-bytes-removed-from-product-created-entry';
    // A live toast deliberately enters from translateX(100%) over 500 ms. Seeing its text is not
    // proof that this animation has settled: an immediate bounding-box read observes the intended
    // off-viewport start position and mistakes motion for a permanent clipping defect. Wait only
    // for the bounded customer-visible resting state; broken positioning or an overlapping history
    // control still remains red after the animation deadline.
    let toastLayout = null;
    try {
      await browser.waitUntil(async () => {
        toastLayout = await liveToastLayout();
        return toastLayoutIsSettled(toastLayout);
      }, {
        timeout: 2_000,
        interval: 50,
        timeoutMsg: 'live toasts never settled inside the viewport',
      });
    } catch (error) {
      throw new Error(
        `live toasts never settled inside the viewport: ${JSON.stringify(toastLayout)}`,
        { cause: error },
      );
    }
    assert.ok(toastLayout.toasts.length > 0, 'cache completion did not publish a toast');
    for (const toast of toastLayout.toasts) {
      assert.ok(toast.rect.left >= 0 && toast.rect.top >= 0
        && toast.rect.right <= toastLayout.viewport.width
        && toast.rect.bottom <= toastLayout.viewport.height,
      `a live toast escaped the viewport: ${JSON.stringify(toast)}`);
      if (toastLayout.historyButton !== null) {
        assert.equal(rectanglesOverlap(toast.rect, toastLayout.historyButton), false,
          `the toast-history control covers a live notice: ${JSON.stringify(toast)}`);
      }
    }
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-cache-clear-completed',
      description: 'The compiled cache command completed while every protected SQLite identity and source byte remained unchanged.',
      details: {
        deletionProof,
        deletedDisposables,
        entriesAfter: after.cacheEntries.length,
        stateTransitions: clearWitness.states,
        toastLayout,
      },
      focusSelector: '.settings-modal',
    });

    await clickControl('[data-settings-action="close"]');
    await $('.settings-modal').waitForDisplayed({
      reverse: true,
      timeout: 30_000,
      timeoutMsg: 'Settings did not close after cache clearing',
    });
    const revisionBeforeSeek = initialPreview.canvas.revision;
    await seekPreviewTo(4);
    let restoredPreview = null;
    try {
      await browser.waitUntil(async () => {
        restoredPreview = await previewState();
        return restoredPreview.previewReadiness === 'ready'
          && restoredPreview.video?.error === null
          && Math.abs((restoredPreview.video?.currentTime ?? -1) - 4) < 0.25
          && restoredPreview.canvas?.revision > revisionBeforeSeek
          && restoredPreview.cueTexts.includes('Second cue, plain text only');
      }, {
        timeout: 120_000,
        interval: 250,
        timeoutMsg: 'the active project did not remain usable after cache clear',
      });
    } catch (error) {
      throw new Error(
        `the active project did not remain usable after cache clear: ${JSON.stringify(restoredPreview)}`,
        { cause: error },
      );
    }
    assert.deepEqual(restoredPreview.visibleErrors, [], 'the preserved project shows an error');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-project-still-playable-after-clear',
      description: 'After Settings closes, the same video seeks and the same subtitle track draws a new native frame.',
      details: {
        projectId: after.protectedState.active.project_id,
        mediaContentBlake3: after.protectedState.media.content_hash,
        sourceSha256: sourceAfter.sha256,
        frameRevision: restoredPreview.canvas.revision,
        deletionProof,
      },
      focusSelector: '.preview-section',
    });
  });
});
