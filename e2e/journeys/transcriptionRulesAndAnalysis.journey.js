// Two connected customer surfaces: transcription rules / video analysis, and local-ASR segmentation.
//
// GROUND TRUTH DETERMINED FROM SOURCE, NOT ASSUMED: video analysis (VideoAnalysisButton.js's "Add
// analysis") and the "Use transcription rules from analysis" toggle it feeds
// (VideoProcessingModalGeminiPanel.js) are ENTIRELY Gemini-gated with no credential-free success
// path -- runNativeGeminiMediaAnalysis resolves a credential through the same
// createNativeGeminiJobRunner every other native Gemini command uses, and useTranscriptionRules is
// wired ONLY into the Gemini panel (never into local ASR). Manually editing rules
// (TranscriptionRulesEditor) is reachable only once analysis has already produced some, so it
// inherits the same gate -- there is no "type your own rules" path the way manual lyrics/subtitles
// has one (manualLyricsAndGeniusBoundary.journey.js). This journey proves that refusal boundary
// honestly, the same shape geminiCredentialBoundary.journey.js already proves for transcription.
//
// This journey's SECOND half is genuinely credential-free: local ASR's public segmentation
// settings (osg-asr's SegmentationOptions -- strategy/max_characters/max_words/pause_threshold_ms,
// exposed by AsrProcessingOptions.js) are proven to change the SHAPE of durably transcribed cues in
// the documented direction by running the reviewed Faster-Whisper Turbo engine TWICE on the exact
// same short real-speech clip with two different settings and comparing SQLite. Running local ASR
// twice is why this journey is marked heavy/ASR-shard and excluded from the ordinary default suite
// (see run-isolated.mjs's NON_DEFAULT_JOURNEYS) even though the staged media stays short.

/* global $, browser, describe, document, it */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { selectAsrStrategy } from '../support/asrSegmentationControls.js';
import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { ensureEngineReady } from '../support/engines.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import {
  assertNoNewProviderJob,
  summarizeSegmentationShape,
  verifySegmentationShapeDirection,
  verifyWordCappedSegmentationShape,
} from '../support/segmentationShapeOracle.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'transcription-rules-and-analysis';
const ASR_ENGINE = 'faster-whisper-turbo';
const WORD_CAP = 2;
const PROVIDER_JOB_KINDS = Object.freeze(['analyzeSubtitles', 'transcribe', 'translate']);
const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'interrupted']);

const dismissToasts = () => browser.execute(() => {
  for (const close of document.querySelectorAll('.toast-item.live .close-icon')) close.click();
});

const analysisButtonSurface = () => browser.execute(() => {
  const button = document.querySelector('.video-analysis-button');
  return {
    present: button !== null,
    processing: button?.classList.contains('processing') ?? null,
    hasAnalysis: button?.classList.contains('has-analysis') ?? null,
    errorToasts: [...document.querySelectorAll('.toast-item.live .toast-error')]
      .map((node) => (node.innerText || node.textContent || '').trim())
      .filter(Boolean),
  };
});

const clearAndReopenGenerateModal = async (root) => {
  const timeline = await $('.subtitle-timeline');
  await timeline.waitForDisplayed({
    timeout: 60_000,
    timeoutMsg: 'the subtitle timeline never became available to clear the previous run',
  });
  await timeline.click();
  await browser.keys(['\uE009', 'a', '\uE000']);
  await browser.keys(['\uE017']);
  await browser.waitUntil(() => durableState(root).counts.cues === 0, {
    timeout: 60_000,
    interval: 500,
    timeoutMsg: 'Ctrl+A/Delete did not clear the previous run\'s durable cues',
  });
  await clickControl('[data-osg-action="generate-subtitles"]');
  await timeline.waitForDisplayed({ timeout: 30_000 });
  await timeline.click();
  await browser.keys(['\uE009', 'a', '\uE000']);
};

/** Select the local ASR method in the freshly opened processing modal. */
const selectAsrMethod = async () => {
  const method = await $(`[data-transcription-method="${ASR_ENGINE}"]`);
  await method.waitForDisplayed({ timeout: 60_000, timeoutMsg: 'the ASR method chooser did not open' });
  await waitUntilWithFreshDiagnostic(async () => (
    (await method.getAttribute('data-method-available')) === 'true'
  ), {
    timeout: 60_000,
    interval: 500,
    diagnostic: () => `${ASR_ENGINE} never became selectable in the chooser`,
  });
  await method.click();
};

/** Run local ASR to completion over the full timeline and return its exact durable cues. */
const runLocalAsrToCompletion = async (root, { label }) => {
  const before = durableState(root);
  const existingJobIds = new Set(before.jobs.filter(({ kind }) => kind === 'transcribe').map(({ id }) => id));
  await clickControl('[data-osg-action="process-subtitles"]');

  let lastJob = null;
  let terminalFailure = null;
  await waitUntilWithFreshDiagnostic(async () => {
    const durable = durableState(root);
    const newJobs = durable.jobs.filter(({ id, kind }) => kind === 'transcribe' && !existingJobIds.has(id));
    assert.ok(newJobs.length <= 1, `${label}: one Process click created multiple transcription jobs`);
    [lastJob = null] = newJobs;
    if (lastJob !== null && TERMINAL_FAILURES.has(lastJob.state)) {
      terminalFailure = lastJob;
      return true;
    }
    return lastJob?.state === 'succeeded' && durable.counts.cues > 0;
  }, {
    timeout: 1_800_000,
    interval: 2_000,
    diagnostic: () => `${label}: local ASR never completed with durable cues: ${JSON.stringify({ lastJob })}`,
  });
  if (terminalFailure !== null) {
    throw new Error(`${label}: local ASR job terminated: ${JSON.stringify(terminalFailure)}`);
  }
  const after = durableState(root);
  assert.ok(after.cues.every((cue) => (
    cue.start_ms >= 0 && cue.end_ms > cue.start_ms && cue.text.trim().length > 0
  )), `${label}: ASR persisted invalid cue timing/text: ${JSON.stringify(after.cues)}`);
  return after.cues;
};

describe('transcription rules/video analysis refuse honestly without a Gemini credential, and local segmentation settings shape ASR cues', () => {
  it('refuses analysis cleanly with zero side effects, then proves two segmentation settings change cue shape', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run in an isolated root');

    await openProjectWithMedia();

    // --- Part 1: video analysis / transcription rules refuse before any provider side effect. ----
    const beforeAnalysis = durableState(root);
    await dismissToasts();
    let surface = await analysisButtonSurface();
    assert.equal(surface.present, true, 'the Video Analysis button is missing from the editor');
    assert.equal(surface.hasAnalysis, false, 'a fresh project already carries transcription rules');
    await clickControl('.video-analysis-button');

    await waitUntilWithFreshDiagnostic(async () => {
      surface = await analysisButtonSurface();
      return surface.errorToasts.length > 0 && surface.processing === false;
    }, {
      timeout: 30_000,
      interval: 250,
      diagnostic: () => `missing-credential video analysis refusal never settled: ${JSON.stringify(surface)}`,
    });
    assert.equal(surface.hasAnalysis, false, 'video analysis published rules without a credential');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-analysis-refused',
      description: 'Video analysis refuses with a visible toast and returns to idle without a credential.',
      details: { errorToasts: surface.errorToasts },
      allowVisibleProblems: {
        errorToasts: surface.errorToasts.map((toast) => ({
          text: toast.replace(/\s+/gu, ' ').trim(),
          reason: 'The visible missing-credential refusal is the customer state under test.',
        })),
      },
    });

    const afterAnalysis = durableState(root);
    assertNoNewProviderJob({ before: beforeAnalysis, after: afterAnalysis, providerKinds: PROVIDER_JOB_KINDS });
    assert.equal(afterAnalysis.counts.cues, 0, 'missing-credential video analysis published subtitle cues');
    const log = readFileSync(join(root, 'logs', 'osg.log'), 'utf8');
    assert.doesNotMatch(
      log,
      /"event":"gemini\.(?:started|progress|completed|failed|cancelled)"/u,
      'the native log recorded a Gemini request lifecycle event despite no credential',
    );

    // The "Use transcription rules from analysis" toggle is truthfully disabled: it can never be
    // usefully enabled because nothing credential-free can ever populate rules for it to use.
    await clickControl('[data-osg-action="generate-subtitles"]');
    const timeline = await $('.subtitle-timeline');
    await timeline.waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'the Gemini range selector never became available',
    });
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);
    const geminiMethod = await $('[data-transcription-method="new"]');
    await geminiMethod.waitForClickable({ timeout: 60_000 });
    await geminiMethod.click();
    const rulesToggle = await browser.execute(() => {
      const toggle = document.querySelector('#use-transcription-rules');
      return toggle === null ? null : { disabled: toggle.disabled, checked: toggle.selected === true };
    });
    assert.ok(rulesToggle, 'the "Use transcription rules from analysis" toggle is missing');
    assert.equal(rulesToggle.disabled, true, 'the transcription-rules toggle is usable without any analysis');
    assert.equal(rulesToggle.checked, false, 'the transcription-rules toggle is checked without any analysis');
    await clickControl('.video-processing-modal .close-button-modal');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-rules-toggle-honestly-disabled',
      description: 'The Gemini panel\'s "Use transcription rules from analysis" toggle stays disabled '
        + 'because nothing credential-free can populate rules for it to use.',
      details: { rulesToggle },
    });

    // --- Part 2: credential-free local ASR segmentation shape, run twice on the same short clip. --
    await ensureEngineReady(ASR_ENGINE, { allowInstall: false });

    await clickControl('[data-osg-action="generate-subtitles"]');
    await timeline.waitForDisplayed({ timeout: 30_000 });
    await timeline.click();
    await browser.keys(['\uE009', 'a', '\uE000']);
    await selectAsrMethod();
    await selectAsrStrategy('word');
    await actuateNativeRange({
      driver: browser,
      selector: '#asr-max-words',
      value: WORD_CAP,
      label: 'ASR max words per subtitle',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-word-capped-settings',
      description: `The public splitting method is set to "word count" with a ${WORD_CAP}-word cap.`,
      focusSelector: '.video-processing-modal',
    });
    const wordCappedCues = await runLocalAsrToCompletion(root, { label: 'word-capped run' });
    const wordCapped = verifyWordCappedSegmentationShape({ cues: wordCappedCues, maxWords: WORD_CAP });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-word-capped-result',
      description: 'The word-capped run produced many short cues, each at or under the requested word count.',
      details: wordCapped,
      focusSelector: '.lyrics-container-wrapper',
    });

    await clearAndReopenGenerateModal(root);
    await selectAsrMethod();
    await selectAsrStrategy('sentence');
    // A toggle click flips whatever state the switch is currently in; assert the resulting state
    // rather than trusting the click, since `preserve_sentences` persists per engine in localStorage
    // and this journey must guarantee full sentences are actually preserved for run two.
    await clickControl('#asr-preserve-sentences');
    const preserveSentencesState = await browser.execute(() => (
      document.querySelector('#asr-preserve-sentences')?.selected ?? null
    ));
    if (preserveSentencesState !== true) await clickControl('#asr-preserve-sentences');
    await waitUntilWithFreshDiagnostic(async () => (
      (await browser.execute(() => document.querySelector('#asr-preserve-sentences')?.selected ?? null)) === true
    ), {
      timeout: 10_000,
      interval: 200,
      diagnostic: () => 'the "preserve full sentences" switch never reached the selected state',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-full-sentence-settings',
      description: 'The public splitting method is set back to "sentence" with full sentences preserved.',
      focusSelector: '.video-processing-modal',
    });
    const sentenceCues = await runLocalAsrToCompletion(root, { label: 'full-sentence run' });
    const sentence = summarizeSegmentationShape(sentenceCues);
    const direction = verifySegmentationShapeDirection({ wordCapped, sentence });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '06-segmentation-shape-direction-proven',
      description: 'The same short clip transcribed twice: the word-capped run produced more, '
        + 'shorter cues than the full-sentence run -- the documented segmentation-setting direction.',
      details: direction,
      focusSelector: '.lyrics-container-wrapper',
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
