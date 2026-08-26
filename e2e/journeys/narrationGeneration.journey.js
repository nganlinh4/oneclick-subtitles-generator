// One network-dependent gTTS provider smoke hands real speech artifacts to a deterministic local
// alignment and render proof. No credentialed or billed provider is used.
/* global $, browser, describe, document, getComputedStyle, it, MutationObserver, window */

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { durableRenderScenes, durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { ensureEngineReady } from '../support/engines.js';
import {
  listMediaFiles,
  measureAudioSignal,
  newestMediaFile,
  probeMedia,
} from '../support/nativeMediaOracle.js';
import { actuateNativeRange } from '../support/nativeRange.js';
import {
  analyzePcm16,
  decodeAudioPcm16,
  durableProjectNarrations,
  expectedNarrationPlacements,
  resolveManagedArtifact,
  verifyCueAlignedSignal,
  verifyNarrationGenerationOwnership,
  verifyNarrationOnlyExportMix,
  verifySingleProjectArtifact,
} from '../support/narrationJourneyOracle.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const ENGINE = 'gtts';
const WORKFLOW = 'narration-generation';
const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'interrupted']);
const RENDER_BUTTON = '.video-rendering-section.expanded button[data-osg-action="render-video"]';

const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');

const looksLikeMp3 = (bytes) => (
  bytes.length >= 3
  && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
);

const dismissToasts = async () => {
  await browser.execute(() => {
    for (const close of document.querySelectorAll('.toast-item.live .close-icon')) close.click();
  });
  await browser.waitUntil(async () => (await browser.execute(
    () => document.querySelectorAll('.toast-item.live .toast').length,
  )) === 0, {
    timeout: 15_000,
    interval: 100,
    timeoutMsg: 'old toast history did not clear before narration admission',
  });
};

const installFailureLedger = () => browser.execute(() => {
  window.__OSG_E2E_NARRATION_FAILURE_LEDGER__?.observer?.disconnect?.();
  const events = [];
  const selector = [
    '.toast-item.live .toast-error',
    '.toast-item.live .toast-warning',
    '.narration-section [role="alert"]',
    '.narration-section .error-message',
    '.narration-section .error',
    '.video-rendering-section.expanded [role="alert"]',
    '.video-rendering-section.expanded .error-message',
    '.video-rendering-section.expanded .video-error',
  ].join(',');
  const text = node => (node.innerText || node.textContent || '')
    .trim().replace(/\s+/gu, ' ').slice(0, 500);
  const record = (node) => {
    const value = text(node);
    if (value && !events.includes(value)) events.push(value);
  };
  const capture = () => {
    for (const node of document.querySelectorAll(selector)) {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.display !== 'none' && style.visibility !== 'hidden'
          && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0) record(node);
    }
  };
  const observer = new MutationObserver((records) => {
    for (const mutation of records) {
      for (const added of mutation.addedNodes) {
        if (added.nodeType !== 1) continue;
        if (added.matches?.(selector)) record(added);
        for (const node of added.querySelectorAll?.(selector) ?? []) record(node);
      }
    }
    capture();
  });
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  window.__OSG_E2E_NARRATION_FAILURE_LEDGER__ = { events, observer };
  capture();
  return true;
});

const recordedFailures = () => browser.execute(() => (
  [...new Set(window.__OSG_E2E_NARRATION_FAILURE_LEDGER__?.events ?? [])]
));

const visibleFailures = () => browser.execute(() => {
  const selector = [
    '.toast-item.live .toast-error',
    '.toast-item.live .toast-warning',
    '.narration-section [role="alert"]',
    '.narration-section .error-message',
    '.narration-section .error',
    '.video-rendering-section.expanded [role="alert"]',
    '.video-rendering-section.expanded .error-message',
    '.video-rendering-section.expanded .video-error',
  ].join(',');
  return [...document.querySelectorAll(selector)].filter((node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }).map((node) => (node.innerText || node.textContent || '').trim().replace(/\s+/gu, ' '))
    .filter(Boolean);
});

const waitForDurableCues = async (root) => {
  let durable = null;
  await browser.waitUntil(() => {
    durable = durableState(root);
    return durable.projects.length === 1 && durable.cues.length === 3;
  }, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: 'the imported cue plan never became durable before narration generation',
  });
  return durable;
};

const waitForStableSavedVideo = async (destination, before) => {
  let path = null;
  let priorSize = -1;
  let stableSamples = 0;
  await browser.waitUntil(() => {
    path = newestMediaFile(destination, before);
    if (path === null) return false;
    const size = statSync(path).size;
    stableSamples = size > 0 && size === priorSize ? stableSamples + 1 : 0;
    priorSize = size;
    return stableSamples >= 2;
  }, {
    timeout: 180_000,
    interval: 250,
    timeoutMsg: 'the narration-only render never reached one stable staged video file',
  });
  return path;
};

describe('a customer generates narration from subtitles', () => {
  it('binds every cue, aligns every onset, and exports a narration-only native video mix', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    const selectedSource = process.env.OSG_E2E_MEDIA_SELECTION;
    assert.ok(root, 'the application must run in an isolated root');
    assert.ok(destination, 'the aligned-audio save destination must be staged');
    assert.ok(selectedSource && existsSync(selectedSource), 'the staged real source video is missing');

    await openProjectWithMedia();
    await importSubtitles();
    await waitForDurableCues(root);
    await ensureEngineReady(ENGINE, {
      onReady: async (state) => captureWorkflowStep({
        workflow: WORKFLOW,
        step: '01-engine-ready',
        description: 'The reviewed gTTS package is visibly installed, running, and ready.',
        details: { ...state, proofClass: 'network-dependent gTTS provider smoke' },
      }),
    });

    await clickControl('label[for="method-gtts"]');
    const generateSelector = '[data-osg-action="generate-narration"][data-narration-method="gtts"]';
    const generate = await $(generateSelector);
    let generateState = null;
    await waitUntilWithFreshDiagnostic(async () => {
      generateState = await browser.execute((selector) => {
        const button = document.querySelector(selector);
        return button === null ? null : {
          disabled: button.disabled,
          title: button.title,
          text: (button.innerText || '').trim(),
        };
      }, generateSelector);
      return generateState !== null && generateState.disabled === false;
    }, {
      timeout: 120_000,
      interval: 500,
      diagnostic: () => `gTTS never became ready to generate: ${JSON.stringify(generateState)}`,
    });

    await dismissToasts();
    await installFailureLedger();
    const beforeGeneration = durableState(root);
    assert.equal(durableProjectNarrations(root).length, 0, (
      'the fresh project inherited a narration checkpoint before generation'
    ));
    await generate.click();

    let surface = null;
    let afterGeneration = null;
    let failedJob = null;
    let records = [];
    await waitUntilWithFreshDiagnostic(async () => {
      surface = await browser.execute(() => ({
        succeeded: document.querySelectorAll('[data-narration-result-state="succeeded"]').length,
        pending: document.querySelectorAll('[data-narration-result-state="pending"]').length,
        failed: document.querySelectorAll('[data-narration-result-state="failed"]').length,
      }));
      afterGeneration = durableState(root);
      records = durableProjectNarrations(root);
      const beforeJobIds = new Set(beforeGeneration.jobs.map(({ id }) => id));
      const narrationJobs = afterGeneration.jobs.filter((job) => (
        job.kind === 'synthesizeNarration' && !beforeJobIds.has(job.id)
      ));
      failedJob = narrationJobs.find((job) => TERMINAL_FAILURES.has(job.state)) ?? null;
      const beforeArtifactIds = new Set(beforeGeneration.artifacts.map(({ id }) => id));
      const readyArtifacts = afterGeneration.artifacts.filter((artifact) => (
        artifact.kind === 'narrationOutput'
        && artifact.state === 'ready'
        && !beforeArtifactIds.has(artifact.id)
      ));
      return failedJob !== null
        || (surface.succeeded === afterGeneration.cues.length
          && surface.pending === 0
          && surface.failed === 0
          && narrationJobs.length === 1
          && narrationJobs[0].state === 'succeeded'
          && readyArtifacts.length === afterGeneration.cues.length
          && records.length === 1);
    }, {
      timeout: 900_000,
      interval: 1_000,
      diagnostic: () => `narration did not finish: ${JSON.stringify({ surface, failedJob })}`,
    });
    if (failedJob !== null) {
      throw new Error(`native narration job terminated: ${JSON.stringify({ failedJob, surface })}`);
    }

    const generation = verifyNarrationGenerationOwnership({
      before: beforeGeneration,
      after: afterGeneration,
      records,
      surface,
    });
    const clipDurations = [];
    const clipEvidence = [];
    for (const [index, binding] of generation.bindings.entries()) {
      const path = resolveManagedArtifact(root, binding.artifact.relative_path);
      assert.equal(statSync(path).size, binding.artifact.size_bytes, (
        `artifact size disagrees with SQLite: ${binding.artifact.relative_path}`
      ));
      assert.equal(looksLikeMp3(readFileSync(path).subarray(0, 3)), true, (
        `narration artifact is not MP3 audio: ${binding.artifact.relative_path}`
      ));
      const probe = probeMedia(path);
      const audioStreams = probe.streams.filter(({ codec_type: type }) => type === 'audio');
      assert.equal(audioStreams.length, 1, `cue ${index + 1} has no single decoded audio stream`);
      assert.equal(probe.streams.some(({ codec_type: type }) => type === 'video'), false, (
        `cue ${index + 1} unexpectedly contains video`
      ));
      const durationSeconds = Number(probe.format.duration);
      assert.ok(Number.isFinite(durationSeconds) && durationSeconds > 0.1, (
        `cue ${index + 1} has no plausible decoded duration`
      ));
      const signal = measureAudioSignal(path);
      assert.ok(Number.isFinite(signal.peakVolumeDb) && signal.peakVolumeDb > -50, (
        `cue ${index + 1} independently decodes as silence: ${JSON.stringify(signal)}`
      ));
      clipDurations.push(durationSeconds);
      clipEvidence.push(Object.freeze({
        cue: index + 1,
        artifactId: binding.artifact.id,
        bytes: binding.artifact.size_bytes,
        durationSeconds,
        meanVolumeDb: signal.meanVolumeDb,
        peakVolumeDb: signal.peakVolumeDb,
      }));
      copyWorkflowArtifact({
        workflow: WORKFLOW,
        name: `cue-narration-${String(index + 1).padStart(2, '0')}`,
        source: path,
        description: `Independently decoded project-owned gTTS output for cue ${index + 1}.`,
      });
    }

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-provider-audio-complete',
      description: 'The network-dependent gTTS provider smoke produced one decoded non-silent artifact per cue.',
      details: {
        proofClass: 'network-dependent gTTS provider smoke',
        cueCount: afterGeneration.cues.length,
        clipEvidence,
      },
      focusSelector: '.narration-section',
    });

    // Everything after this point is deterministic local alignment and render proof. It consumes
    // only already-published native artifacts and the staged local media; no provider is contacted.
    const placements = expectedNarrationPlacements(generation.bindings, clipDurations);
    const alignedPath = join(destination, 'aligned_narration.m4a');
    assert.equal(existsSync(alignedPath), false, 'the isolated aligned output already exists');
    const beforeAlignment = durableState(root);
    await clickControl('[data-osg-action="download-aligned-narration"]');

    let afterAlignment = null;
    await browser.waitUntil(() => {
      afterAlignment = durableState(root);
      const beforeJobs = new Set(beforeAlignment.jobs.map(({ id }) => id));
      const jobs = afterAlignment.jobs.filter((job) => (
        job.kind === 'alignNarration' && !beforeJobs.has(job.id)
      ));
      const beforeArtifacts = new Set(beforeAlignment.artifacts.map(({ id }) => id));
      const artifacts = afterAlignment.artifacts.filter((artifact) => (
        artifact.kind === 'alignedNarration' && !beforeArtifacts.has(artifact.id)
      ));
      return jobs.length === 1 && jobs[0].state === 'succeeded'
        && artifacts.length === 1 && artifacts[0].state === 'ready'
        && existsSync(alignedPath);
    }, {
      timeout: 300_000,
      interval: 1_000,
      timeoutMsg: 'aligned narration did not produce one successful native job and saved file',
    });
    const alignment = verifySingleProjectArtifact({
      before: beforeAlignment,
      after: afterAlignment,
      expectedProjectId: generation.projectId,
      jobKind: 'alignNarration',
      artifactKind: 'alignedNarration',
    });
    const durableAlignedPath = resolveManagedArtifact(root, alignment.artifact.relative_path);
    assert.equal(statSync(durableAlignedPath).size, alignment.artifact.size_bytes, (
      'aligned artifact size disagrees with SQLite'
    ));
    assert.deepEqual(
      { bytes: statSync(alignedPath).size, sha256: sha256(alignedPath) },
      { bytes: statSync(durableAlignedPath).size, sha256: sha256(durableAlignedPath) },
      'the customer-saved aligned narration differs from its durable native artifact',
    );

    const alignedProbe = probeMedia(alignedPath);
    const alignedAudioStreams = alignedProbe.streams.filter(({ codec_type: type }) => type === 'audio');
    assert.equal(alignedAudioStreams.length, 1, (
      `aligned output has no single audio stream: ${JSON.stringify(alignedProbe)}`
    ));
    assert.equal(alignedProbe.streams.some(({ codec_type: type }) => type === 'video'), false, (
      'aligned narration unexpectedly contains video'
    ));
    const expectedAlignedDuration = Math.max(
      ...placements.map(({ cueEnd, end }) => Math.max(cueEnd, end)),
    ) + 0.25;
    const alignedDuration = Number(alignedProbe.format.duration);
    assert.ok(Math.abs(alignedDuration - expectedAlignedDuration) <= 0.2, (
      `aligned duration ${alignedDuration}s disagrees with measured placement ${expectedAlignedDuration}s`
    ));
    const alignedPcm = decodeAudioPcm16(alignedPath);
    const alignedAnalysis = analyzePcm16(alignedPcm.bytes, { sampleRate: alignedPcm.sampleRate });
    const alignmentSignal = verifyCueAlignedSignal({
      analysis: alignedAnalysis,
      placements,
      label: 'aligned narration mix',
    });
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'aligned-narration',
      source: alignedPath,
      description: 'The locally aligned M4A, independently decoded and checked at every cue onset.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-local-alignment-complete',
      description: 'Deterministic local alignment and render proof: every decoded cue begins in its native placement window.',
      details: {
        proofClass: 'deterministic local alignment and render proof',
        durationSeconds: alignedDuration,
        bytes: statSync(alignedPath).size,
        placements,
        onset: alignmentSignal.onset,
      },
      focusSelector: '.narration-section',
    });

    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'native render preview did not open for narration selection',
    });
    const generatedNarration = await $('label[for="narration-generated"]');
    await generatedNarration.waitForDisplayed({
      timeout: 30_000,
      timeoutMsg: 'the aligned narration did not become selectable for native render',
    });
    await clickControl('label[for="narration-generated"]');
    await actuateNativeRange({
      driver: browser,
      selector: '#original-audio-volume',
      value: 0,
      label: 'original audio volume',
    });
    await actuateNativeRange({
      driver: browser,
      selector: '#narration-volume',
      value: 100,
      label: 'narration volume',
    });
    let durableScene = null;
    await browser.waitUntil(() => {
      durableScene = durableRenderScenes(root).at(-1) ?? null;
      return durableScene?.scene?.selectedNarration === 'generated'
        && durableScene.scene?.renderSettings?.originalAudioVolume === 0
        && durableScene.scene?.renderSettings?.narrationVolume === 100;
    }, {
      timeout: 30_000,
      interval: 100,
      timeoutMsg: 'narration-only public render controls never reached the durable project scene',
    });

    await dismissToasts();
    const beforeRender = durableState(root);
    const beforeVideos = listMediaFiles(destination);
    await clickControl(RENDER_BUTTON);
    const terminal = await $('.video-rendering-section .queue-item.completed, '
      + '.video-rendering-section .queue-item.failed');
    await terminal.waitForDisplayed({
      timeout: 600_000,
      timeoutMsg: 'the narration-only native render never reached a terminal state',
    });
    const terminalClass = await terminal.getAttribute('class');
    const terminalText = (await terminal.getText()).slice(0, 2_000);
    assert.match(
      terminalClass,
      /(?:^|\s)completed(?:\s|$)/u,
      `narration-only native render failed: ${terminalText}`,
    );
    const afterRender = durableState(root);
    const rendered = verifySingleProjectArtifact({
      before: beforeRender,
      after: afterRender,
      expectedProjectId: generation.projectId,
      jobKind: 'renderVideo',
      artifactKind: 'renderedVideo',
    });
    const inlineStatus = await browser.execute(() => (
      document.querySelector('.render-admission-status, .rendering-overlay')?.innerText?.trim() ?? null
    ));
    assert.equal(inlineStatus, null, 'render progress leaked into the video layout');

    await clickControl('.video-rendering-section .queue-item.completed .download-btn-success');
    const exported = await waitForStableSavedVideo(destination, beforeVideos);
    const durableRenderedPath = resolveManagedArtifact(root, rendered.artifact.relative_path);
    assert.deepEqual(
      { bytes: statSync(exported).size, sha256: sha256(exported) },
      { bytes: statSync(durableRenderedPath).size, sha256: sha256(durableRenderedPath) },
      'the saved final video differs from its durable native render artifact',
    );

    const sourceProbe = probeMedia(selectedSource);
    const exportProbe = probeMedia(exported);
    const exportedVideo = exportProbe.streams.filter(({ codec_type: type }) => type === 'video');
    const exportedAudio = exportProbe.streams.filter(({ codec_type: type }) => type === 'audio');
    assert.equal(exportedVideo.length, 1, 'final narration render has no single video stream');
    assert.equal(exportedAudio.length, 1, 'final narration render has no single audio stream');
    const sourceDuration = Number(sourceProbe.format.duration);
    const exportDuration = Number(exportProbe.format.duration);
    assert.ok(Math.abs(exportDuration - sourceDuration) <= 0.2, (
      `final narration render duration ${exportDuration}s differs from source ${sourceDuration}s`
    ));
    assert.ok(Number(exportProbe.format.size) > 100_000, 'final narration render is implausibly small');
    const exportedSignal = measureAudioSignal(exported);
    assert.ok(Number.isFinite(exportedSignal.peakVolumeDb) && exportedSignal.peakVolumeDb > -50, (
      `final narration render independently decodes as silence: ${JSON.stringify(exportedSignal)}`
    ));

    const exportedPcm = decodeAudioPcm16(exported);
    const sourcePcm = decodeAudioPcm16(selectedSource);
    const mix = verifyNarrationOnlyExportMix({
      aligned: alignedAnalysis,
      exported: analyzePcm16(exportedPcm.bytes, { sampleRate: exportedPcm.sampleRate }),
      source: analyzePcm16(sourcePcm.bytes, { sampleRate: sourcePcm.sampleRate }),
      placements,
      sourceDurationSeconds: sourceDuration,
    });
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'narration-only-exported-video',
      source: exported,
      description: 'Final native MP4 with source audio set to 0% and aligned narration set to 100%.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-narration-video-mix-complete',
      description: 'The customer-saved native video carries cue-aligned narration and no muted-source tail.',
      details: {
        proofClass: 'deterministic local alignment and render proof',
        sceneRevision: durableScene.sceneRevision,
        originalAudioVolume: 0,
        narrationVolume: 100,
        durationSeconds: exportDuration,
        bytes: statSync(exported).size,
        envelopeCorrelation: mix.correlation,
        sourceTailMaximumRms: mix.sourceTail.maximumRms,
        exportedTailMaximumRms: mix.exportedTail.maximumRms,
      },
      focusSelector: '.video-rendering-section',
    });

    assert.deepEqual(await visibleFailures(), [], 'a visible narration/render refusal remains');
    assert.deepEqual(await recordedFailures(), [], 'narration/render emitted a transient refusal');
    assert.equal(
      await browser.execute(() => document.fullscreenElement === null),
      true,
      'the hidden narration journey activated fullscreen',
    );
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
