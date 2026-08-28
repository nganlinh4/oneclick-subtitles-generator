// A customer renders a small, bounded matrix over the ONLY two public render-settings axes this
// product exposes -- Resolution and Frame Rate -- plus the one click-only transform the render
// surface publishes, and every export is proven against independent ffprobe geometry/fps/duration.
//
// WHAT WAS ENUMERATED, NOT ASSUMED. `src/components/VideoRenderingSection/RenderSettingsRow.js` has
// exactly two dropdowns: Resolution (360p/480p/720p/1080p/1440p/4K/8K) and Frame Rate (24/25/30/50/
// 60/120). There is no public container or codec control anywhere in the render surface, and
// `crates/osg-render/src/contract.rs`'s `RenderRequest` carries no such field either -- every native
// export is one fixed MP4/H.264+AAC container. The "container/codec options" axis this journey's
// capability names therefore has exactly one option, covered by construction in every case below.
//
// `src/components/VideoCropControls.js`'s aspect-ratio PRESET buttons are the one publicly reachable
// transform: click-only (no pointer drag needed), and per `crates/osg-export/src/convert/
// dimensions.rs` they reshape the OUTPUT frame's own aspect rather than padding a fixed canvas --
// see renderFormatTransformMatrixOracle.js for the exact contract formula this journey verifies
// against, sourced from the durably persisted crop percentages rather than assumed.
//
// Five renders total (four geometry cases plus one crop case sharing a geometric baseline), all at
// low resolutions on the nineteen-second real source, to keep one run well under twenty minutes.

import { strict as assert } from 'node:assert';
import {
  existsSync, mkdirSync, renameSync, statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

import { durableRenderScenes, durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { listMediaFiles, newestMediaFile, probeMedia } from '../support/nativeMediaOracle.js';
import { REAL_VIDEO } from '../support/realMedia.js';
import {
  RENDER_TRANSFORM_MATRIX_CASES, verifyRenderMatrixCase,
} from '../support/renderFormatTransformMatrixOracle.js';
import {
  RENDER_BUTTON, assertManagedArtifactLedgerMatchesDisk, assertNoRenderFailure,
  installTransientRenderErrorLedger, newJobsSince, queueSurface, safeArtifactPath, setRenderSettings,
} from '../support/renderQueue.js';
import { importSubtitles, openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../support/workflowEvidence.js';

/* global $, browser, describe, it */

const WORKFLOW = 'render-format-transform-matrix';
const RENDER_TIMEOUT_MS = 10 * 60 * 1_000;
const TERMINAL_FAILURES = new Set(['failed', 'cancelled', 'interrupted']);

const readableRenderLedger = (root) => {
  const state = durableState(root);
  return Object.freeze({
    projects: state.projects,
    jobs: state.jobs.filter(({ kind }) => kind === 'renderVideo'),
    artifacts: state.artifacts.filter(({ kind }) => kind === 'renderedVideo'),
  });
};

/** One full Render -> terminal -> download round trip for one matrix case. */
const runMatrixRender = async ({
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
  const artifact = after.artifacts.find(({ job_id: jobId }) => jobId === job.id);
  assert.ok(artifact, `${label}: the succeeded job published no rendered-video artifact`);
  assert.equal(artifact.project_id, projectId, `${label}: the rendered artifact escaped its project`);
  assert.equal(artifact.state, 'ready', `${label}: the rendered artifact is not ready`);
  const internalPath = safeArtifactPath(root, artifact);
  assert.equal(
    statSync(internalPath).size,
    artifact.size_bytes,
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

  // Every render proposes the exact same suggested filename (render/publish.rs's fixed
  // "rendered-video.mp4"), so the next round's save into this same flat destination directory would
  // hit the automation build's typed staged-destination refusal (dialog_paths.rs's
  // validate_staged_save_destination: it refuses when `destination.exists()`, with no overwrite
  // fallback). Move this round's file aside immediately, the same per-round `kept-<label>` shape
  // downloadQualityVariants.journey.js already established, to free the destination before the next
  // matrix case renders.
  const keptDirectory = join(destination, `kept-${label.replace(/[^A-Za-z0-9]+/gu, '-')}`);
  mkdirSync(keptDirectory, { recursive: true });
  const keptPath = join(keptDirectory, basename(exported));
  renameSync(exported, keptPath);
  exported = keptPath;

  return Object.freeze({ job, artifact, internalPath, exported });
};

/** Enter crop mode, select the 1:1 aspect preset, and Apply -- click-only, no pointer drag. */
const applySquareCrop = async (root) => {
  const toggle = await $('.crop-toggle-btn');
  await toggle.waitForClickable({
    timeout: 30_000, timeoutMsg: 'the public crop control never became available',
  });
  await toggle.click();
  const squarePreset = await $('.crop-aspect-buttons button[title="1:1"]');
  await squarePreset.waitForClickable({
    timeout: 15_000, timeoutMsg: 'the 1:1 crop aspect preset never appeared',
  });
  await squarePreset.click();
  const apply = await $('.crop-action-btn.apply');
  await apply.waitForClickable({
    timeout: 15_000, timeoutMsg: 'the Apply Crop control never became available',
  });
  await apply.click();

  let crop = null;
  await waitUntilWithFreshDiagnostic(async () => {
    crop = durableRenderScenes(root).at(-1)?.scene?.crop ?? null;
    return crop !== null && (crop.width !== 100 || crop.height !== 100);
  }, {
    timeout: 30_000,
    interval: 100,
    diagnostic: () => `the 1:1 crop never became durable: ${JSON.stringify(crop)}`,
  });
  return crop;
};

describe('a customer renders a small resolution/frame-rate/crop matrix of the same project', () => {
  it('proves every export matches its requested geometry, frame rate and timeline exactly', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    const destination = process.env.OSG_E2E_MEDIA_DESTINATION;
    const selectedSource = process.env.OSG_E2E_MEDIA_SELECTION;
    assert.ok(root, 'the application must run against an isolated data root');
    assert.ok(destination, 'the native save destination must be staged');
    assert.ok(selectedSource && existsSync(selectedSource), (
      'the staged source used by the real select-media boundary is unavailable to the oracle'
    ));
    const sourceProbe = probeMedia(selectedSource);
    assert.ok(
      Math.abs(Number(sourceProbe.format.duration) - REAL_VIDEO.durationSeconds)
        <= REAL_VIDEO.durationToleranceSeconds,
      'the independently probed staged source does not match the expected real source duration',
    );

    await openProjectWithMedia();
    await importSubtitles();
    await clickControl('.render-video-toggle');
    await $('.video-rendering-section.expanded .native-render-controls').waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: 'the public video-rendering section never published its native render controls',
    });
    await installTransientRenderErrorLedger();

    const results = {};
    for (const matrixCase of RENDER_TRANSFORM_MATRIX_CASES) {
      const scene = await setRenderSettings({
        root,
        resolution: matrixCase.resolution,
        resolutionOptionIndex: matrixCase.resolutionOptionIndex,
        frameRate: matrixCase.frameRate,
        frameRateOptionIndex: matrixCase.frameRateOptionIndex,
        frameRatePrefix: matrixCase.frameRatePrefix,
      });
      assert.match(scene.projectId, /^[a-f0-9]{32}$/, 'the durable project ID is malformed');

      const crop = matrixCase.crop === '1:1' ? await applySquareCrop(root) : null;
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: `case-${matrixCase.name}-configured`,
        description: `Resolution ${matrixCase.resolution} and ${matrixCase.frameRate}fps are the durable `
          + `project scene${crop ? ', with a 1:1 crop applied' : ''}, before Render is clicked.`,
        details: { resolution: matrixCase.resolution, frameRate: matrixCase.frameRate, crop },
        focusSelector: '.video-rendering-section .rendering-row',
      });

      const rendered = await runMatrixRender({
        root, destination, projectId: scene.projectId, label: matrixCase.name,
      });
      const probe = probeMedia(rendered.exported);
      const verified = verifyRenderMatrixCase({
        probe, sourceProbe, expected: matrixCase, crop,
      });
      results[matrixCase.name] = verified;

      copyWorkflowArtifact({
        workflow: WORKFLOW,
        name: `matrix-${matrixCase.name}`,
        source: rendered.exported,
        description: `Customer-saved export for matrix case ${matrixCase.name}, independently probed.`,
      });
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: `case-${matrixCase.name}-verified`,
        description: `The decoded export matches the requested ${matrixCase.resolution}/`
          + `${matrixCase.frameRate}fps exactly, with duration ${verified.duration}s.`,
        details: {
          jobId: rendered.job.id,
          artifactId: rendered.artifact.id,
          width: verified.width,
          height: verified.height,
          frameRate: verified.frameRate,
          duration: verified.duration,
        },
        focusSelector: '.video-rendering-section .queue-manager-panel',
      });
    }

    // The crop case's decoded geometry must visibly differ from its uncropped geometric baseline,
    // and must itself be square -- the concrete "reflected in decoded frame geometry" proof.
    const cropCase = RENDER_TRANSFORM_MATRIX_CASES.find(({ crop }) => crop !== null);
    const cropped = results[cropCase.name];
    const baseline = results[cropCase.baselineCase];
    assert.equal(cropped.width, cropped.height, 'the 1:1 crop case did not decode as a square frame');
    assert.notEqual(
      cropped.width,
      baseline.width,
      'applying the 1:1 crop did not change the decoded output geometry',
    );

    // The "container/codec options" axis has exactly one option (no public control exists): prove
    // that empirically, rather than only in prose, by requiring every one of the five independently
    // decoded exports -- across every resolution, frame rate and the crop case -- to agree on codec.
    const videoCodecs = new Set(Object.values(results).map(({ videoCodec }) => videoCodec));
    const audioCodecs = new Set(Object.values(results).map(({ audioCodec }) => audioCodec));
    assert.equal(videoCodecs.size, 1, (
      `the fixed video codec varied across matrix cases: ${[...videoCodecs].join(', ')}`
    ));
    assert.equal(audioCodecs.size, 1, (
      `the fixed audio codec varied across matrix cases: ${[...audioCodecs].join(', ')}`
    ));

    assertManagedArtifactLedgerMatchesDisk(root);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: 'matrix-complete',
      description: 'All five matrix cases decoded to their exact requested geometry, frame rate, timeline and one fixed codec.',
      details: {
        videoCodec: [...videoCodecs][0],
        audioCodec: [...audioCodecs][0],
        cases: Object.fromEntries(Object.entries(results).map(([name, value]) => (
          [name, { width: value.width, height: value.height, frameRate: value.frameRate }]
        ))),
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
