// Continuous playback must stay on the WebView's direct video -> canvas path without starving input.

import { strict as assert } from 'node:assert';

import {
  importSubtitles,
  openProjectWithMedia,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'canvas-playback-performance';
const SAMPLE_MS = 6_000;

describe('continuous subtitle preview playback', () => {
  it('tracks real source frames without long tasks or runaway heap growth', async () => {
    await openProjectWithMedia();
    await importSubtitles();
    await seekPreviewTo(0.8);
    await waitForCanvasSubtitleFrame(30_000);

    const started = await browser.execute(async () => {
      const video = document.querySelector('.video-preview video.video-player');
      const canvas = document.querySelector(
        '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
      );
      if (video === null || canvas === null) throw new Error('the preview surface is incomplete');
      const sample = {
        active: true,
        animationFrames: 0,
        longTasks: [],
        startedAt: performance.now(),
        mediaStartedAt: video.currentTime,
        revisionStartedAt: Number(canvas.dataset.osgFrameRevision ?? 0),
        overlayRebuildsStartedAt: Number(canvas.dataset.osgOverlayRebuilds ?? 0),
        heapStartedAt: Number(performance.memory?.usedJSHeapSize ?? Number.NaN),
      };
      if (typeof PerformanceObserver === 'function'
          && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        sample.observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) sample.longTasks.push(entry.duration);
        });
        sample.observer.observe({ type: 'longtask', buffered: false });
      }
      const tick = () => {
        if (!sample.active) return;
        sample.animationFrames += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      window.__OSG_PLAYBACK_SAMPLE__ = sample;
      video.muted = true;
      await video.play();
      return {
        mediaTime: video.currentTime,
        revision: sample.revisionStartedAt,
      };
    });

    await browser.pause(SAMPLE_MS);

    const result = await browser.execute(() => {
      const sample = window.__OSG_PLAYBACK_SAMPLE__;
      const video = document.querySelector('.video-preview video.video-player');
      const canvas = document.querySelector(
        '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
      );
      if (sample === undefined || video === null || canvas === null) {
        throw new Error('the playback sample disappeared');
      }
      sample.active = false;
      sample.observer?.disconnect();
      video.pause();
      const elapsedMs = performance.now() - sample.startedAt;
      const heapNow = Number(performance.memory?.usedJSHeapSize ?? Number.NaN);
      return {
        elapsedMs,
        mediaAdvancedSeconds: video.currentTime - sample.mediaStartedAt,
        compositorFrames: Number(canvas.dataset.osgFrameRevision ?? 0) - sample.revisionStartedAt,
        overlayRebuilds: Number(canvas.dataset.osgOverlayRebuilds ?? 0)
          - sample.overlayRebuildsStartedAt,
        animationFrames: sample.animationFrames,
        longTaskCount: sample.longTasks.length,
        maxLongTaskMs: sample.longTasks.length === 0 ? 0 : Math.max(...sample.longTasks),
        totalLongTaskMs: sample.longTasks.reduce((sum, duration) => sum + duration, 0),
        heapGrowthBytes: Number.isFinite(heapNow) && Number.isFinite(sample.heapStartedAt)
          ? heapNow - sample.heapStartedAt
          : null,
        canvas: [canvas.width, canvas.height],
        previewState: document.querySelector('[data-osg-preview]')
          ?.getAttribute('data-osg-preview') ?? null,
      };
    });

    assert.ok(result.elapsedMs >= SAMPLE_MS * 0.9, `sample clock ran short: ${JSON.stringify(result)}`);
    assert.ok(
      result.mediaAdvancedSeconds >= 5,
      `playback failed to advance in real time: ${JSON.stringify({ started, result })}`,
    );
    // The real source is 15 fps. Allow decode jitter, but require substantially more than the old
    // 10 fps IPC/PNG scheduler could publish under ideal conditions.
    assert.ok(result.compositorFrames >= 70, `too few real video frames reached canvas: ${JSON.stringify(result)}`);
    assert.ok(result.maxLongTaskMs < 500, `one preview task froze the UI: ${JSON.stringify(result)}`);
    assert.ok(result.totalLongTaskMs < 1_000, `preview monopolised the UI thread: ${JSON.stringify(result)}`);
    assert.ok(
      result.overlayRebuilds <= 4,
      `static subtitle paint was repeatedly rebuilt during playback: ${JSON.stringify(result)}`,
    );
    if (result.heapGrowthBytes !== null) {
      assert.ok(
        result.heapGrowthBytes < 64 * 1024 * 1024,
        `six seconds of preview grew the JS heap excessively: ${JSON.stringify(result)}`,
      );
    }
    assert.notEqual(result.previewState, 'refused');

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-continuous-playback',
      description: 'A real 15 fps video plays continuously through two subtitle cues on the canvas-atlas path.',
      details: result,
      focusSelector: '.video-preview .video-container',
    });
  });
});
