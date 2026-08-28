// A second, genuinely small, credential-free network narration provider generates real,
// independently decoded per-cue audio -- alongside narrationGeneration.journey.js's gTTS proof,
// not replacing it. Edge TTS's Windows delivery is 11.2 MiB compressed / 33.9 MiB installed
// (crates/osg-speech/delivery/speech-packages.delivery.json), almost identical to gTTS's own
// 10.8 MiB / 32.7 MiB, so it installs to completion cheaply and needs no isolated cache policy.
//
// This journey deliberately stops after per-cue generation. Alignment, mixing and native render/
// export are engine-agnostic once MP3 bytes exist for every cue -- narrationGeneration.journey.js
// and renderAudioNarrationMix.journey.js already exhaustively prove that half against gTTS, and
// repeating it here would only re-run the same generic pipeline against different audio, not add
// new coverage. What IS new here is the provider: a second real network TTS backend actually
// producing decodable, non-silent, correctly durable per-cue narration.
/* global $, browser, describe, it */

import { strict as assert } from 'node:assert';
import { readFileSync, statSync } from 'node:fs';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { ensureEngineReady } from '../support/engines.js';
import {
  probeMedia, measureAudioSignal,
} from '../support/nativeMediaOracle.js';
import {
  dismissToasts, installFailureLedger, recordedFailures, visibleFailures,
} from '../support/narrationFailureLedger.js';
import {
  durableProjectNarrations, resolveManagedArtifact, verifyNarrationGenerationOwnership,
} from '../support/narrationJourneyOracle.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

const ENGINE = 'edge-tts';
const WORKFLOW = 'edge-tts-narration-generation';
const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'interrupted']);

const looksLikeMp3 = (bytes) => (
  bytes.length >= 3
  && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))
);

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

describe('a customer generates narration with the Edge TTS provider', () => {
  it('installs the small provider package and produces decoded, non-silent per-cue audio', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the application must run in an isolated root');

    await openProjectWithMedia();
    await importSubtitles();
    await waitForDurableCues(root);
    await ensureEngineReady(ENGINE, {
      onReady: async (state) => captureWorkflowStep({
        workflow: WORKFLOW,
        step: '01-engine-ready',
        description: 'The reviewed Edge TTS package (11.2 MiB compressed) is visibly installed, running, and ready.',
        details: { ...state, proofClass: 'network-dependent Edge TTS provider smoke' },
      }),
    });

    await clickControl('label[for="method-edge-tts"]');
    const generateSelector = '[data-osg-action="generate-narration"][data-narration-method="edge-tts"]';
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
      diagnostic: () => `edge-tts never became ready to generate: ${JSON.stringify(generateState)}`,
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
      timeout: 300_000,
      interval: 1_000,
      diagnostic: () => `edge-tts narration did not finish: ${JSON.stringify({ surface, failedJob })}`,
    });
    if (failedJob !== null) {
      throw new Error(`native edge-tts narration job terminated: ${JSON.stringify({ failedJob, surface })}`);
    }

    const generation = verifyNarrationGenerationOwnership({
      before: beforeGeneration,
      after: afterGeneration,
      records,
      surface,
      method: ENGINE,
    });
    const clipEvidence = [];
    for (const [index, binding] of generation.bindings.entries()) {
      const path = resolveManagedArtifact(root, binding.artifact.relative_path);
      assert.equal(statSync(path).size, binding.artifact.size_bytes, (
        `artifact size disagrees with SQLite: ${binding.artifact.relative_path}`
      ));
      assert.equal(looksLikeMp3(readFileSync(path).subarray(0, 3)), true, (
        `edge-tts narration artifact is not MP3 audio: ${binding.artifact.relative_path}`
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
        meanVolumeDb: signal.meanVolumeDb,
        peakVolumeDb: signal.peakVolumeDb,
      }));
      copyWorkflowArtifact({
        workflow: WORKFLOW,
        name: `cue-narration-${String(index + 1).padStart(2, '0')}`,
        source: path,
        description: `Independently decoded project-owned Edge TTS output for cue ${index + 1}.`,
      });
    }

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-provider-audio-complete',
      description: 'The network-dependent Edge TTS provider smoke produced one decoded non-silent artifact per cue.',
      details: {
        proofClass: 'network-dependent Edge TTS provider smoke',
        cueCount: afterGeneration.cues.length,
        clipEvidence,
      },
      focusSelector: '.narration-section',
    });

    assert.deepEqual(await visibleFailures(), [], 'a visible edge-tts narration refusal remains');
    assert.deepEqual(await recordedFailures(), [], 'edge-tts narration emitted a transient refusal');
  });
});
