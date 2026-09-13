/* global $, browser, document */

import { strict as assert } from 'node:assert';
import { readFileSync, statSync } from 'node:fs';

import { durableState } from './database.js';
import { clickControl } from './editor.js';
import { measureAudioSignal, probeMedia } from './nativeMediaOracle.js';
import {
  dismissToasts, installFailureLedger, recordedFailures, visibleFailures,
} from './narrationFailureLedger.js';
import {
  durableProjectNarrations, resolveManagedArtifact, verifyNarrationGenerationOwnership,
} from './narrationJourneyOracle.js';
import { captureWorkflowStep, copyWorkflowArtifact } from './workflowEvidence.js';

const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'interrupted']);

const looksLikeMp3 = (bytes) => (
  bytes.length >= 3
  && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
);
const looksLikeWav = (bytes) => (
  bytes.length >= 12
  && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
  && bytes.subarray(8, 12).toString('ascii') === 'WAVE'
);
const hasExpectedSignature = (bytes, format) => (
  format === 'mp3' ? looksLikeMp3(bytes) : format === 'wav' ? looksLikeWav(bytes) : false
);

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

/**
 * Exercise only the provider-dependent half of narration generation. Alignment and export have a
 * separate provider-independent proof, so provider journeys stop after decoding every new clip.
 */
export const runProviderNarrationGeneration = async ({
  root,
  method,
  workflow,
  providerLabel,
  expectedFormat = 'mp3',
  timeoutMs = 300_000,
  prepare = async () => {},
  afterGeneration = async () => ({}),
}) => {
  assert.ok(root, 'the application must run in an isolated root');
  await browser.waitUntil(async () => browser.execute((providerMethod) => {
    const input = document.querySelector(`#method-${providerMethod}`);
    return input !== null && input.disabled === false;
  }, method), {
    timeout: 60_000,
    interval: 200,
    timeoutMsg: `${method} did not become selectable from the narration surface`,
  });
  await clickControl(`label[for="method-${method}"]`);
  await prepare();
  const generateSelector = `[data-osg-action="generate-narration"][data-narration-method="${method}"]`;
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
    diagnostic: () => `${method} never became ready to generate: ${JSON.stringify(generateState)}`,
  });

  await dismissToasts();
  await installFailureLedger();
  const before = durableState(root);
  assert.equal(durableProjectNarrations(root).length, 0, (
    'the fresh project inherited a narration checkpoint before generation'
  ));
  await generate.click();

  let surface = null;
  let after = null;
  let failedJob = null;
  let records = [];
  await waitUntilWithFreshDiagnostic(async () => {
    surface = await browser.execute(() => ({
      succeeded: document.querySelectorAll('[data-narration-result-state="succeeded"]').length,
      pending: document.querySelectorAll('[data-narration-result-state="pending"]').length,
      failed: document.querySelectorAll('[data-narration-result-state="failed"]').length,
    }));
    after = durableState(root);
    records = durableProjectNarrations(root);
    const oldJobs = new Set(before.jobs.map(({ id }) => id));
    const jobs = after.jobs.filter((job) => (
      job.kind === 'synthesizeNarration' && !oldJobs.has(job.id)
    ));
    failedJob = jobs.find((job) => TERMINAL_FAILURES.has(job.state)) ?? null;
    const oldArtifacts = new Set(before.artifacts.map(({ id }) => id));
    const readyArtifacts = after.artifacts.filter((artifact) => (
      artifact.kind === 'narrationOutput'
      && artifact.state === 'ready'
      && !oldArtifacts.has(artifact.id)
    ));
    return failedJob !== null
      || (surface.succeeded === after.cues.length
        && surface.pending === 0
        && surface.failed === 0
        && jobs.length === 1
        && jobs[0].state === 'succeeded'
        && readyArtifacts.length === after.cues.length
        && records.length === 1);
  }, {
    timeout: timeoutMs,
    interval: 1_000,
    diagnostic: () => `${method} narration did not finish: ${JSON.stringify({ surface, failedJob })}`,
  });
  if (failedJob !== null) {
    throw new Error(`native ${method} narration job terminated: ${JSON.stringify({ failedJob, surface })}`);
  }

  const generation = verifyNarrationGenerationOwnership({
    before,
    after,
    records,
    surface,
    method,
  });
  const clipEvidence = [];
  for (const [index, binding] of generation.bindings.entries()) {
    const path = resolveManagedArtifact(root, binding.artifact.relative_path);
    assert.equal(statSync(path).size, binding.artifact.size_bytes, (
      `artifact size disagrees with SQLite: ${binding.artifact.relative_path}`
    ));
    assert.equal(hasExpectedSignature(readFileSync(path).subarray(0, 12), expectedFormat), true, (
      `${method} narration artifact is not ${expectedFormat.toUpperCase()} audio: ${binding.artifact.relative_path}`
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
    clipEvidence.push(Object.freeze({
      cue: index + 1,
      artifactId: binding.artifact.id,
      bytes: binding.artifact.size_bytes,
      durationSeconds,
      format: expectedFormat,
      meanVolumeDb: signal.meanVolumeDb,
      peakVolumeDb: signal.peakVolumeDb,
    }));
    copyWorkflowArtifact({
      workflow,
      name: `cue-narration-${String(index + 1).padStart(2, '0')}`,
      source: path,
      description: `Independently decoded project-owned ${providerLabel} output for cue ${index + 1}.`,
    });
  }

  const providerEvidence = await afterGeneration({ before, after, generation, clipEvidence });
  await captureWorkflowStep({
    workflow,
    step: '02-provider-audio-complete',
    description: `${providerLabel} produced one decoded non-silent artifact per cue.`,
    details: {
      proofClass: `network-dependent ${providerLabel} provider proof`,
      cueCount: after.cues.length,
      clipEvidence,
      ...providerEvidence,
    },
    focusSelector: '.narration-section',
  });
  assert.deepEqual(await visibleFailures(), [], `a visible ${method} narration refusal remains`);
  assert.deepEqual(await recordedFailures(), [], `${method} narration emitted a transient refusal`);
  return Object.freeze({ ...generation, providerEvidence });
};
