// A customer renders the same project twice through the public Render control: once with the
// default "No Narration" mix, once with a gTTS-generated "Aligned Narration" mix selected. No
// credentialed or billed provider is used -- gTTS is a network-dependent provider smoke, exactly
// like the already-green narrationGeneration journey, and everything after generation is
// deterministic local alignment and render proof.
//
// WHY THIS JOURNEY EXISTS SEPARATELY. narrationAlignment (narrationGeneration.journey.js) proves a
// standalone aligned M4A. nativeExportDecoded proves one render's source audio. Neither drives the
// render section's own narration-mix TOGGLE on the SAME project: this journey renders A (narration
// off) and B (narration on) with every other public setting held fixed, then proves the two exported
// files differ measurably in decoded audio energy at every narration cue's placement window while
// staying otherwise identical (same geometry, frame rate, audio format, duration).
//
// The comparison intentionally does not assume a mixing direction. An implementation may duck the
// original track under narration instead of summing onto it, so only a MEASURABLE difference is
// required, not a guaranteed increase -- see renderAudioNarrationMixOracle.js.

import { strict as assert } from 'node:assert';
import { statSync } from 'node:fs';
import process from 'node:process';

import { durableRenderScenes, durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { ensureEngineReady } from '../support/engines.js';
import { listMediaFiles, newestMediaFile, probeMedia } from '../support/nativeMediaOracle.js';
import {
  analyzePcm16, decodeAudioPcm16, durableProjectNarrations, expectedNarrationPlacements,
  resolveManagedArtifact, verifyNarrationGenerationOwnership, verifySingleProjectArtifact,
} from '../support/narrationJourneyOracle.js';
import { verifyNarrationMixWindows, verifyStructuralAudioParity } from '../support/renderAudioNarrationMixOracle.js';
import {
  RENDER_BUTTON, assertManagedArtifactLedgerMatchesDisk, assertNoRenderFailure,
  installTransientRenderErrorLedger, newJobsSince, queueSurface, setRenderSettings,
} from '../support/renderQueue.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

/* global $, browser, describe, document, it */

const ENGINE = 'gtts';
const WORKFLOW = 'render-audio-narration-mix';
const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'interrupted']);
const RENDER_TIMEOUT_MS = 10 * 60 * 1_000;

const readableRenderLedger = (root) => {
  const state = durableState(root);
  return Object.freeze({
    projects: state.projects,
    jobs: state.jobs.filter(({ kind }) => kind === 'renderVideo'),
    artifacts: state.artifacts.filter(({ kind }) => kind === 'renderedVideo'),
  });
};

const waitForDurableCues = async (root) => {
  let durable = null;
  await browser.waitUntil(() => {
    durable = durableState(root);
    return durable.projects.length === 1 && durable.cues.length > 0;
  }, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: 'the imported cues never became durable before narration/render setup',
  });
  return durable;
};

const waitForDurableNarrationSelection = async (root, expected) => {
  let observed = null;
  await waitUntilWithFreshDiagnostic(async () => {
    observed = durableRenderScenes(root).at(-1)?.scene?.selectedNarration ?? null;
    return observed === expected;
  }, {
    timeout: 30_000,
    interval: 100,
    diagnostic: () => (
      `the public narration selection never reached '${expected}' in the durable project scene `
        + `(last seen '${observed}')`
    ),
  });
};

/** One full Render -> terminal -> download round trip, returning the durable job/artifact pair. */
const runRenderAndDownload = async ({
  root, destination, projectId, label,
}) => {
  const before = readableRenderLedger(root);
  const beforeIds = new Set(before.jobs.map(({ id }) => id));
  const beforeFiles = listMediaFiles(destination);
  await clickControl(RENDER_BUTTON);

  let job = null;
  let surface = null;
  await waitUntilWithFreshDiagnostic(async () => {
    const ledger = readableRenderLedger(root);
    const created = newJobsSince(ledger, beforeIds);
    assert.ok(created.length <= 1, `${label}: one Render click created multiple jobs: ${JSON.stringify(created)}`);
    [job = null] = created;
    surface = await queueSurface();
    return job !== null && (job.state === 'succeeded' || TERMINAL_FAILURES.has(job.state));
  }, {
    timeout: RENDER_TIMEOUT_MS,
    interval: 500,
    diagnostic: () => `${label}: render never reached a terminal state: ${JSON.stringify({ job, surface })}`,
  });
  assert.equal(job.state, 'succeeded', `${label}: native render job did not succeed: ${JSON.stringify(job)}`);
  assertNoRenderFailure(surface);

  const after = readableRenderLedger(root);
  const owned = verifySingleProjectArtifact({
    before, after, expectedProjectId: projectId, jobKind: 'renderVideo', artifactKind: 'renderedVideo',
  });
  const internalPath = resolveManagedArtifact(root, owned.artifact.relative_path);
  assert.equal(
    statSync(internalPath).size,
    owned.artifact.size_bytes,
    `${label}: artifact size disagrees with SQLite`,
  );

  await clickControl('.video-rendering-section .queue-item.completed:first-child .download-btn-success');
  let exported = null;
  await browser.waitUntil(() => {
    exported = newestMediaFile(destination, beforeFiles);
    return exported !== null;
  }, {
    timeout: 120_000,
    interval: 500,
    timeoutMsg: `${label}: the completed render was not written to the staged customer destination`,
  });

  return Object.freeze({
    job: owned.job, artifact: owned.artifact, internalPath, exported,
  });
};

describe('a customer toggles the narration mix on the same rendered project', () => {
  it('proves the narration-on and narration-off renders differ only in decoded audio energy', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    assert.ok(root, 'the application must run against an isolated data root');
    assert.ok(destination, 'the native save destination must be staged');

    await openProjectWithMedia();
    await importSubtitles();
    const importedCues = await waitForDurableCues(root);

    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'the public video-rendering section never published its native render controls',
    });
    await installTransientRenderErrorLedger();
    // A small, fixed, shared setting for both renders: only the narration control differs between
    // job A and job B, so any later audio delta is caused by that one public toggle.
    const scene = await setRenderSettings({
      root, resolution: '480p', resolutionOptionIndex: 1, frameRate: 24, frameRateOptionIndex: 0, frameRatePrefix: '24 FPS',
    });
    assert.match(scene.projectId, /^[a-f0-9]{32}$/, 'the durable project ID is malformed');

    // Render A: the shipped default -- narration off. Clicked explicitly rather than trusted as a
    // default, so the journey still proves the "No Narration" control itself is wired correctly.
    await clickControl('label[for="narration-none"]');
    await waitForDurableNarrationSelection(root, 'none');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-baseline-narration-off',
      description: 'The public "No Narration" control is selected before the baseline render.',
      focusSelector: '.narration-selection-compact',
    });
    const baseline = await runRenderAndDownload({
      root, destination, projectId: scene.projectId, label: 'baseline render',
    });
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'baseline-render-no-narration',
      source: baseline.exported,
      description: 'Job A: the same project rendered with the public narration mix left off.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-baseline-render-complete',
      description: 'Job A completed and was saved to the staged customer destination.',
      details: { jobId: baseline.job.id, artifactId: baseline.artifact.id },
      focusSelector: '.video-rendering-section .queue-manager-panel',
    });

    // Deterministic local alignment and render proof begins here; only cue generation above touched
    // a network provider, exactly as narrationGeneration.journey.js documents for the same engine.
    await ensureEngineReady(ENGINE, {
      onReady: async (state) => captureWorkflowStep({
        workflow: WORKFLOW,
        step: '03-engine-ready',
        description: 'The reviewed gTTS package is visibly installed, running, and ready.',
        details: { ...state, proofClass: 'network-dependent gTTS provider smoke' },
      }),
    });
    await clickControl('label[for="method-gtts"]');
    const generateSelector = '[data-osg-action="generate-narration"][data-narration-method="gtts"]';
    const generateButton = await $(generateSelector);
    await waitUntilWithFreshDiagnostic(async () => (
      (await browser.execute((selector) => {
        const button = document.querySelector(selector);
        return button === null ? null : { disabled: button.disabled };
      }, generateSelector))?.disabled === false
    ), {
      timeout: 120_000,
      interval: 500,
      diagnostic: () => 'gTTS never became ready to generate narration',
    });

    const beforeGeneration = durableState(root);
    assert.equal(durableProjectNarrations(root).length, 0, (
      'the fresh project inherited a narration checkpoint before generation'
    ));
    await generateButton.click();
    let surface = null;
    let afterGeneration = null;
    let records = [];
    await waitUntilWithFreshDiagnostic(async () => {
      surface = await browser.execute(() => ({
        succeeded: document.querySelectorAll('[data-narration-result-state="succeeded"]').length,
        pending: document.querySelectorAll('[data-narration-result-state="pending"]').length,
        failed: document.querySelectorAll('[data-narration-result-state="failed"]').length,
      }));
      afterGeneration = durableState(root);
      records = durableProjectNarrations(root);
      return surface.succeeded === afterGeneration.cues.length
        && surface.pending === 0
        && surface.failed === 0
        && records.length === 1;
    }, {
      timeout: 900_000,
      interval: 1_000,
      diagnostic: () => `narration generation did not finish: ${JSON.stringify({ surface, records })}`,
    });
    const generation = verifyNarrationGenerationOwnership({
      before: beforeGeneration, after: afterGeneration, records, surface,
    });

    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-narration-generated',
      description: 'Every imported cue has one successful, decoded, project-owned gTTS narration clip.',
      details: { cueCount: importedCues.cues.length },
      focusSelector: '.narration-section',
    });

    // Align through the render section's own Refresh control -- the exact public path a customer
    // uses once narration exists but is not yet aligned for export.
    const refreshButton = await $('.narration-selection-compact .refresh-icon-button');
    await refreshButton.waitForEnabled({
      timeout: 30_000,
      timeoutMsg: 'the render section refresh control never became available for the generated narration',
    });
    const beforeAlignment = durableState(root);
    await refreshButton.click();
    const generatedLabel = await $('label[for="narration-generated"]');
    await generatedLabel.waitForDisplayed({
      timeout: 180_000,
      timeoutMsg: 'the aligned narration never became selectable for native render',
    });
    const afterAlignment = durableState(root);
    verifySingleProjectArtifact({
      before: beforeAlignment,
      after: afterAlignment,
      expectedProjectId: scene.projectId,
      jobKind: 'alignNarration',
      artifactKind: 'alignedNarration',
    });

    await clickControl('label[for="narration-generated"]');
    await waitForDurableNarrationSelection(root, 'generated');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-narration-aligned-and-selected',
      description: 'The public "Aligned Narration (ready)" control is selected before render B.',
      focusSelector: '.narration-selection-compact',
    });

    const narrationOn = await runRenderAndDownload({
      root, destination, projectId: scene.projectId, label: 'narration-mix render',
    });
    assert.notEqual(narrationOn.job.id, baseline.job.id, 'job B reused job A\'s native render job');
    copyWorkflowArtifact({
      workflow: WORKFLOW,
      name: 'narration-mix-render',
      source: narrationOn.exported,
      description: 'Job B: the same project rendered with the public narration mix selected.',
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '06-narration-render-complete',
      description: 'Job B completed as a distinct owned artifact and was saved to the customer destination.',
      details: { jobId: narrationOn.job.id, artifactId: narrationOn.artifact.id },
      focusSelector: '.video-rendering-section .queue-manager-panel',
    });

    // Independent oracles: ffprobe geometry parity, decoded PCM energy per narration cue window, and
    // a full artifact-root reconciliation against the durable ledger.
    const withoutProbe = probeMedia(baseline.exported);
    const withProbe = probeMedia(narrationOn.exported);
    verifyStructuralAudioParity({ withProbe, withoutProbe });

    const clipDurations = generation.bindings.map(({ artifact }) => (
      Number(probeMedia(resolveManagedArtifact(root, artifact.relative_path)).format.duration)
    ));
    const placements = expectedNarrationPlacements(generation.bindings, clipDurations);

    const withoutPcm = decodeAudioPcm16(baseline.exported);
    const withPcm = decodeAudioPcm16(narrationOn.exported);
    const withoutAnalysis = analyzePcm16(withoutPcm.bytes, { sampleRate: withoutPcm.sampleRate });
    const withAnalysis = analyzePcm16(withPcm.bytes, { sampleRate: withPcm.sampleRate });
    const deltas = verifyNarrationMixWindows({
      withNarration: withAnalysis, withoutNarration: withoutAnalysis, placements,
    });

    assertManagedArtifactLedgerMatchesDisk(root);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '07-audio-mix-difference-verified',
      description: 'Independent ffprobe geometry parity plus a measurable decoded-audio delta at every narration cue.',
      details: {
        withoutDurationSeconds: Number(withoutProbe.format.duration),
        withDurationSeconds: Number(withProbe.format.duration),
        cueDeltas: deltas,
      },
      focusSelector: '.video-rendering-section',
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
