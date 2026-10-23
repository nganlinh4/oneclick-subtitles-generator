// Settings > Tools never lies about any ASR or narration engine, and every catalog offers a real,
// cleanly cancellable install. One launch covers both catalogs.
//
// Full generate-and-verify paths stay with the engines small or already owned elsewhere:
// Faster-Whisper Turbo (localAsrGeneration), gTTS (narrationGeneration) and Edge TTS
// (edgeTtsNarrationGeneration). The other catalog entries are multi-gigabyte downloads in the same
// size class (docs/rewrite/ENGINE_CATALOG_FEASIBILITY.md), or Gemini Live TTS, which is
// credential-gated at the method radio referenceVoiceAndPerCueNarration already proves.
//
// For each catalog:
//   1. Every card's public data-engine-state is cross-checked against an INDEPENDENT oracle, the
//      real on-disk package directory under data/engine-packages/v1/<packageId> (ASR and speech
//      packages share that store; F5-TTS's card id 'f5tts' maps to package id 'f5-tts').
//   2. Download on an engine with no on-disk directory starts a real native job (its own Cancel
//      control is the evidence), and Cancel returns it to not-installed with no orphaned bytes.
// No engine is hardware-gated in this codebase, so no hardware refusal is asserted.
//
// Runs against the shared engine-packages cache; every assertion is scoped to one engine's own
// subdirectory, so it is order-independent whether or not Faster-Whisper Turbo is installed.
/* global $, describe, it */

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { clickControl, openEditor } from '../support/editor.js';
import {
  ASR_CATALOG_ENGINES, enginePackageDirectory, isTruthfulCardState, NARRATION_CATALOG_ENGINES,
  pickNotInstalledEngine,
} from '../support/engineCatalogOracle.js';
import {
  engineState, installThenCancelBounded, openToolsSettings, waitForSettledEngineState,
} from '../support/engines.js';
import { directoryShapeDigest } from '../support/settingsSurfaceOracle.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'engine-catalog-matrix';
// The shared cache may hold a full 7 GiB Faster-Whisper Turbo install, which the product verifies
// byte-for-byte on its first status probe; this matches ensureEngineReady's bound for that probe.
const SETTLE_TIMEOUT_MS = 1_200_000;

const proveCatalog = async ({ root, label, engines, firstStep }) => {
  const step = (offset, name) => `${String(firstStep + offset).padStart(2, '0')}-${label}-${name}`;
  const findings = [];
  const existsByPackageId = new Map();
  for (const engine of engines) {
    const settled = await waitForSettledEngineState(engine.cardId, SETTLE_TIMEOUT_MS);
    const digest = directoryShapeDigest(enginePackageDirectory(root, engine.packageId));
    existsByPackageId.set(engine.packageId, digest.exists);
    assert.equal(
      isTruthfulCardState(settled.state, digest.exists),
      true,
      `${engine.cardId} reports data-engine-state="${settled.state}" but its on-disk directory `
        + `${digest.exists ? 'exists' : 'does not exist'} (${enginePackageDirectory(root, engine.packageId)})`,
    );
    findings.push({
      cardId: engine.cardId, packageId: engine.packageId, domState: settled.state, onDisk: digest.exists,
    });
  }
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: step(0, 'catalog-truthful'),
    description: `Every ${label} catalog engine reports a data-engine-state consistent with its actual on-disk directory.`,
    details: { findings },
    // The whole Tools panel is taller than the Settings viewport; one in-viewport card anchors it.
    focusSelector: `[data-engine-id="${engines[0].cardId}"]`,
  });

  const target = pickNotInstalledEngine(engines, (packageId) => existsByPackageId.get(packageId) === true);
  assert.ok(
    target !== null,
    `every ${label} catalog engine already has an on-disk directory in ${join(root, 'data', 'engine-packages', 'v1')}; `
      + 'no not-installed engine remains to prove the install-offer path against',
  );
  const before = directoryShapeDigest(enginePackageDirectory(root, target.packageId));
  assert.equal(before.exists, false, `${target.cardId} was expected to be not-installed before this proof`);

  const { installing, cancelled } = await installThenCancelBounded(target.cardId);
  assert.ok(installing !== null, `clicking Download on ${target.cardId} produced no engine card`);
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: step(1, 'install-begun'),
    description: `Clicking Download on ${target.cardId} starts a real native install job with its own Cancel control.`,
    details: { target: target.cardId, installing },
    focusSelector: `[data-engine-id="${target.cardId}"]`,
  });

  assert.equal(cancelled.state, 'not-installed', (
    `cancelling the ${target.cardId} install left it looking installed or corrupt: ${JSON.stringify(cancelled)}`
  ));
  const after = directoryShapeDigest(enginePackageDirectory(root, target.packageId));
  assert.deepEqual(after, before, (
    `cancelling the ${target.cardId} install left orphaned bytes under its package directory`
  ));
  const settledAfterCancel = await engineState(target.cardId);
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: step(2, 'cancelled-cleanly'),
    description: `Cancelling returns ${target.cardId} to not-installed with its on-disk directory unchanged.`,
    details: { target: target.cardId, cancelled, settledAfterCancel },
    focusSelector: `[data-engine-id="${target.cardId}"]`,
  });
};

describe('the ASR and narration engine catalogs report every entry truthfully and offer a real install', () => {
  it('never lie about install state, and let a customer start and cleanly cancel a real install', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'this journey requires an isolated application root');

    await openEditor();
    await openToolsSettings();
    await proveCatalog({ root, label: 'asr', engines: ASR_CATALOG_ENGINES, firstStep: 1 });
    // Reopen Tools so the narration cards start from the same scroll position a customer sees.
    await clickControl('.settings-modal .cancel-btn');
    await $('.settings-modal').waitForExist({
      reverse: true, timeout: 30_000, timeoutMsg: 'Settings never closed after the ASR catalog proof',
    });
    await openToolsSettings();
    await proveCatalog({ root, label: 'narration', engines: NARRATION_CATALOG_ENGINES, firstStep: 4 });
  });
});
