// Renders one parity case through the real pipeline, saves it through the staged dialog, then
// decodes and judges the export against both captured preview surfaces.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { durableState } from '../../../support/database.js';
import { clickControl } from '../../../support/editor.js';
import { resolveManagedArtifact } from '../../../support/downloadJourneyOracle.js';
import {
  EXPORT_PARITY_FPS,
  analyzeSubtitleParityRgba,
  verifyExportAnimationParityObservation,
} from '../../../support/exportAnimationParityOracle.js';
import {
  compareFramePixels,
  compareFrames,
  decodeFrameRgba,
  extractFrame,
  listMediaFiles,
  measureAudioSignal,
  newestMediaFile,
  probeMedia,
} from '../../../support/nativeMediaOracle.js';
import { captureWorkflowStep, copyWorkflowArtifact } from '../../../support/workflowEvidence.js';
import { RENDER_BUTTON, WORKFLOW, waitUntilWithFreshDiagnostic } from './surfaces.js';
import { dismissToasts, pathInside, recordedProblems, visibleProblems } from './problemLedger.js';

/* global $, $$, browser, document */
export const copyFrameArtifact = ({ name, source, description }) => copyWorkflowArtifact({
  workflow: WORKFLOW,
  name,
  source,
  description,
});


const waitForNewCompletedRow = async (beforeCount, definition) => {
  await browser.waitUntil(async () => (await $$('.video-rendering-section .queue-item')).length === beforeCount + 1, {
    timeout: 30_000,
    interval: 100,
    timeoutMsg: `${definition.id}: Render did not create exactly one queue row`,
  });
  const rows = await $$('.video-rendering-section .queue-item');
  // VideoRenderingSection prepends with `[queueItem, ...prev]`. Selecting by the previous row count
  // works only for the first render and silently points at an older completed export thereafter.
  // The just-admitted row is therefore exactly the first row after the +1 cardinality assertion.
  const row = rows[0];
  let className = '';
  let text = '';
  await waitUntilWithFreshDiagnostic(async () => {
    className = await row.getAttribute('class');
    text = (await row.getText()).slice(0, 2_000);
    return /(?:^|\s)(?:completed|failed)(?:\s|$)/u.test(className);
  }, {
    timeout: 900_000,
    interval: 500,
    diagnostic: () => `${definition.id}: render never completed: ${JSON.stringify({ className, text })}`,
  });
  assert.match(className, /(?:^|\s)completed(?:\s|$)/u, `${definition.id}: render failed: ${text}`);
  return { row, text };
};

const waitForStableSavedMedia = async (destination, before, definition) => {
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
    timeoutMsg: `${definition.id}: staged save produced no one stable media file`,
  });
  return path;
};

const archiveSavedMedia = ({ root, exported, definition }) => {
  const directory = join(root, 'evidence', WORKFLOW, definition.id);
  mkdirSync(directory, { recursive: true });
  const archived = join(directory, `${definition.id}.mp4`);
  assert.equal(existsSync(archived), false, `${definition.id}: archived output already exists`);
  pathInside(root, exported, 'staged export');
  pathInside(root, archived, 'archived export');
  renameSync(exported, archived);
  assert.equal(existsSync(exported), false, `${definition.id}: staged filename was not released`);
  assert.ok(statSync(archived).size > 100_000, `${definition.id}: archived output is implausibly small`);
  return archived;
};

export const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export const renderAndDecode = async ({
  root,
  destination,
  sourceProbe,
  definition,
  durableScene,
  durableCues,
  entry,
  exit,
  durableOwnership,
  selectedSourceIdentity,
  sourceAudioSignal,
}) => {
  await dismissToasts();
  const beforeCount = (await $$('.video-rendering-section .queue-item')).length;
  const beforeFiles = listMediaFiles(destination);
  const beforeLedger = durableState(root);
  const beforeJobIds = new Set(beforeLedger.jobs.map(({ id }) => id));
  const beforeArtifactIds = new Set(beforeLedger.artifacts.map(({ id }) => id));
  const renderButton = await $(RENDER_BUTTON);
  await renderButton.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'public Render is absent' });
  assert.equal(await renderButton.isEnabled(), true, `${definition.id}: public Render is disabled`);
  await clickControl(RENDER_BUTTON);
  await browser.pause(1_000);
  const admission = await browser.execute(() => ({
    inline: document.querySelector('.render-admission-status, .rendering-overlay')?.innerText?.trim() ?? null,
    refusal: [...document.querySelectorAll('.toast-item.live .toast-error, .toast-item.live .toast-warning')]
      .map(node => (node.innerText || node.textContent || '').trim()).filter(Boolean),
    fullscreen: document.fullscreenElement !== null,
  }));
  assert.equal(admission.inline, null, `${definition.id}: render progress leaked inline`);
  assert.deepEqual(admission.refusal, [], `${definition.id}: render was refused`);
  assert.equal(admission.fullscreen, false, `${definition.id}: Render activated fullscreen`);
  const completed = await waitForNewCompletedRow(beforeCount, definition);
  const completedLedger = durableState(root);
  const createdJobs = completedLedger.jobs.filter(
    ({ id, kind }) => kind === 'renderVideo' && !beforeJobIds.has(id),
  );
  const createdArtifacts = completedLedger.artifacts.filter(
    ({ id, kind }) => kind === 'renderedVideo' && !beforeArtifactIds.has(id),
  );
  assert.equal(createdJobs.length, 1, `${definition.id}: Render did not create one durable job`);
  assert.equal(createdArtifacts.length, 1, `${definition.id}: Render did not create one durable artifact`);
  const [createdJob] = createdJobs;
  const [createdArtifact] = createdArtifacts;
  const durableArtifactPath = resolveManagedArtifact(root, createdArtifact.relative_path);
  const download = await completed.row.$('.download-btn-success');
  await download.waitForClickable({ timeout: 30_000, timeoutMsg: `${definition.id}: save is unavailable` });
  await download.click();
  const saved = await waitForStableSavedMedia(destination, beforeFiles, definition);
  const archived = archiveSavedMedia({ root, exported: saved, definition });
  const exportOwnership = Object.freeze({
    jobs: createdJobs.map(({ id, kind, state }) => ({ id, kind, state })),
    artifacts: createdArtifacts.map(({
      id, project_id: projectId, job_id: jobId, kind, state, size_bytes: sizeBytes,
    }) => ({
      id, project_id: projectId, job_id: jobId, kind, state, size_bytes: sizeBytes,
    })),
    durableArtifact: Object.freeze({
      sizeBytes: statSync(durableArtifactPath).size,
      sha256: sha256File(durableArtifactPath),
    }),
    customerSave: Object.freeze({
      sizeBytes: statSync(archived).size,
      sha256: sha256File(archived),
    }),
    expectedJobId: createdJob.id,
    expectedArtifactId: createdArtifact.id,
  });
  const probe = probeMedia(archived);

  const directory = join(root, 'evidence', WORKFLOW, definition.id);
  const decodedEntry = join(directory, 'entry-decoded-export.png');
  const decodedExit = join(directory, 'exit-decoded-export.png');
  extractFrame(archived, entry.seconds, decodedEntry);
  extractFrame(archived, exit.seconds, decodedExit);
  assert.ok(statSync(decodedEntry).size > 1_000, `${definition.id}: entry decode is empty`);
  assert.ok(statSync(decodedExit).size > 1_000, `${definition.id}: exit decode is empty`);
  const videoStream = probe.streams?.find(stream => stream.codec_type === 'video');
  const geometry = { width: Number(videoStream?.width), height: Number(videoStream?.height) };
  assert.ok(Number.isSafeInteger(geometry.width) && geometry.width > 0
    && Number.isSafeInteger(geometry.height) && geometry.height > 0, (
    `${definition.id}: export geometry is unavailable for ROI analysis`
  ));
  const decodedByPhase = { entry: decodedEntry, exit: decodedExit };
  const regions = {};
  const scores = {
    entry: {
      renderExport: compareFrames(entry.renderPath, decodedEntry),
      sourceExport: compareFrames(entry.independentSourcePath, decodedEntry),
      mainRender: entry.mainRender,
      mainExport: compareFrames(entry.mainPath, decodedEntry),
      mainSourceSelected: compareFrames(entry.independentSourcePath, entry.mainSourcePath),
      renderSourceSelected: compareFrames(entry.independentSourcePath, entry.renderSourcePath),
    },
    exit: {
      renderExport: compareFrames(exit.renderPath, decodedExit),
      sourceExport: compareFrames(exit.independentSourcePath, decodedExit),
      mainRender: exit.mainRender,
      mainExport: compareFrames(exit.mainPath, decodedExit),
      mainSourceSelected: compareFrames(exit.independentSourcePath, exit.mainSourcePath),
      renderSourceSelected: compareFrames(exit.independentSourcePath, exit.renderSourcePath),
    },
  };
  for (const [phase, captured] of Object.entries({ entry, exit })) {
    regions[phase] = analyzeSubtitleParityRgba({
      ...geometry,
      independentSource: decodeFrameRgba(captured.independentSourcePath, geometry),
      mainSource: decodeFrameRgba(captured.mainSourcePath, geometry),
      renderSource: decodeFrameRgba(captured.renderSourcePath, geometry),
      main: decodeFrameRgba(captured.mainPath, geometry),
      render: decodeFrameRgba(captured.renderPath, geometry),
      exported: decodeFrameRgba(decodedByPhase[phase], geometry),
    });
  }
  const phasePaths = {
    main: { entry: entry.mainPath, exit: exit.mainPath },
    render: { entry: entry.renderPath, exit: exit.renderPath },
    exported: { entry: decodedEntry, exit: decodedExit },
    independentSource: {
      entry: entry.independentSourcePath,
      exit: exit.independentSourcePath,
    },
  };
  const phaseBinding = {
    frames: { entry: entry.frame, exit: exit.frame },
    publicSeeks: {
      main: {
        entry: { frame: Math.round(entry.mainState.currentTime * EXPORT_PARITY_FPS), seconds: entry.mainState.currentTime, keys: entry.mainState.keySequence },
        exit: { frame: Math.round(exit.mainState.currentTime * EXPORT_PARITY_FPS), seconds: exit.mainState.currentTime, keys: exit.mainState.keySequence },
      },
      render: {
        entry: { frame: Math.round(entry.renderState.currentTime * EXPORT_PARITY_FPS), seconds: entry.renderState.currentTime, keys: entry.renderState.keySequence },
        exit: { frame: Math.round(exit.renderState.currentTime * EXPORT_PARITY_FPS), seconds: exit.renderState.currentTime, keys: exit.renderState.keySequence },
      },
    },
    hashes: {},
    deltas: {},
  };
  for (const [surface, paths] of Object.entries(phasePaths)) {
    phaseBinding.hashes[surface] = {
      entry: sha256File(paths.entry),
      exit: sha256File(paths.exit),
    };
    phaseBinding.deltas[surface] = compareFramePixels(
      paths.entry, paths.exit, { channelDeltaThreshold: 12 },
    );
  }
  await dismissToasts();
  const problems = await visibleProblems();
  const history = await recordedProblems();
  const verified = verifyExportAnimationParityObservation({
    definition,
    probe,
    sourceProbe,
    durableScene,
    durableCues,
    scores,
    regions,
    phaseBinding,
    durableOwnership,
    selectedSourceIdentity,
    exportOwnership,
    audioSignals: { source: sourceAudioSignal, exported: measureAudioSignal(archived) },
    visibleProblems: problems,
    recordedProblems: history,
  });

  copyWorkflowArtifact({
    workflow: WORKFLOW,
    name: `${definition.id}-exported-video`,
    source: archived,
    description: 'Customer-saved native MP4 from the fail-closed staged destination.',
  });
  copyFrameArtifact({
    name: `${definition.id}-entry-decoded-export`,
    source: decodedEntry,
    description: `FFmpeg-decoded export frame at exact entry frame ${entry.frame}/${EXPORT_PARITY_FPS}.`,
  });
  copyFrameArtifact({
    name: `${definition.id}-exit-decoded-export`,
    source: decodedExit,
    description: `FFmpeg-decoded export frame at exact exit frame ${exit.frame}/${EXPORT_PARITY_FPS}.`,
  });
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: `${definition.id}-export-verified`,
    description: `${definition.animationType} completed through the native queue/save pipeline and both animated edges independently match preview.`,
    details: {
      animation: definition.animationType,
      easing: definition.animationEasing,
      borderStyle: definition.borderStyle,
      durableSceneRevision: durableScene.sceneRevision,
      queueText: completed.text,
      ...verified,
    },
    focusSelector: '.video-rendering-section .queue-manager-panel',
  });
  return verified;
};
