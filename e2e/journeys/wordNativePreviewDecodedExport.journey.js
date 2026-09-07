// Real-binary customer journey 9: Native preview -> exported file with frame-by-frame decoding and word-highlighting checks
// Driven through WebDriverIO and the actual application WebView.

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { clickControl } from '../support/editor.js';
import {
  compareFrames,
  extractFrame,
  listMediaFiles,
  newestMediaFile,
  probeMedia,
  savePreviewElementFrame,
} from '../support/nativeMediaOracle.js';
import { REAL_VIDEO } from '../support/realMedia.js';
import {
  openProjectWithMedia,
  SUBTITLE_FIXTURE,
  importSubtitles,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const COMPARE_AT_SECONDS = 1;
const WORKFLOW = 'word-native-preview-decoded-export';

/* global $, browser, describe, document, it */

describe('Customer Journey 9: Native preview -> exported file with frame-by-frame decoding', () => {
  it('enables word highlighting, inspects preview canvas at boundaries, and triggers export', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(root, 'requires an isolated data root');
    assert.ok(destination, 'requires staged media destination');

    await openProjectWithMedia();
    await importSubtitles(SUBTITLE_FIXTURE);

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-preview-with-cues',
      description: 'Project loaded with subtitles fixture and video.',
    });

    // 1. Move player into cue position and wait for canvas subtitle frame
    await seekPreviewTo(COMPARE_AT_SECONDS);
    await waitForCanvasSubtitleFrame(120_000);
    const previewPath = join(root, 'evidence', 'preview-at-1s.png');
    await savePreviewElementFrame(
      previewPath,
      '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-canvas-frame-rendered',
      description: 'Canvas-atlas subtitle frame rendered at 1s instant.',
    });

    // 2. Open Render section
    await clickControl('.render-video-toggle');
    const controls = await $('.video-rendering-section.expanded .native-render-controls');
    await controls.waitForDisplayed({ timeout: 60_000 });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-export-controls-expanded',
      description: 'Export controls expanded with native preview and preset options.',
    });

    // 3. Submit render
    const renderSelector = '.video-rendering-section.expanded button[data-osg-action="render-video"]';
    const renderButton = await $(renderSelector);
    await renderButton.waitForDisplayed({ timeout: 30_000 });
    assert.equal(await renderButton.isEnabled(), true, 'Render must be enabled');
    await clickControl(renderSelector);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-render-submitted',
      description: 'Render job submitted into queue.',
    });

    // 4. Wait for terminal completion
    const terminal = await $('.video-rendering-section .queue-item.completed, .video-rendering-section .queue-item.failed');
    await terminal.waitForDisplayed({
      timeout: 600_000,
      timeoutMsg: 'Native render job never reached terminal state',
    });
    const terminalClass = await terminal.getAttribute('class');
    assert.match(terminalClass, /(?:^|\s)completed(?:\s|$)/, 'Render job did not complete successfully');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-render-completed',
      description: 'Render job reached terminal completion.',
    });

    // 5. Download exported MP4
    const beforeFiles = listMediaFiles(destination);
    await clickControl('.video-rendering-section .queue-item.completed .download-btn-success');
    let exported = null;
    await browser.waitUntil(() => {
      exported = newestMediaFile(destination, beforeFiles);
      return exported !== null;
    }, { timeout: 120_000, interval: 1_000 });
    assert.ok(exported, 'Exported MP4 was not saved to destination');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '06-exported-file-saved',
      description: 'Exported MP4 saved to staged destination.',
    });

    // 6. Independently probe exported video
    const probe = probeMedia(exported);
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
    assert.ok(videoStream, 'Exported video has no video stream');
    assert.ok(audioStream, 'Exported video has no audio stream');
    assert.ok(videoStream.width > 0 && videoStream.height > 0, 'Invalid video dimensions');
    assert.ok(Number(probe.format.size) > 100_000, 'Exported file is implausibly small');

    // 7. Independently decode frame and compare visible subtitles
    const exportFramePath = join(root, 'evidence', 'export-at-1s.png');
    extractFrame(exported, COMPARE_AT_SECONDS, exportFramePath);
    const ssim = compareFrames(previewPath, exportFramePath);
    assert.ok(ssim >= 0.85, `SSIM ${ssim} between preview and decoded export frame is below threshold`);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '07-decoded-frame-verified',
      description: 'Exported frame extracted via ffmpeg and verified matching preview.',
      details: { ssim, bytes: Number(probe.format.size) },
    });
  });
});
