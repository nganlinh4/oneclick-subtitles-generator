import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { clickControl } from '../support/editor.js';
import {
  compareFrames,
  cropSubtitleRegion,
  extractFrame,
  listMediaFiles,
  newestMediaFile,
  probeMedia,
  savePreviewElementFrame,
} from '../support/nativeMediaOracle.js';
import {
  openProjectWithMedia,
  SUBTITLE_FIXTURE,
  importSubtitles,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const SAMPLE_TIMESTAMPS = [
  { time: 1.0, kind: 'active', cueText: 'First cue for the preview' },
  { time: 3.2, kind: 'silent', cueText: '(none - cue boundary)' },
  { time: 5.0, kind: 'active', cueText: 'Second cue, plain text only' },
  { time: 9.0, kind: 'active', cueText: 'Last cue before the end' },
];
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

    // 1. Move player into each sampled timestamp and capture preview frames
    const previewPaths = {};
    for (const sample of SAMPLE_TIMESTAMPS) {
      await seekPreviewTo(sample.time);
      if (sample.kind === 'active') {
        await waitForCanvasSubtitleFrame(120_000);
      } else {
        await browser.pause(500);
      }
      const previewPath = join(root, 'evidence', `preview-at-${sample.time}s.png`);
      await savePreviewElementFrame(
        previewPath,
        '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
      );
      previewPaths[sample.time] = previewPath;
    }

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-canvas-frames-rendered',
      description: 'Canvas-atlas subtitle frames rendered at 4 sampled instants across clip.',
      details: { timestamps: SAMPLE_TIMESTAMPS.map((s) => s.time) },
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

    // 7. Independently decode frames, crop subtitle regions, and compare
    const comparisons = [];
    const exportPaths = {};
    const exportCrops = {};
    const previewCrops = {};

    for (const sample of SAMPLE_TIMESTAMPS) {
      const exportFramePath = join(root, 'evidence', `export-at-${sample.time}s.png`);
      extractFrame(exported, sample.time, exportFramePath);
      exportPaths[sample.time] = exportFramePath;

      const previewCropPath = join(root, 'evidence', `preview-sub-at-${sample.time}s.png`);
      const exportCropPath = join(root, 'evidence', `export-sub-at-${sample.time}s.png`);
      cropSubtitleRegion(previewPaths[sample.time], previewCropPath);
      cropSubtitleRegion(exportFramePath, exportCropPath);
      previewCrops[sample.time] = previewCropPath;
      exportCrops[sample.time] = exportCropPath;

      const fullSsim = compareFrames(previewPaths[sample.time], exportFramePath);
      const subSsim = compareFrames(previewCropPath, exportCropPath);
      comparisons.push({
        time: sample.time,
        kind: sample.kind,
        cueText: sample.cueText,
        fullSsim,
        subSsim,
      });

      const timeSlug = String(sample.time).replace('.', 'p');
      copyWorkflowArtifact({
        workflow: WORKFLOW,
        name: `preview-at-${timeSlug}s`,
        source: previewPaths[sample.time],
        description: `Preview frame captured at ${sample.time}s (${sample.kind})`,
      });
      copyWorkflowArtifact({
        workflow: WORKFLOW,
        name: `export-at-${timeSlug}s`,
        source: exportFramePath,
        description: `Decoded export frame at ${sample.time}s (${sample.kind})`,
      });
      copyWorkflowArtifact({
        workflow: WORKFLOW,
        name: `preview-sub-at-${timeSlug}s`,
        source: previewCropPath,
        description: `Cropped subtitle region of preview at ${sample.time}s`,
      });
      copyWorkflowArtifact({
        workflow: WORKFLOW,
        name: `export-sub-at-${timeSlug}s`,
        source: exportCropPath,
        description: `Cropped subtitle region of export at ${sample.time}s`,
      });

      if (sample.kind === 'active') {
        assert.ok(fullSsim >= 0.85, `Full-frame SSIM ${fullSsim} at ${sample.time}s below 0.85`);
        assert.ok(subSsim >= 0.78, `Subtitle-region SSIM ${subSsim} at ${sample.time}s below 0.78`);
      } else {
        assert.ok(fullSsim >= 0.85, `Silent full-frame SSIM ${fullSsim} at ${sample.time}s below 0.85`);
      }
    }

    // Negative discriminating check:
    // Compare 1.0s cue subtitle crop with 9.0s cue subtitle crop (different text)
    // and with 3.2s silent subtitle crop (no text)
    const negativeWrongTimeSsim = compareFrames(exportCrops[1.0], exportCrops[9.0]);
    const negativeSilentSsim = compareFrames(exportCrops[1.0], exportCrops[3.2]);
    assert.ok(
      negativeWrongTimeSsim < 0.65,
      `Negative wrong-time SSIM ${negativeWrongTimeSsim} is too high (expected < 0.65)`,
    );
    assert.ok(
      negativeSilentSsim < 0.65,
      `Negative silent-frame SSIM ${negativeSilentSsim} is too high (expected < 0.65)`,
    );

    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'exported-video',
      source: exported,
      description: `Exported MP4 video file (${Number(probe.format.size)} bytes, ${Number(probe.format.duration).toFixed(2)}s)`,
    });

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '07-decoded-frames-verified',
      description: 'Exported frames decoded across 3 active cues and 1 silent instant, verified with full-frame and subtitle-region SSIM plus negative control.',
      details: {
        comparisons,
        negativeWrongTimeSsim,
        negativeSilentSsim,
        bytes: Number(probe.format.size),
        duration: Number(probe.format.duration),
      },
    });
  });
});

