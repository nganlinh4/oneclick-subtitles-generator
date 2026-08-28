// The three narration backends beyond gTTS and Edge TTS -- F5-TTS, Chatterbox and Gemini Live TTS
// -- are each gated for a different, honest reason (crates/osg-speech/delivery/
// speech-packages.delivery.json, src/components/narration/hooks/useAvailabilityCheck.js):
//   - F5-TTS:    4.28 GiB compressed / 6.47 GiB installed (sizeBytes 4,591,914,866 /
//                unpackedSizeBytes 6,946,445,785). Already the subject of
//                settingsNarrationModelManagement.journey.js's Model Management tab proof.
//   - Chatterbox: 8.93 GiB compressed / 11.12 GiB installed (sizeBytes 9,589,911,396 /
//                unpackedSizeBytes 11,944,441,138) -- the largest narration package in the catalog.
//   - Gemini Live TTS: tiny to install (19.3 MiB / 59.0 MiB) but CREDENTIAL-GATED: its narration
//                method radio only enables once BOTH the package is ready AND a usable Gemini
//                credential exists (useAvailabilityCheck.js:216-217, `geminiAvailable =
//                geminiBackendAvailable && credentialAvailability.available`); a fresh E2E profile
//                has no stored credential, so this is refused at the SAME method-radio boundary
//                referenceVoiceAndPerCueNarration.journey.js already proved honest for F5-TTS
//                (NarrationMethodSelection.js disables the radio itself, so the reference-voice/
//                generate controls for a gated method never even mount).
// None of the three is small enough, or credential-free, to justify a second full generate-and-
// verify path beyond gTTS (narrationGeneration.journey.js) and Edge TTS
// (edgeTtsNarrationGeneration.journey.js). See docs/rewrite/ENGINE_CATALOG_FEASIBILITY.md for the
// full table these numbers come from.
//
// What this journey proves instead, for the whole narration catalog at once, mirroring
// alternateLocalAsrMatrix.journey.js exactly:
//   1. The Tools engine-selection surface never lies: every narration card's data-engine-state is
//      cross-checked against the independent on-disk oracle (data/engine-packages/<packageId>,
//      the SAME store ASR packages use -- crates/osg-engine-packages/src/manager.rs:1433-1436 --
//      keyed by the package id, not the frontend card id; F5-TTS's card id 'f5tts' maps to package
//      id 'f5-tts', src/platform/managedEngineCatalog.js).
//   2. Selecting an uninstalled narration engine offers a real install rather than silently
//      failing: Download starts a real native job (Cancel appearing is the evidence) and
//      cancelling immediately leaves no orphaned bytes.
//   3. There is no "unsupported on this hardware" state for any narration backend either (same
//      grep-confirmed absence of a CUDA/DirectML/CoreML capability check as the ASR catalog); this
//      is recorded as a finding, not asserted as behavior that does not exist.
//
// Runs against the ordinary shared/persistent engine-packages cache; every assertion is scoped to
// one engine's own subdirectory so it is safe and order-independent alongside every other journey.
/* global describe, it */

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { openEditor } from '../support/editor.js';
import { NARRATION_CATALOG_ENGINES, isTruthfulCardState, pickNotInstalledEngine } from '../support/engineCatalogOracle.js';
import {
  engineState, installThenCancelBounded, openToolsSettings, waitForSettledEngineState,
} from '../support/engines.js';
import { directoryShapeDigest } from '../support/settingsSurfaceOracle.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'narration-engine-matrix';
const SETTLE_TIMEOUT_MS = 1_200_000;

const packageDirectory = (root, packageId) => join(root, 'data', 'engine-packages', packageId);

describe('the narration engine catalog reports every entry truthfully and offers a real install', () => {
  it('never lies about install state, and lets a customer start and cleanly cancel a real install', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'this journey requires an isolated application root');

    await openEditor();
    await openToolsSettings();

    const findings = [];
    const existsByPackageId = new Map();
    for (const engine of NARRATION_CATALOG_ENGINES) {
      const settled = await waitForSettledEngineState(engine.cardId, SETTLE_TIMEOUT_MS);
      const digest = directoryShapeDigest(packageDirectory(root, engine.packageId));
      existsByPackageId.set(engine.packageId, digest.exists);
      assert.equal(
        isTruthfulCardState(settled.state, digest.exists),
        true,
        `${engine.cardId} reports data-engine-state="${settled.state}" but its on-disk directory `
          + `${digest.exists ? 'exists' : 'does not exist'} (${packageDirectory(root, engine.packageId)})`,
      );
      findings.push({
        cardId: engine.cardId,
        packageId: engine.packageId,
        domState: settled.state,
        onDisk: digest.exists,
      });
    }
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-catalog-truthful',
      description: 'Every narration catalog engine reports a data-engine-state consistent with its actual on-disk directory.',
      details: { findings },
      focusSelector: '.engines-panel',
    });

    const target = pickNotInstalledEngine(
      NARRATION_CATALOG_ENGINES,
      (packageId) => existsByPackageId.get(packageId) === true,
    );
    assert.ok(
      target !== null,
      `every catalog narration engine already has an on-disk directory in ${join(root, 'data', 'engine-packages')}; `
        + 'no not-installed engine remains to prove the install-offer path against',
    );

    const before = directoryShapeDigest(packageDirectory(root, target.packageId));
    assert.equal(before.exists, false, `${target.cardId} was expected to be not-installed before this proof`);

    const { installing, cancelled } = await installThenCancelBounded(target.cardId);
    assert.ok(installing !== null, `clicking Download on ${target.cardId} produced no engine card`);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-install-begun',
      description: `Clicking Download on ${target.cardId} starts a real native install job with its own Cancel control.`,
      details: { target: target.cardId, installing },
      focusSelector: `[data-engine-id="${target.cardId}"]`,
    });

    assert.equal(cancelled.state, 'not-installed', (
      `cancelling the ${target.cardId} install left it looking installed or corrupt: ${JSON.stringify(cancelled)}`
    ));
    const after = directoryShapeDigest(packageDirectory(root, target.packageId));
    assert.deepEqual(after, before, (
      `cancelling the ${target.cardId} install left orphaned bytes under its package directory`
    ));
    const settledAfterCancel = await engineState(target.cardId);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-cancelled-cleanly',
      description: `Cancelling returns ${target.cardId} to not-installed with its on-disk directory unchanged.`,
      details: { target: target.cardId, cancelled, settledAfterCancel },
      focusSelector: `[data-engine-id="${target.cardId}"]`,
    });
  });
});
