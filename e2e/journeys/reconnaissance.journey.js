// TEMPORARY DIAGNOSTIC (replaces the control-survey probe; original preserved in the session
// scratchpad). Reproduces the localAsrGeneration compositor stick without the engine: import
// cues, let the paused editor go quiescent, seek into a cue, and if the canvas never reaches
// `ready`, record which wakeups fired and whether a nudge seek recovers it.

import { openProjectWithMedia, importSubtitles, seekPreviewTo } from '../support/workflow.js';

/* global browser, console, describe, document, it, MutationObserver */

const canvasState = () => browser.execute(() => {
  const surface = document.querySelector('.video-preview canvas[data-osg-preview-engine="canvas-atlas"]');
  const video = document.querySelector('.video-preview video.video-player');
  return {
    state: document.querySelector('.video-preview [data-osg-preview]')?.getAttribute('data-osg-preview') ?? null,
    revision: surface?.dataset.osgFrameRevision ?? null,
    cue: surface?.dataset.osgCueIndex ?? null,
    probes: window.__OSG_PROBE__ ?? null,
    video: video === null ? null : {
      currentTime: video.currentTime,
      paused: video.paused,
      readyState: video.readyState,
      seeking: video.seeking,
    },
  };
});

const pollUntilReadyOr = async (milliseconds) => {
  const deadline = Date.now() + milliseconds;
  let last = await canvasState();
  while (Date.now() < deadline && last.state !== 'ready') {
    await browser.pause(250);
    last = await canvasState();
  }
  return last;
};

describe('canvas stick reconnaissance', () => {
  it('measures wakeups around a paused seek into a cue', async () => {
    await openProjectWithMedia();
    await importSubtitles();

    await browser.execute(() => {
      const video = document.querySelector('.video-preview video.video-player');
      const surface = document.querySelector('.video-preview canvas[data-osg-preview-engine="canvas-atlas"]');
      const probe = { seeked: 0, rvfc: 0, revisions: [], states: [] };
      window.__OSG_PROBE__ = probe;
      video.addEventListener('seeked', () => { probe.seeked += 1; });
      const arm = () => video.requestVideoFrameCallback(() => { probe.rvfc += 1; arm(); });
      if (typeof video.requestVideoFrameCallback === 'function') arm();
      const observer = new MutationObserver(() => {
        probe.revisions.push(surface?.dataset.osgFrameRevision ?? null);
      });
      if (surface !== null) observer.observe(surface, { attributes: true });
      const stateNode = document.querySelector('.video-preview [data-osg-preview]');
      const stateObserver = new MutationObserver(() => {
        probe.states.push(stateNode?.getAttribute('data-osg-preview') ?? null);
      });
      if (stateNode !== null) {
        stateObserver.observe(stateNode, { attributes: true, attributeFilter: ['data-osg-preview'] });
      }
    });

    console.log(`=== after import ===\n${JSON.stringify(await canvasState())}`);
    // Let post-import scene churn settle the way the long ASR phase does.
    await browser.pause(20_000);
    console.log(`=== after quiescence ===\n${JSON.stringify(await canvasState())}`);

    await seekPreviewTo(1.75);
    const afterSeek = await pollUntilReadyOr(15_000);
    console.log(`=== after seek(1.75) ===\n${JSON.stringify(afterSeek)}`);

    if (afterSeek.state !== 'ready') {
      await browser.execute(() => {
        const video = document.querySelector('.video-preview video.video-player');
        video.currentTime += 0.01;
      });
      const afterNudge = await pollUntilReadyOr(5_000);
      console.log(`=== after nudge ===\n${JSON.stringify(afterNudge)}`);
    }
  });
});
