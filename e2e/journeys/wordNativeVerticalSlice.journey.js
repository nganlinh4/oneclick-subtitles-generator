// Real-binary customer vertical slice:
// Fresh video -> Gemini Transcribe -> Word click seek -> Save project
// -> Relaunch fresh process -> Verify restored captions -> Real UI Export
// -> ffmpeg frame decode & independent subtitle comparison.

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl, openEditor, whatIsAt } from '../support/editor.js';
import { enrollGeminiCredentials } from '../support/liveProviderCredentials.js';
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
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const COMPARE_AT_SECONDS = 2.0;
const PHASE = process.env.OSG_E2E_PERSISTENCE_PHASE;
const WORKFLOW = 'word-native-vertical-slice';

/* global $, $$, browser, describe, document, it */

const surfaceState = () => browser.execute(() => ({
  cues: [...document.querySelectorAll('.lyric-text')]
    .map((node) => (node.innerText || '').trim()).filter(Boolean),
  words: [...document.querySelectorAll('.transcript-word')]
    .map((node) => ({
      text: (node.innerText || '').trim(),
      startMs: Number(node.getAttribute('data-word-start') || 0),
    })),
  currentTimeMs: Math.round(Number(document.querySelector('video')?.currentTime || 0) * 1000),
}));

const inspectEditor = () => browser.execute(() => {
  const video = document.querySelector('video');
  const cueNodes = document.querySelectorAll('.lyric-text');
  return {
    hasVideoElement: video !== null,
    videoDuration: Number.isFinite(video?.duration) ? video.duration : null,
    cueCount: cueNodes.length,
    cues: [...cueNodes].map((node) => (node.innerText || '').trim()).filter(Boolean),
  };
});

describe('Word-Native Real Customer Vertical Slice', () => {
  it('transcribes fresh video, verifies words, relaunches cleanly, and exports decoded video', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(root, 'the harness must have an isolated data root');
    assert.ok(
      PHASE === 'seed' || PHASE === 'verify',
      'run this vertical slice through scenarios/wordNativeVerticalSlice.mjs',
    );

    if (PHASE === 'seed') {
      // === PHASE 1: Import, Transcribe, Word-Seek, Save ===
      await openProjectWithMedia();
      await enrollGeminiCredentials({ limit: 1 });
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '01-fresh-video-opened',
        description: 'Fresh real video opened in editor with Gemini credentials enrolled.',
      });

      // Open Create Subtitles modal
      await clickControl('[data-osg-action="generate-subtitles"]');
      const modal = await $('.create-subtitles-modal, .video-processing-modal');
      await modal.waitForDisplayed({ timeout: 30_000 });

      // Explicitly select Speech task and Gemini Transcribe engine
      const speechTab = await $('[data-task-tab="speech"]');
      await speechTab.waitForDisplayed({ timeout: 10_000 });
      await speechTab.click();

      const engineSelect = await $('#speech-engine-select');
      await engineSelect.waitForDisplayed({ timeout: 10_000 });
      await engineSelect.selectByAttribute('value', 'gemini-3.5-transcribe');
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-transcribe-engine-selected',
        description: 'Speech task and Gemini Transcribe word-native engine explicitly selected.',
      });

      // Submit transcription request
      await clickControl('[data-osg-action="process-subtitles"]');

      // Wait for provider completion & captions arrival
      let surface = null;
      let durable = null;
      await browser.waitUntil(async () => {
        surface = await surfaceState();
        durable = durableState(root);
        return surface.cues.length > 0 && durable.counts.cues > 0;
      }, {
        timeout: 180_000,
        interval: 1_000,
        timeoutMsg: 'Gemini transcription did not deliver captions within timeout',
      });

      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '03-captions-arrived',
        description: 'Captions arrived with native words reconciled to database persistence.',
      });
      assert.ok(surface.cues.length > 0, 'Captions must be visible in editing area');
      assert.ok(durable.counts.cues > 0, 'Cues must be persisted in database');

      // Switch to Transcript view and verify native words
      const transcriptToggle = await $('[data-editor-view="transcript"], [data-testid="viewport-tab-transcript"]');
      await transcriptToggle.waitForDisplayed({ timeout: 10_000 });
      await transcriptToggle.click();
      await browser.pause(500);
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '04-transcript-view-active',
        description: 'Switched to transcript view showing native recognized words.',
      });

      const wordEls = await $$('.transcript-word');
      assert.ok(wordEls.length > 0, 'Transcript words must be rendered');

      // Find a word with nonzero start timestamp
      let targetWord = null;
      let expectedStartMs = 0;
      for (const el of wordEls) {
        const start = Number(await el.getAttribute('data-word-start') || 0);
        if (start > 0) {
          targetWord = el;
          expectedStartMs = start;
          break;
        }
      }
      if (!targetWord) {
        targetWord = wordEls[0];
        expectedStartMs = Number(await targetWord.getAttribute('data-word-start') || 0);
      }
      assert.ok(targetWord !== null, 'Must find transcript word');

      // Click word and verify player seeks to word timestamp
      await targetWord.click();
      await browser.pause(1000);
      const updatedSurface = await surfaceState();
      assert.ok(
        Math.abs(updatedSurface.currentTimeMs - expectedStartMs) <= 1000,
        `Player time ${updatedSurface.currentTimeMs}ms must seek close to word start ${expectedStartMs}ms`,
      );
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '05-word-seek-verified',
        description: 'Clicked recognized word and verified video player seeks to word timestamp.',
      });

      // Switch back to captions view
      const captionsToggle = await $('[data-editor-view="captions"], [data-testid="viewport-tab-captions"]');
      await captionsToggle.waitForDisplayed({ timeout: 10_000 });
      await captionsToggle.click();
      await browser.pause(500);

      // Verify save state and explicitly trigger save if actionable
      const saveState = await whatIsAt('.lyrics-save-btn');
      if (saveState.present && !saveState.disabled) {
        await clickControl('.lyrics-save-btn');
        await browser.pause(1000);
      }
      const savedDurable = durableState(root);
      assert.equal(savedDurable.counts.projects, 1, 'Exactly one project must be persisted');
      assert.ok(savedDurable.counts.cues > 0, 'Cues must be persisted in database');
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '06-project-saved',
        description: 'Project explicitly saved with native words and cues in SQLite.',
      });
      return;
    }

    // === PHASE 2: Fresh Process Relaunch -> Restore -> Export -> Decode ===
    const saved = durableState(root);
    assert.equal(saved.counts.projects, 1, 'The prior process must have created one project');
    assert.equal(saved.counts.media, 1, 'The prior process must have recorded one media asset');
    assert.ok(saved.counts.cues > 0, 'Saved cues must be present at startup');
    const priorProjectId = saved.projects[0].id;
    const priorCueCount = saved.counts.cues;

    // Launch second desktop process against the SAME isolated profile
    await openEditor();
    let restoredSeen = null;
    await browser.waitUntil(async () => {
      restoredSeen = await inspectEditor();
      return restoredSeen.hasVideoElement && restoredSeen.cueCount > 0;
    }, {
      timeout: 180_000,
      interval: 2_000,
      timeoutMsg: 'The project did not restore in a new process',
    });

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '07-relaunched-project-restored',
      description: 'Second desktop process restored identical project, media, and captions without re-generation.',
    });

    // Verify project identity, media duration, and cue count without another paid generation
    const restored = durableState(root);
    assert.equal(restored.projects[0].id, priorProjectId, 'Project identity must match');
    assert.equal(restored.counts.cues, priorCueCount, 'Cue count must match');
    assert.equal(restored.counts.projects, 1, 'Startup must not duplicate project');
    assert.ok(
      Math.abs(restoredSeen.videoDuration - REAL_VIDEO.durationSeconds) <= REAL_VIDEO.durationToleranceSeconds,
      `Restored media duration ${restoredSeen.videoDuration}s must match source ${REAL_VIDEO.durationSeconds}s`,
    );

    // Seek player to nonzero comparison time and capture preview canvas frame
    await seekPreviewTo(COMPARE_AT_SECONDS);
    await waitForCanvasSubtitleFrame(120_000);
    const previewPath = join(root, 'evidence', 'preview-at-2s.png');
    await savePreviewElementFrame(
      previewPath,
      '.video-preview canvas[data-osg-preview-engine="canvas-atlas"]',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '08-preview-canvas-rendered',
      description: 'Canvas-atlas preview frame rendered at 2s instant.',
    });

    // Open native render / export section
    await clickControl('.render-video-toggle');
    const controls = await $('.video-rendering-section.expanded .native-render-controls');
    await controls.waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'Render section never published its controls',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '09-export-controls-expanded',
      description: 'Export controls expanded with native player and presets visible.',
    });

    // Submit render job
    const renderSelector = '.video-rendering-section.expanded button[data-osg-action="render-video"]';
    const renderButton = await $(renderSelector);
    await renderButton.waitForDisplayed({ timeout: 30_000 });
    assert.equal(await renderButton.isEnabled(), true, 'Render button must be enabled');
    await clickControl(renderSelector);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '10-export-submitted',
      description: 'Render job admitted into native queue.',
    });

    // Wait for render terminal completion
    const terminal = await $('.video-rendering-section .queue-item.completed, .video-rendering-section .queue-item.failed');
    await terminal.waitForDisplayed({
      timeout: 600_000,
      timeoutMsg: 'Native render job never reached terminal state',
    });
    const terminalClass = await terminal.getAttribute('class');
    assert.match(terminalClass, /(?:^|\s)completed(?:\s|$)/, 'Export job failed or did not complete');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '11-export-completed',
      description: 'Export job reached visible terminal completion in queue.',
    });

    // Download exported MP4 into staged destination
    assert.ok(destination, 'OSG_E2E_MEDIA_DESTINATION must be configured');
    const beforeFiles = listMediaFiles(destination);
    await clickControl('.video-rendering-section .queue-item.completed .download-btn-success');
    let exported = null;
    await browser.waitUntil(() => {
      exported = newestMediaFile(destination, beforeFiles);
      return exported !== null;
    }, {
      timeout: 120_000,
      interval: 1_000,
      timeoutMsg: 'Exported MP4 was not saved to staged destination',
    });
    assert.ok(exported, 'Exported MP4 file missing');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '12-exported-file-saved',
      description: 'Exported MP4 saved to staged destination.',
    });

    // Independently probe exported video
    const probe = probeMedia(exported);
    const videoStream = probe.streams.find((s) => s.codec_type === 'video');
    const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
    assert.ok(videoStream, 'Exported video has no video stream');
    assert.ok(audioStream, 'Exported video has no audio stream');
    assert.ok(videoStream.width > 0 && videoStream.height > 0, 'Invalid video dimensions');
    assert.ok(Number(probe.format.size) > 100_000, 'Exported file is implausibly small');
    const duration = Number(probe.format.duration);
    assert.ok(
      Math.abs(duration - REAL_VIDEO.durationSeconds) <= REAL_VIDEO.durationToleranceSeconds,
      `Exported duration ${duration}s does not match source ${REAL_VIDEO.durationSeconds}s`,
    );

    // Independently decode frame with ffmpeg and compare visible subtitles
    const exportFramePath = join(root, 'evidence', 'export-at-2s.png');
    extractFrame(exported, COMPARE_AT_SECONDS, exportFramePath);
    const ssim = compareFrames(previewPath, exportFramePath);
    assert.ok(ssim >= 0.85, `SSIM ${ssim} between preview and decoded export frame is below threshold`);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '13-decoded-frame-verified',
      description: 'Exported frame extracted via ffmpeg and verified matching preview subtitle rendering.',
      details: { ssim, durationSeconds: duration, bytes: Number(probe.format.size) },
    });
  });
});
