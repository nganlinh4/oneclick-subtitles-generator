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
//
// Claims 2 and 3 have a host precondition the product enforces and this journey must respect.
// crates/osg-engine-packages/src/manager.rs:1620-1632 refuses an install -- before the first
// delivery byte is fetched -- unless the package store's volume holds the compressed download plus
// the unpacked tree plus a 256 MiB reserve. For the Windows F5-TTS release that is ~11.0 GiB. On a
// host below that line the job starts and dies in the same instant, so `status.operation` is never
// observable and the Cancel control the proof depends on can never render. That is the product
// correctly refusing a multi-gigabyte download it cannot finish, not a defect, so this journey
// measures the real requirement against the real volume FIRST and proves whichever honest outcome
// this host can actually reach: the start-and-cancel proof where there is room, and the refusal
// proof (truthful status preserved, not one orphaned byte written) where there is not. Both
// branches record the measured numbers, so the evidence always says which claim it carries.
/* global browser, describe, document, it */

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { clickControl, openEditor } from '../support/editor.js';
import { clickSettingsControl, revealSettingsSection } from '../support/settingsControls.js';
import { directoryShapeDigest } from '../support/settingsSurfaceOracle.js';
import { availableStoreBytes, speechPackageInstallRequirement } from '../support/speechPackageCapacity.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'settings-narration-model-management';
const PHASE = process.env.OSG_E2E_MODEL_MANAGEMENT_PHASE;
const PANEL = '.narration-model-panel';
const BACKEND = 'f5-tts';

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

/**
 * Exactly the selector and normalization the evidence publisher uses
 * (support/workflowEvidence.js's collectVisibleStateFromPage), so text observed here matches an
 * `allowVisibleProblems.errorToasts` entry character for character.
 */
const visibleErrorToasts = () => browser.execute(() => [...new Set(
  [...document.querySelectorAll('.toast-item.live .toast.toast-error')]
    .map((node) => (node.innerText || node.textContent || '').trim().replace(/\s+/gu, ' '))
    .filter(Boolean),
)]);

/**
 * Wait for the product's honest refusal of an install this host cannot hold: the panel stays at its
 * truthful not-installed status while a NEW customer-visible error appears. Error toasts are
 * accumulated across polls because a toast retires on its own timer (8 s,
 * src/utils/toastUtils.js:76) and must not be missed by an unlucky sample.
 */
const waitForRefusal = async (toastsBeforeClick, timeout = 120_000) => {
  const announced = new Set();
  let last = null;
  try {
    await browser.waitUntil(async () => {
      last = await panelSnapshot();
      for (const toast of await visibleErrorToasts()) {
        if (!toastsBeforeClick.includes(toast)) announced.add(toast);
      }
      return last !== null && !last.cancelVisible && last.state === 'missing' && announced.size > 0;
    }, {
      timeout,
      interval: 250,
      timeoutMsg: 'the narration model panel never reached an honest refusal',
    });
  } catch (error) {
    throw new Error(
      'clicking Install on a host below the package\'s disk requirement neither started an '
      + `operation nor told the customer anything: ${JSON.stringify({ panel: last, announced: [...announced] })}`,
      { cause: error },
    );
  }
  return { panel: last, announced: [...announced] };
};

describe('the narration model package honestly reports and safely handles Install on an empty profile', () => {
  it('reports not-installed truthfully, then either cleanly cancels or honestly refuses a real install', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'this journey requires an isolated application root');
    assert.equal(PHASE, 'manage', 'run this journey through scenarios/settingsNarrationModelManagement.mjs');

    const enginePackagesRoot = join(root, 'data', 'engine-packages');
    const emptyBaseline = directoryShapeDigest(enginePackagesRoot);
    // Measured against the same catalog release and the same volume the native installer checks.
    const requirement = speechPackageInstallRequirement(BACKEND);
    const freeBytes = availableStoreBytes(enginePackagesRoot);
    const capacity = { ...requirement, freeBytes, sufficient: freeBytes >= requirement.requiredBytes };

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
    // 'missing' is only a truthful state when the catalog really does offer this target a release
    // (src/platform/speechPackageService.js:249-257 ties state to deliveryAvailable). An empty
    // catalog entry must surface as 'unavailable' with no Install at all, never as an offer.
    assert.equal(
      requirement.deliveryAvailable,
      true,
      'the panel offered Install for a target whose reviewed delivery catalog has no release',
    );
    await revealSettingsSection(PANEL);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-truthfully-not-installed',
      description: 'On a genuinely empty package store, the panel reports "not installed" and offers only Install.',
      details: { notInstalled, emptyBaseline, capacity },
      focusSelector: PANEL,
    });

    const toastsBeforeClick = await visibleErrorToasts();
    // clickSettingsControl (not clickControl): this panel's controls live inside .settings-content
    // and can end up under the sticky .settings-footer (e2e/support/settingsControls.js).
    await clickSettingsControl(`${PANEL} [data-model-action="install"]`);

    if (!capacity.sufficient) {
      // This host cannot hold the package, so the native installer fails the job on its own
      // pre-download capacity check (manager.rs:1620-1632) and no cancellable operation can ever
      // exist. What the customer must still get is the truth: the status never claims progress or
      // installation, the refusal is announced, and nothing is left on disk.
      const refusal = await waitForRefusal(toastsBeforeClick);
      assert.equal(refusal.panel.state, 'missing', 'a refused install left the package looking installed or corrupt');
      assert.equal(refusal.panel.installVisible, true, 'a refused install stopped offering Install');
      assert.equal(refusal.panel.removeVisible, false, 'a refused install left a Remove control for nothing installed');
      const afterRefusalDigest = directoryShapeDigest(enginePackagesRoot);
      assert.deepEqual(
        afterRefusalDigest,
        emptyBaseline,
        'a refused install wrote bytes into the engine-packages store',
      );
      await revealSettingsSection(PANEL);
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '02-refused-without-room',
        description: 'Below the package\'s real disk requirement the install refuses, keeps the truthful "not installed" status and writes nothing.',
        details: { capacity, refusal, afterRefusalDigest },
        focusSelector: PANEL,
        allowVisibleProblems: {
          errorToasts: refusal.announced.slice(0, 4).map((text) => ({
            text,
            reason: 'The announced refusal is the customer-visible state this step documents.',
          })),
        },
      });
      await clickControl('[data-settings-action="close"]');
      return;
    }

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
    await revealSettingsSection(PANEL);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-install-begun',
      description: 'A real native install job starts and exposes a Cancel control.',
      details: { installing, capacity },
      focusSelector: PANEL,
    });

    await clickSettingsControl(`${PANEL} [data-model-action="cancel"]`);
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
    await revealSettingsSection(PANEL);
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
