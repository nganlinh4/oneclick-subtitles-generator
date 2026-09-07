import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import {
  durableState,
  durableTranscriptRevisions,
} from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
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
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const WORKFLOW = 'word-native-preview-decoded-export';

/* global $, browser, describe, it */

describe('Customer Journey 9: Native preview -> exported file with frame-by-frame decoding', () => {
  it('transcribes real video, inspects preview canvas at boundaries, and verifies decoded export frames', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(root, 'requires an isolated data root');
    assert.ok(destination, 'requires staged media destination');

    await openProjectWithMedia();
    await enrollGeminiCredentials({ limit: 1 });

    // Open Create Subtitles modal
    await clickControl('[data-osg-action="generate-subtitles"]');
    const modal = await $('.create-subtitles-modal, .video-processing-modal');
    await modal.waitForDisplayed({ timeout: 30_000 });

    // Explicitly select Speech task and Gemini Transcribe word-native engine
    const speechTab = await $('[data-task-tab="speech"]');
    await speechTab.waitForDisplayed({ timeout: 10_000 });
    await speechTab.click();

    const engineSelect = await $('#speech-engine-select');
    await engineSelect.waitForDisplayed({ timeout: 10_000 });
    await engineSelect.selectByAttribute('value', 'gemini-3.5-transcribe');

    // Submit transcription request
    await clickControl('[data-osg-action="process-subtitles"]');

    // Wait for provider completion & durable captions in SQLite
    let durable = null;
    await browser.waitUntil(async () => {
      durable = durableState(root);
      const job = durable.jobs.find((j) => j.kind === 'transcribe' && j.state === 'succeeded');
      return job !== null && durable.counts.cues > 0;
    }, {
      timeout: 180_000,
      interval: 1_000,
      timeoutMsg: 'Gemini transcription did not deliver captions within timeout',
    });

    const revisions = durableTranscriptRevisions(root);
    assert.ok(revisions.length >= 1, 'At least one transcript revision must be recorded');
    const rev = revisions.at(-1);
    assert.equal(rev.provider, 'gemini');
    assert.equal(rev.model, 'gemini-3.5-transcribe');

    const cues = durable.cues;
    assert.ok(cues.length >= 3, `Expected at least 3 generated cues, got ${cues.length}`);

    // Dynamically select 3 active cues spread across the generated track and 1 silent instant
    const cue1 = cues[0];
    const cue2 = cues[Math.floor((cues.length - 1) / 2)];
    const cue3 = cues[cues.length - 1];

    const time1 = Number(((cue1.start_ms + cue1.end_ms) / 2000).toFixed(2));
    const time2 = Number(((cue2.start_ms + cue2.end_ms) / 2000).toFixed(2));
    const time3 = Number(((cue3.start_ms + cue3.end_ms) / 2000).toFixed(2));

    // Select genuine silent instant: before cue 1 if gap >= 800ms, or between consecutive cues
    let silentTime = null;
    if (cue1.start_ms >= 800) {
      silentTime = Number((cue1.start_ms / 2000).toFixed(2));
    } else {
      for (let i = 0; i < cues.length - 1; i += 1) {
        if (cues[i + 1].start_ms - cues[i].end_ms >= 400) {
          silentTime = Number(((cues[i].end_ms + cues[i + 1].start_ms) / 2000).toFixed(2));
          break;
        }
      }
    }
    if (silentTime === null) {
      silentTime = Number(((cue3.end_ms + 400) / 1000).toFixed(2));
    }

    const sampleTimestamps = [
      { time: time1, kind: 'active', cueId: cue1.id, cueText: cue1.text },
      { time: silentTime, kind: 'silent', cueId: null, cueText: '(silent - no subtitle)' },
      { time: time2, kind: 'active', cueId: cue2.id, cueText: cue2.text },
      { time: time3, kind: 'active', cueId: cue3.id, cueText: cue3.text },
    ];

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-preview-with-cues',
      description: 'Project loaded and transcribed with real Gemini Transcribe captions persisted.',
      details: {
        revisionId: rev.id,
        cueCount: cues.length,
        selectedSamples: sampleTimestamps,
      },
    });

    // 1. Move player into each sampled timestamp and capture preview frames
    const previewPaths = {};
    for (const sample of sampleTimestamps) {
      await seekPreviewTo(sample.time);
      if (sample.kind === 'active') {
        await waitForCanvasSubtitleFrame(120_000);
      } else {
        await browser.pause(500);
      }
      const previewPath = join(root, 'evidence', `preview-at-${String(sample.time).replace('.', 'p')}s.png`);
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
      details: { timestamps: sampleTimestamps.map((s) => s.time) },
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

    for (const sample of sampleTimestamps) {
      const timeSlug = String(sample.time).replace('.', 'p');
      const exportFramePath = join(root, 'evidence', `export-at-${timeSlug}s.png`);
      extractFrame(exported, sample.time, exportFramePath);
      exportPaths[sample.time] = exportFramePath;

      const previewCropPath = join(root, 'evidence', `preview-sub-at-${timeSlug}s.png`);
      const exportCropPath = join(root, 'evidence', `export-sub-at-${timeSlug}s.png`);
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

      copyWorkflowArtifact({
        workflow: WORKFLOW,
        name: `preview-at-${timeSlug}s`,
        source: previewPaths[sample.time],
        description: `Preview frame captured at ${sample.time}s (${sample.kind}): "${sample.cueText}"`,
      });
      copyWorkflowArtifact({
        workflow: WORKFLOW,
        name: `export-at-${timeSlug}s`,
        source: exportFramePath,
        description: `Decoded export frame at ${sample.time}s (${sample.kind}): "${sample.cueText}"`,
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

    // Negative discriminating checks:
    // Compare active cue 1 subtitle crop with active cue 2 subtitle crop (different generated text)
    // and with silent subtitle crop (generated text vs no text)
    const negativeWrongTimeSsim = compareFrames(exportCrops[time1], exportCrops[time2]);
    const negativeSilentSsim = compareFrames(exportCrops[time1], exportCrops[silentTime]);
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
      description: 'Exported frames decoded across 3 active cues and 1 silent instant from real Transcribe generation, verified with full-frame and subtitle-region SSIM plus negative control.',
      details: {
        revisionId: rev.id,
        cuesCount: cues.length,
        selectedSamples: sampleTimestamps,
        comparisons,
        negativeWrongTimeSsim,
        negativeSilentSsim,
        bytes: Number(probe.format.size),
        duration: Number(probe.format.duration),
      },
    });
  });
});

