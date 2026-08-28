// The four ASR catalog engines beyond Faster-Whisper Turbo (parakeet, faster-whisper-large-v3,
// qwen3-asr-1.7b, qwen3-asr-0.6b) are all in the same 5.4-9.2 GiB compressed / 7.6-11.3 GiB
// installed size class as the already-proven engine (crates/osg-engine-packages/delivery/
// engine-packages.delivery.json), so completing a second full download-and-transcribe run would
// only re-exercise the exact install/transcribe pipeline localAsrGeneration.journey.js already
// proves, at multi-gigabyte/multi-hour cost, without adding new coverage. None is small enough to
// justify a second full generate-and-verify path; see docs/rewrite/ENGINE_CATALOG_FEASIBILITY.md
// for the exact per-engine numbers this reasoning is based on.
//
// What this journey DOES prove, cheaply and for every catalog engine at once:
//   1. The Tools engine-selection surface (src/components/engines/EnginesPanel.js /
//      EngineCard.js) never lies. Each card's public data-engine-state is cross-checked against
//      an INDEPENDENT oracle -- not the same native status call the card itself renders from --
//      the real on-disk package directory under data/engine-packages/<id> (crates/
//      osg-engine-packages/src/manager.rs:1433-1436's ensure_component_layout keys the store by
//      exactly this id). A card claiming installed with no bytes on disk, or not-installed with
//      real bytes present, would fail here.
//   2. Selecting an uninstalled engine offers a real install rather than silently failing:
//      clicking Download on whichever catalog engine has no on-disk directory starts a real
//      native job (its own Cancel control appearing is the evidence -- the same idiom
//      settingsNarrationModelManagement.journey.js already established for the Model Management
//      panel), and cancelling immediately returns it to not-installed with the exact same "no
//      bytes on disk" oracle used above, leaving no orphaned bytes.
//   3. There is no "unsupported on this hardware" state to refuse honestly: none of these five
//      engines is hardware-gated in this codebase (grep across crates/osg-asr/src and
//      apps/desktop/src-tauri/src/asr.rs finds no CUDA/DirectML/CoreML capability check --
//      Parakeet's ONNX runtime, CTranslate2 and PyTorch all ship as CPU-executable bundled
//      runtimes). Fabricating a hardware-refusal assertion here would test something the product
//      does not claim; this is recorded as a finding instead, not asserted as behavior.
//
// Runs against the ordinary shared/persistent engine-packages cache (no isolated store needed):
// every assertion is scoped to one engine's own subdirectory, so it is safe and order-independent
// whether or not other journeys have already installed Faster-Whisper Turbo in this cache.
/* global describe, it */

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { ASR_CATALOG_ENGINES, isTruthfulCardState, pickNotInstalledEngine } from '../support/engineCatalogOracle.js';
import { openEditor } from '../support/editor.js';
import {
  engineState, installThenCancelBounded, openToolsSettings, waitForSettledEngineState,
} from '../support/engines.js';
import { directoryShapeDigest } from '../support/settingsSurfaceOracle.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'alternate-local-asr-matrix';
// The shared cache may already hold a full 7 GiB Faster-Whisper Turbo install (verified byte-for-
// byte on first probe by the product itself); the settle wait must outlive that, matching
// ensureEngineReady's own 20-minute bound for the identical probe (e2e/support/engines.js).
const SETTLE_TIMEOUT_MS = 1_200_000;

const packageDirectory = (root, packageId) => join(root, 'data', 'engine-packages', packageId);

describe('the ASR engine catalog reports every entry truthfully and offers a real install', () => {
  it('never lies about install state, and lets a customer start and cleanly cancel a real install', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'this journey requires an isolated application root');

    await openEditor();
    await openToolsSettings();

    const findings = [];
    const existsByPackageId = new Map();
    for (const engine of ASR_CATALOG_ENGINES) {
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
      description: 'Every ASR catalog engine reports a data-engine-state consistent with its actual on-disk directory.',
      details: { findings },
      // `.engines-panel` is the whole Tools tab's content root -- roughly ten engine cards plus the
      // native-tools list -- taller than the settings viewport captureWorkflowStep requires a
      // settings-modal focus target to already fit inside untouched (no scroll assist is given for
      // settings-modal descendants). The assertions above already check every catalog engine; the
      // screenshot only needs one compact, in-viewport anchor tied to the material under test, the
      // same idiom settingsSurface.journey.js:804 uses for its own oversized section.
      focusSelector: `[data-engine-id="${ASR_CATALOG_ENGINES[0].cardId}"]`,
    });

    const target = pickNotInstalledEngine(
      ASR_CATALOG_ENGINES,
      (packageId) => existsByPackageId.get(packageId) === true,
    );
    assert.ok(
      target !== null,
      `every catalog ASR engine already has an on-disk directory in ${join(root, 'data', 'engine-packages')}; `
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
