// The narration Model Management tab (src/components/settings/ModelManagementTab.js) manages
// exactly one catalog-verified package: F5-TTS v1 Base. Its Windows delivery is 4.59 GiB compressed
// and 6.9 GiB installed (crates/osg-speech/delivery/speech-packages.delivery.json), so a real,
// unattended, credential-free journey cannot complete a full install without turning this suite into
// a multi-gigabyte download every run. What it CAN honestly prove, entirely from real controls and a
// real (small, bounded) native download:
//   1. On a profile whose engine-packages store is genuinely empty -- not merely reported empty --
//      the panel truthfully shows "not installed" and an enabled Install control.
//   2. Clicking Install starts a REAL native job (a real manifest fetch against the real delivery
//      host, matching the exact command native tools install proves independently). The panel proves
//      this with the customer's own evidence: the Cancel control the product itself renders only
//      while `status.operation` is populated (src/components/settings/ModelManagementTab.js:239-243).
//   3. Cancelling immediately, before any large source archive can materially progress, returns the
//      panel to the same truthful "not installed" state and leaves NO orphaned bytes or leases: the
//      native package store's owned staging directory is removed on cancellation by
//      crates/osg-runtime-staging/src/lib.rs:432-513 (`OwnedStagingDirectory`'s `Drop` impl runs
//      `cleanup()`, which removes the staged tree and releases its durable ownership journal). This
//      journey verifies that promise independently with a before/after filesystem digest.
// Full install-then-remove-then-repair coverage for a small package already exists
// (nativeToolsInstall.journey.js, media-tools/yt-dlp/deno). The size constraint above is why this
// journey does not attempt the same for F5-TTS; see e2e/inventory.json for the recorded rationale.
/* global browser, describe, document, it */

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { clickControl, openEditor } from '../support/editor.js';
import { directoryShapeDigest } from '../support/settingsSurfaceOracle.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'settings-narration-model-management';
const PHASE = process.env.OSG_E2E_MODEL_MANAGEMENT_PHASE;
const PANEL = '.narration-model-panel';

const openModelManagement = async () => {
  await openEditor();
  await clickControl('[data-app-action="open-settings"]');
  const tab = '[data-settings-tab="model-management"]';
  await clickControl(tab);
  await browser.waitUntil(async () => (await browser.execute(
    (selector) => document.querySelector(selector)?.getAttribute('class') ?? '', tab,
  )).includes('active'), {
    timeout: 30_000, interval: 250, timeoutMsg: 'the Model Management settings tab never activated',
  });
};

const panelSnapshot = () => browser.execute((selector) => {
  const panel = document.querySelector(selector);
  if (panel === null) return null;
  return {
    state: panel.getAttribute('data-model-package-state'),
    packageId: panel.getAttribute('data-model-package-id'),
    installVisible: panel.querySelector('[data-model-action="install"]') !== null,
    cancelVisible: panel.querySelector('[data-model-action="cancel"]') !== null,
    removeVisible: panel.querySelector('[data-model-action="remove"]') !== null,
    stateText: panel.querySelector('.narration-model-package__state')?.textContent?.trim() ?? null,
  };
}, PANEL);

const waitForPanel = async (predicate, diagnostic, timeout = 60_000) => {
  let last = null;
  try {
    await browser.waitUntil(async () => {
      last = await panelSnapshot();
      return last !== null && predicate(last);
    }, { timeout, interval: 250, timeoutMsg: 'the narration model panel condition was not met' });
  } catch (error) {
    throw new Error(`${diagnostic}: ${JSON.stringify(last)}`, { cause: error });
  }
  return last;
};

describe('the narration model package honestly reports and safely cancels on an empty profile', () => {
  it('reports not-installed truthfully, then starts and cleanly cancels a real install', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'this journey requires an isolated application root');
    assert.equal(PHASE, 'manage', 'run this journey through scenarios/settingsNarrationModelManagement.mjs');

    const enginePackagesRoot = join(root, 'data', 'engine-packages');
    const emptyBaseline = directoryShapeDigest(enginePackagesRoot);

    await openModelManagement();
    const notInstalled = await waitForPanel(
      (snapshot) => snapshot.state !== null && snapshot.state !== 'checking',
      'narration model status never settled',
    );
    assert.equal(notInstalled.packageId, 'f5tts-v1-base');
    assert.equal(notInstalled.state, 'missing', 'an empty engine-packages store was not honestly reported as not installed');
    assert.equal(notInstalled.installVisible, true, 'a not-installed package did not offer Install');
    assert.equal(notInstalled.cancelVisible, false);
    assert.equal(notInstalled.removeVisible, false);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-truthfully-not-installed',
      description: 'On a genuinely empty package store, the panel reports "not installed" and offers only Install.',
      details: { notInstalled, emptyBaseline },
      focusSelector: PANEL,
    });

    await clickControl(`${PANEL} [data-model-action="install"]`);
    // The Cancel control only renders while status.operation is non-null (ModelManagementTab.js:
    // 239-243), so its appearance IS the product's own evidence that a real job was accepted and is
    // running -- not a probe of a private queue. Cancelling as soon as it appears, rather than after
    // any observed progress, is what keeps this a bounded, cheap, real network interaction instead of
    // a multi-gigabyte download.
    const installing = await waitForPanel(
      (snapshot) => snapshot.cancelVisible,
      'clicking Install never produced a cancellable operation',
      120_000,
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-install-begun',
      description: 'A real native install job starts and exposes a Cancel control.',
      details: { installing },
      focusSelector: PANEL,
    });

    await clickControl(`${PANEL} [data-model-action="cancel"]`);
    const cancelled = await waitForPanel(
      (snapshot) => !snapshot.cancelVisible && snapshot.state !== 'checking',
      'cancelling the install never returned the panel to an idle state',
      120_000,
    );
    assert.equal(cancelled.state, 'missing', 'cancelling the install left the package looking installed or corrupt');
    assert.equal(cancelled.installVisible, true, 'a cancelled, not-installed package no longer offers Install');
    assert.equal(cancelled.removeVisible, false, 'a cancelled install left a Remove control for nothing installed');

    const afterCancelDigest = directoryShapeDigest(enginePackagesRoot);
    assert.deepEqual(
      afterCancelDigest,
      emptyBaseline,
      'cancelling the install left orphaned bytes or lease files in the engine-packages store',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-cancelled-cleanly',
      description: 'Cancelling returns the panel to "not installed" and the package store to its exact pre-install shape.',
      details: { cancelled, afterCancelDigest },
      focusSelector: PANEL,
    });

    await clickControl('[data-settings-action="close"]');
  });
});
