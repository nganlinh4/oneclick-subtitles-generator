// AUTHORED, NOT EXECUTED in this pass -- see e2e/inventory.json's "aboutAndDesktopUpdater" entry.
// Never launches the desktop binary or wdio from this lane; the next lane to run it owns turning
// this into a passing (or honestly failing) real-binary attempt.
//
// GROUND TRUTH READ FROM SOURCE BEFORE WRITING ANY STEP.
//
// THE E2E-AUTOMATION BINARY'S UPDATER IS DETERMINISTICALLY DISABLED AT COMPILE TIME, NOT ONLY BY
// A MISSING KEY. apps/desktop/src-tauri/src/updater.rs's `update_channel_state()`:
//   if cfg!(any(feature = "unsigned-local-build", feature = "e2e-automation")) {
//       return UpdateChannelState::Disabled;
//   }
// runs BEFORE it ever checks the compiled minisign public key, and `Disabled`'s
// `quiescent_outcome()` makes `app_update_check` return `{ configured: false, update: None }`
// WITHOUT constructing an updater or opening a socket -- confirmed by `build_updater` (the only
// place a network endpoint is configured) never being called on that path. This journey therefore
// proves the disabled-channel path honestly: it is not a workaround for a missing credential, it is
// the actual behaviour of every binary these WebdriverIO journeys ever run against.
//
// THE COMPILE-TIME SEAM FOR A REAL UPDATE EXISTS, AND IS STRUCTURALLY UNREACHABLE FROM THIS
// HARNESS. apps/desktop/src-tauri/src/lib.rs:8-9:
//   #[cfg(all(feature = "ci-updater-fixture", feature = "e2e-automation"))]
//   compile_error!("the ci-updater-fixture and e2e-automation channels are mutually exclusive");
// makes the two channels impossible to combine in one binary. `ci-updater-fixture` (a local,
// self-signed HTTPS endpoint accepted only by that compiled client -- updater.rs:365-387) is
// exercised for real by .github/workflows/updater-smoke.yml, which builds with
// `--features production,ci-updater-fixture` (NOT e2e-automation) on its own isolated Windows CI
// runner and is already tracked by this inventory's own `installedGolden`/`installedUpdaterLifecycle`
// entries. No file under e2e/journeys can ever reach it: every journey here runs against the
// e2e-automation binary (see e2e/inventory.json's `binary.e2e`), which the compile_error above
// forbids from ever containing the fixture. The updater seam verdict is therefore: real, honestly
// unreachable from this harness, and already proven elsewhere -- not a gap this journey papers over.
//
// ABOUT REACHES THE SAME NATIVE UPDATER, NOT A SEPARATE LEGACY CHECK.
// src/components/settings/tabs/AboutTab.js calls src/utils/gitVersion.js's getGitVersion()
// (-> platform/updateService.js's getDesktopAppVersion() -> the native `app_health` command, for
// the CURRENT version) and getLatestVersion() (-> platform/startupUpdateCoordinator.js's
// startStartupUpdateCheck() -> checkDesktopUpdate() -> the native `app_update_check` command) on
// `window.isTauri`. A disabled channel has no latest-release result and must remain neutral in
// About: neither an error nor a claim that the installed version is the latest release.
//
// THE DIAGNOSTIC LOG IS A POSITIVE ORACLE HERE, NOT JUST AN ABSENCE CHECK.
// `app_update_check` unconditionally records "app-update.check_started" first, then --on the
// disabled path-- "app-update.check_completed" with `outcome: "disabled"`
// (updater.rs:141-161's `diagnostics::record` calls) BEFORE returning. Both are real, both are
// asserted directly, matching how this suite already treats the JSONL diagnostic log as
// independent product-owned evidence (geminiCredentialBoundary.journey.js's own log assertion).

/* global $, browser, describe, document, it */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl, openEditor } from '../support/editor.js';
import { clickSettingsControl } from '../support/settingsControls.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'about-and-updater-lifecycle';

const waitUntilWithDiagnostic = async (predicate, { diagnostic, ...options }) => {
  try {
    return await browser.waitUntil(predicate, { ...options, timeoutMsg: 'condition did not settle before its timeout' });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
};

const aboutSurface = () => browser.execute(() => {
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
  return {
    modalPresent: document.querySelector('.settings-modal') !== null,
    aboutRootPresent: document.querySelector('.about-section') !== null,
    versionDisplay: text('.version-display'),
    checking: document.querySelector('.checking-update') !== null,
    updateCheckFailedPresent: document.querySelector('.update-check-failed') !== null,
    updateCheckFailedText: text('.update-check-failed'),
    updateAvailablePresent: document.querySelector('.update-notification') !== null,
    upToDatePresent: document.querySelector('.up-to-date') !== null,
    replayOnboardingPresent: document.querySelector('.replay-onboarding-button') !== null,
  };
});

describe('About reports the real installed version and the updater proves its compiled-disabled channel', () => {
  it('opens Settings, reaches About through real navigation, and finds the updater deterministically disabled with no network attempt', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the about/updater journey requires an isolated root');
    // About is application state, not project state. Opening media here schedules waveform work
    // that can legitimately finish while the updater is checked and makes an unrelated artifact
    // look updater-owned. Clear onboarding only; keep this proof causally isolated.
    await openEditor();
    const before = durableState(root);

    await clickControl('[data-app-action="open-settings"]');
    const modal = await $('.settings-modal');
    await modal.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'Settings never opened' });

    await clickSettingsControl('[data-settings-tab="about"]');
    await browser.waitUntil(
      async () => browser.execute(() => document.querySelector('.settings-tab.active')?.getAttribute('data-settings-tab') === 'about'),
      { timeout: 15_000, interval: 100, timeoutMsg: 'the About tab never activated' },
    );

    // The current-version half needs only `app_health`, which is always answered regardless of the
    // updater's channel; it settles first and independently of the update-check race below.
    let surface = null;
    await waitUntilWithDiagnostic(async () => {
      surface = await aboutSurface();
      return surface.aboutRootPresent && typeof surface.versionDisplay === 'string' && surface.versionDisplay.length > 0;
    }, {
      timeout: 30_000,
      interval: 250,
      diagnostic: () => `the About panel never reported a current version: ${JSON.stringify(surface)}`,
    });
    assert.match(surface.versionDisplay, /v\d+\.\d+\.\d+/u, 'the current version display did not show a real semantic version');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-about-current-version',
      description: 'About is reached through real Settings navigation and reports the real installed application version, independent of the updater channel.',
      details: { versionDisplay: surface.versionDisplay },
      focusSelector: '.version-info',
    });

    // A compiled-disabled channel settles without presenting an update, failure, or latest claim.
    await waitUntilWithDiagnostic(async () => {
      surface = await aboutSurface();
      return !surface.checking;
    }, {
      timeout: 30_000,
      interval: 250,
      diagnostic: () => `the About update check never settled: ${JSON.stringify(surface)}`,
    });
    assert.equal(surface.updateCheckFailedPresent, false, 'a disabled updater channel was misreported as a failed check');
    assert.equal(surface.updateAvailablePresent, false, 'a disabled updater channel reported an update as available');
    assert.equal(surface.upToDatePresent, false, 'a disabled updater channel claimed a latest release without checking');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-updater-disabled-channel',
      description: 'The compiled-disabled updater channel settles neutrally in About; the installed version remains visible without a check failure or a latest-release claim.',
      details: { surface },
      focusSelector: '.version-info',
    });

    const after = durableState(root);
    // The claim is that a disabled-channel update check creates no work of its own. The job
    // registry has no updater kind at all (crates/osg-domain/src/jobs.rs JobKind), so filtering
    // for one would make this assertion vacuous. Instead allow exactly the kinds that having
    // media open legitimately schedules, and reject any other new job - a rogue updater would
    // surface as a downloadMedia or installEngine row, which this still catches.
    const mediaBackgroundKinds = new Set(['importMedia', 'probeMedia', 'processMedia', 'generateWaveform']);
    const beforeIds = new Set(before.jobs.map(({ id }) => id));
    const unexplained = after.jobs.filter(
      ({ id, kind }) => !beforeIds.has(id) && !mediaBackgroundKinds.has(kind),
    );
    assert.deepEqual(
      unexplained,
      [],
      `the disabled-channel update check registered durable work of its own: ${JSON.stringify(unexplained)}`,
    );
    assert.deepEqual(after.artifacts, before.artifacts, 'the disabled-channel update check produced a durable artifact');

    const log = readFileSync(join(root, 'logs', 'osg.log'), 'utf8');
    assert.match(log, /"event":"app-update\.check_started"/u, 'the native updater never recorded that a check started');
    assert.match(log, /"event":"app-update\.check_completed"/u, 'the native updater never recorded that its check completed');
    assert.match(log, /"outcome":"disabled"/u, 'the native updater did not record its compiled-disabled outcome');
    // The disabled path never constructs an updater or opens a socket (update_channel_state's
    // quiescent_outcome short-circuits before build_updater is ever called), so no install/progress
    // lifecycle event can exist either.
    assert.doesNotMatch(log, /"event":"app-update\.(?:install_failed|handoff)"/u, 'a disabled-channel check attempted an install');

    // Replay Welcome Animation is a genuinely credential-free, provider-free About control;
    // proving it is reachable (not clicking it, which would reload the whole application and end
    // this journey's own session) documents the boundary between what About needs a signed
    // release for and what it never did.
    assert.equal(surface.replayOnboardingPresent, true, 'the credential-free Replay Welcome Animation control is missing from About');

    await clickControl('[data-settings-action="close"]');
    await modal.waitForExist({ reverse: true, timeout: 30_000 });
  });
});
