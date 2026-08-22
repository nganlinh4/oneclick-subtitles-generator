// A customer renders the project they can see, saves it, and gets a real independently decodable MP4.

import { strict as assert } from 'node:assert';
import { join } from 'node:path';

import { clickControl } from '../support/editor.js';
import {
  compareFrames,
  extractFrame,
  listMediaFiles,
  newestMediaFile,
  probeMedia,
  saveNativePreviewFrame,
  savePreviewElementFrame,
} from '../support/nativeMediaOracle.js';
import { REAL_VIDEO } from '../support/realMedia.js';
import {
  importSubtitles,
  openProjectWithMedia,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const COMPARE_AT_SECONDS = 1;
const WORKFLOW = 'native-export-decoded';

describe('a customer exports the subtitled video they previewed', () => {
  it('writes a native MP4 whose decoded frame matches the editor preview', async () => {
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(destination, 'the save-dialog destination must be staged');
    assert.ok(root, 'the application must run in an isolated root');

    await openProjectWithMedia();
    await importSubtitles();

    const oldFrameRevision = await browser.execute(
      () => document.querySelector('.video-preview [data-osg-preview-engine="canvas-atlas"]')
        ?.getAttribute('data-osg-frame-revision') ?? null,
    );
    await seekPreviewTo(COMPARE_AT_SECONDS);
    await waitForCanvasSubtitleFrame(120_000);
    const cueRevision = await browser.execute(
      () => document.querySelector('.video-preview [data-osg-preview-engine="canvas-atlas"]')
        ?.getAttribute('data-osg-frame-revision') ?? null,
    );
    assert.notEqual(
      cueRevision,
      oldFrameRevision,
      'the editor did not publish the requested comparison frame',
    );

    await clickControl('.render-video-toggle');
    const controls = await $('.video-rendering-section.expanded .native-render-controls');
    await controls.waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'the expanded native render preview never published its player controls',
    });
    // Default styling alone would leave border, glow and text shadow unproved. Neon uses the
    // reviewed Arial face and exercises all three while remaining available on a clean Windows
    // profile; the same selected style flows into both the editor canvas and native export.
    const neonPreset = await $('//div[contains(@class,"preset-buttons")]'
      + '//button[normalize-space(.)="Neon"]');
    await neonPreset.waitForClickable({ timeout: 30_000 });
    const renderCanvasBefore = await browser.execute(() => {
      const canvas = document.querySelector(
        '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]',
      );
      return {
        revision: canvas?.dataset.osgFrameRevision ?? null,
        overlayRebuilds: Number(canvas?.dataset.osgOverlayRebuilds ?? 0),
      };
    });
    await neonPreset.click();
    await browser.execute((seconds) => {
      const video = document.querySelector('.video-preview-panel video');
      if (video === null) throw new Error('the render preview video is missing');
      video.pause();
      video.currentTime = seconds;
    }, COMPARE_AT_SECONDS);
    let styledRevision = null;
    await browser.waitUntil(async () => {
      styledRevision = await browser.execute(() => {
        const canvas = document.querySelector(
          '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]',
        );
        return {
          revision: canvas?.dataset.osgFrameRevision ?? null,
          cue: canvas?.dataset.osgCueIndex ?? null,
          overlayRebuilds: Number(canvas?.dataset.osgOverlayRebuilds ?? 0),
        };
      });
      return styledRevision.revision !== null
        && styledRevision.revision !== renderCanvasBefore.revision
        && styledRevision.cue !== ''
        && styledRevision.overlayRebuilds > renderCanvasBefore.overlayRebuilds;
    }, {
      timeout: 120_000,
      interval: 250,
      timeoutMsg: () => `the Neon preset never reached preview pixels: ${JSON.stringify(styledRevision)}`,
    });
    const previewPath = join(root, 'evidence', 'preview-at-1s.png');
    await savePreviewElementFrame(
      previewPath,
      '.video-preview-panel canvas[data-osg-preview-engine="canvas-atlas"]',
    );
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'native-preview-frame',
      source: previewPath,
      description: 'Canvas-atlas Neon preview frame at the one-second comparison instant.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-preview-ready',
      description: 'The border, glow, shadow, background and glyph atlas are canvas-composited.',
      details: { preset: 'neon' },
      focusSelector: '.video-preview .video-container',
    });
    const playerControls = await browser.execute(() => ({
      play: document.querySelector('.native-render-controls [data-osg-control="play-pause"]') !== null,
      seek: document.querySelector('.native-render-controls [data-osg-control="seek"]') !== null,
      mute: document.querySelector('.native-render-controls [data-osg-control="mute"]') !== null,
      fullscreen: document.querySelector('.native-render-controls [data-osg-control="fullscreen"]') !== null,
      inlineError: document.querySelector('.video-preview-panel .error') !== null,
    }));
    assert.deepEqual(playerControls, {
      play: true, seek: true, mute: true, fullscreen: true, inlineError: false,
    }, `the native render preview lost its customer controls: ${JSON.stringify(playerControls)}`);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-render-preview-controls',
      description: 'The native render preview visibly retains play, seek, mute and fullscreen controls.',
      details: playerControls,
      focusSelector: '.video-preview-panel',
    });
    // The current rebuilt binary predates the stable data attribute by one narrow UI edit, so the
    // icon is retained as a compatibility selector for this red-to-green run. Future binaries use
    // data-osg-action and both forms identify the same visible control.
    const renderSelector = '//*[contains(@class,"video-rendering-section") and contains(@class,"expanded")]'
      + '//button[@data-osg-action="render-video" or .//span[normalize-space(.)="desktop_windows"]]';
    const renderButton = await $(renderSelector);
    await renderButton.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the render controls did not open' });
    assert.equal(
      await renderButton.isEnabled(),
      true,
      'Render must be enabled when the selected media has imported subtitles',
    );

    // Opening the rendering section may surface unrelated retained notices (for example an optional
    // narration engine that is not selected). Clear the visible history before the admission click
    // so only a refusal CAUSED by Render can satisfy the diagnostic branch below.
    await browser.execute(() => {
      for (const close of document.querySelectorAll('.toast-item.live .close-icon')) close.click();
    });
    await browser.waitUntil(async () => (await browser.execute(
      () => document.querySelectorAll('.toast-item.live .toast').length,
    )) === 0, { timeout: 10_000, interval: 100, timeoutMsg: 'old notices did not dismiss' });

    await clickControl(renderSelector);
    await browser.pause(5_000);
    const admission = await browser.execute(() => ({
        queue: [...document.querySelectorAll('.video-rendering-section .queue-item')]
          .map((node) => ({
            className: node.className,
            text: (node.innerText || '').trim().slice(0, 1_000),
          })),
        toasts: [...document.querySelectorAll('.toast-item.live .toast')]
          .map((node) => (node.innerText || '').trim()).filter(Boolean),
        alerts: [...document.querySelectorAll('.error, [role="alert"]')]
          .map((node) => (node.innerText || '').trim()).filter(Boolean).slice(0, 8),
        admission: document.querySelector('[data-osg-render-admission]')?.getAttribute(
          'data-osg-render-admission',
        ) ?? null,
      }));
    assert.ok(
      admission.queue.length > 0 || admission.toasts.length > 0,
      `Render produced no job and no refusal: ${JSON.stringify(admission)}`,
    );
    assert.deepEqual(admission.toasts, [], `Render was refused before admission: ${JSON.stringify(admission)}`);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-render-admitted',
      description: 'The visible render queue accepted the project without an admission refusal.',
      details: { admission: admission.admission, queueItems: admission.queue.length },
      focusSelector: '.video-rendering-section',
    });

    const terminal = await $('.video-rendering-section .queue-item.completed, '
      + '.video-rendering-section .queue-item.failed');
    await terminal.waitForDisplayed({
      timeout: 600_000,
      timeoutMsg: 'the native render job never reached a visible terminal state',
    });
    const terminalState = await terminal.getAttribute('class');
    const terminalText = (await terminal.getText()).slice(0, 2_000);
    assert.match(
      terminalState,
      /(?:^|\s)completed(?:\s|$)/,
      `the native render did not complete: ${terminalText}`,
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-render-complete',
      description: 'The native render reached a visible successful terminal state.',
      details: { terminalText },
      focusSelector: '.video-rendering-section',
    });

    const before = listMediaFiles(destination);
    await clickControl('.video-rendering-section .queue-item.completed .download-btn-success');
    let exported = null;
    await browser.waitUntil(() => {
      exported = newestMediaFile(destination, before);
      return exported !== null;
    }, {
      timeout: 120_000,
      interval: 1_000,
      timeoutMsg: 'the completed native render was not written to the staged user destination',
    });

    const probe = probeMedia(exported);
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
    const duration = Number(probe.format.duration);
    assert.ok(video, `the exported file has no video stream: ${JSON.stringify(probe)}`);
    assert.ok(audio, `the exported file has no audio stream: ${JSON.stringify(probe)}`);
    assert.ok(video.width > 0 && video.height > 0, 'the video stream must have visible dimensions');
    assert.ok(Number(probe.format.size) > 100_000, 'the exported file is implausibly small');
    assert.ok(
      Math.abs(duration - REAL_VIDEO.durationSeconds) <= REAL_VIDEO.durationToleranceSeconds,
      `the exported duration ${duration}s does not match the ${REAL_VIDEO.durationSeconds}s source`,
    );

    const exportFramePath = join(root, 'evidence', 'export-at-1s.png');
    extractFrame(exported, COMPARE_AT_SECONDS, exportFramePath);
    const ssim = compareFrames(previewPath, exportFramePath);
    assert.ok(ssim >= 0.95, `preview/export SSIM ${ssim} is below the 0.95 WYSIWYG floor`);
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'exported-video',
      source: exported,
      description: 'The native MP4 independently probed and decoded by the workflow.',
    });
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'decoded-export-frame',
      source: exportFramePath,
      description: 'Independently decoded exported frame at the same one-second instant.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-export-verified',
      description: 'The saved MP4 has independently verified video/audio streams and matches the preview.',
      details: { durationSeconds: duration, ssim, exportedBytes: Number(probe.format.size) },
    });
  });
});
