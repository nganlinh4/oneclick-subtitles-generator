// settingsSurface.journey.js already proves factory reset preserves the active project, media, cues
// and native workspace identity, restores first-run onboarding, and leaves the SHARED (persistent,
// cross-journey) native-tools and engine-packages stores byte-for-byte unchanged -- but it never
// actually deletes an installed tool (it deliberately only proves the confirm/cancel gesture, because
// deleting from the shared cache would force every other journey to re-download it) and it never
// stores a real credential (it asserts `credential_refs` is EMPTY before resetting, as a safety
// guard). Both are real gaps this journey owns, on a private isolated native-tools store this run
// does not share with anything else:
//   1. Tool removal deletes exactly the managed tool tree. yt-dlp is installed alone (the smallest
//      catalog tool, an 18 MB Windows download -- crates/osg-native-tools/delivery/
//      native-tools.delivery.json), removed through the same two-step public confirm nativeToolsInstall
//      and settingsSurface use, and a directory-shape digest before install and after removal must be
//      identical: crates/osg-native-tools/src/manager.rs:439-533 renames the installed version into
//      `.trash` and synchronously cleans it up within the SAME removal call before the command
//      returns, so nothing exists that was not there when the store was empty.
//   2. Factory reset clears what it claims. It stores one real (network-free, local-only) credential
//      through the public API Keys tab, then factory-resets, and reads `credential_refs` back to 0 --
//      exercising src/components/settings/SettingsModal.js:84-89 `clearNativeApplicationState`'s
//      `clearCredentials()` (src/platform/credentialStateController.js:450-475), which
//      `credential_delete`s every stored credential. This is the one `clearNativeApplicationState`
//      call settingsSurface never exercises, because it deliberately keeps that profile credential-free.
/* global $, browser, describe, document, it */

import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import process from 'node:process';

import { withDatabase } from '../support/database.js';
import { clickControl, openEditor, waitForEditorReady } from '../support/editor.js';
import { directoryShapeDigest } from '../support/settingsSurfaceOracle.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'settings-tools-remove-and-factory-reset';
const PHASE = process.env.OSG_E2E_TOOLS_RESET_PHASE;
const TOOL_ID = 'yt-dlp';
const TOOL_ROW = `[data-native-tool-id="${TOOL_ID}"]`;
const GENIUS_TOKEN = 'osg-e2e-disposable-genius-token-never-sent-over-the-network';

const credentialReferenceCount = (root) => withDatabase(root, (database) => Number(
  database.prepare('SELECT COUNT(*) AS count FROM credential_refs').get().count,
));

const openTools = async () => {
  await clickControl('[data-app-action="open-settings"]');
  await clickControl('[data-settings-tab="tools"]');
  await browser.waitUntil(async () => browser.execute(
    () => document.querySelector('[data-settings-panel="tools"].active') !== null,
  ), { timeout: 30_000, interval: 250, timeoutMsg: 'the Tools settings panel never activated' });
};

const toolRowState = () => browser.execute((selector) => {
  const row = document.querySelector(selector);
  if (row === null) return null;
  const states = ['unavailable', 'missing', 'installed', 'corrupt', 'installing', 'removing'];
  return states.find((state) => row.classList.contains(`engine-card--${state}`)) ?? null;
}, TOOL_ROW);

const waitForToolState = async (expected, diagnostic, timeout = 20 * 60 * 1_000) => {
  let last = null;
  try {
    await browser.waitUntil(async () => {
      last = await toolRowState();
      return last === expected;
    }, { timeout, interval: 500, timeoutMsg: 'the native tool row never reached the expected state' });
  } catch (error) {
    throw new Error(`${diagnostic}; last saw "${last}"`, { cause: error });
  }
  return last;
};

describe('a customer permanently removes a tool, then a factory reset clears their stored credential', () => {
  it('deletes exactly the managed tool tree and clears credential_refs while preserving everything else', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'this journey requires an isolated application root');
    assert.equal(
      PHASE,
      'run',
      'run this journey through scenarios/settingsToolsRemoveAndFactoryReset.mjs, never the default '
        + 'sweep -- it requires the isolated (keepNativeTools: false) cache policy and would otherwise '
        + 'delete a tool from the SHARED persistent cache other journeys reuse',
    );
    // NOT the shared NATIVE_TOOLS_CACHE other journeys junction in: this scenario requests
    // keepNativeTools: false, so this run's `data/native-tools` is a private, disposable directory
    // only this process can see, which is what makes a real delete-and-verify safe here.
    const toolsRoot = join(root, 'data', 'native-tools');

    await openEditor();
    await openTools();
    const notInstalled = await waitForToolState(
      'missing',
      'the isolated native-tools store did not truthfully report yt-dlp as missing',
    );
    assert.equal(notInstalled, 'missing');
    // Captured only once the status probe has fully settled, so this baseline reflects whatever the
    // store legitimately holds at rest -- not a snapshot mid-probe.
    const emptyBaseline = directoryShapeDigest(toolsRoot);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-tool-missing-on-isolated-profile',
      description: 'A private, empty native-tools store truthfully reports yt-dlp as not installed.',
      details: { emptyBaseline },
      focusSelector: TOOL_ROW,
    });

    await clickControl(`${TOOL_ROW} [data-tool-action="install"]`);
    await waitForToolState('installed', 'installing yt-dlp on the isolated profile never completed');
    const installedDigest = directoryShapeDigest(toolsRoot);
    assert.notDeepEqual(installedDigest, emptyBaseline, 'installing yt-dlp left the store looking empty');
    assert.ok(installedDigest.files > 0, 'installing yt-dlp wrote no files');

    await clickControl(`${TOOL_ROW} [data-tool-action="remove-request"]`);
    const confirm = await $(`${TOOL_ROW} [data-tool-action="remove-confirm"]`);
    await confirm.waitForDisplayed({ timeout: 10_000 });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-real-removal-confirmation',
      description: 'Removing the installed tool requires the same explicit second public action nativeToolsInstall and settingsSurface both use.',
      details: { installedDigest },
      focusSelector: TOOL_ROW,
    });
    await clickControl(`${TOOL_ROW} [data-tool-action="remove-confirm"]`);
    await waitForToolState('missing', 'removing yt-dlp never returned it to not-installed');

    const afterRemovalDigest = directoryShapeDigest(toolsRoot);
    assert.deepEqual(
      afterRemovalDigest,
      emptyBaseline,
      'removal left bytes behind that were not present before yt-dlp was installed',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-tool-deleted',
      description: 'Removal deletes exactly the managed tool tree: the store returns to its exact pre-install shape.',
      details: { afterRemovalDigest },
      focusSelector: TOOL_ROW,
    });

    // Factory reset's credential-clearing claim, on a profile that actually holds one.
    await clickControl('[data-settings-tab="api-keys"]');
    const geniusInput = await $('#genius-key-input');
    await geniusInput.waitForDisplayed({ timeout: 15_000 });
    await geniusInput.setValue(GENIUS_TOKEN);
    const save = await $('.save-btn');
    await browser.waitUntil(async () => !(await save.getAttribute('disabled')), {
      timeout: 10_000, interval: 100, timeoutMsg: 'Settings never marked the credential edit as saveable',
    });
    await clickControl('.save-btn');
    await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });

    const credentialsBeforeReset = credentialReferenceCount(root);
    assert.equal(credentialsBeforeReset, 1, 'saving one Genius credential did not create exactly one credential_refs row');

    await clickControl('[data-app-action="open-settings"]');
    await clickControl('.factory-reset-btn');
    const resetToast = await $('.toast.toast-warning');
    await resetToast.waitForDisplayed({ timeout: 10_000, timeoutMsg: 'factory reset skipped confirmation' });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-factory-reset-confirmation',
      description: 'Factory reset requires the same explicit warning and confirmation as settingsSurface, immediately before it clears a real stored credential.',
      details: { credentialsBeforeReset },
      focusSelector: '.toast.toast-warning',
    });
    await clickControl('.toast.toast-warning .toast-button');

    await browser.waitUntil(async () => {
      try {
        return await browser.execute(() => document.querySelector('.onboarding-overlay') !== null);
      } catch {
        return false;
      }
    }, {
      timeout: 90_000,
      interval: 250,
      timeoutMsg: 'factory reset did not reload into the clean-install public surface',
    });
    await waitForEditorReady();
    const onboarding = await openEditor();
    assert.equal(onboarding.dismissedOverlay, true, 'factory reset did not restore first-run onboarding');

    const credentialsAfterReset = credentialReferenceCount(root);
    assert.equal(credentialsAfterReset, 0, 'factory reset left the stored Genius credential reference behind');

    const nativeToolsAfterReset = directoryShapeDigest(toolsRoot);
    assert.deepEqual(
      nativeToolsAfterReset,
      emptyBaseline,
      'factory reset changed the isolated native-tools store',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-factory-reset-cleared-credential',
      description: 'After reset, the stored credential reference is gone and the already-empty native-tools store is unchanged.',
      details: { credentialsBeforeReset, credentialsAfterReset, nativeToolsAfterReset },
      focusSelector: '.onboarding-overlay',
    });
  });
});
