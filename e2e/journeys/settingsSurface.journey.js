// One real Settings journey covers mutually exclusive surfaces, then proves representative writes
// at the browser, SQLite, reload/reset, and filesystem boundaries. It never invokes a command
// directly: every mutation below begins with a public control a customer can click.
/* global $, browser, describe, document, it, process */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  basename, join, resolve,
} from 'node:path';

import { clickControl, openEditor, waitForEditorReady } from '../support/editor.js';
import {
  appearanceSnapshot,
  selectAlternateDropdownOption,
} from '../support/settingsAppearance.js';
import { withDatabase } from '../support/database.js';
import {
  ENGINE_PACKAGES_CACHE, NATIVE_TOOLS_CACHE, runRootAuthorization,
} from '../support/environment.js';
import { digestFrameRgbaRegion } from '../support/nativeMediaOracle.js';
import {
  directoryShapeDigest,
  durableCustomerIdentity,
  durableSettings,
  durableWorkspaceIdentity,
} from '../support/settingsSurfaceOracle.js';
import {
  importSubtitles,
  openProjectWithMedia,
  seekPreviewTo,
  waitForCanvasSubtitleFrame,
} from '../support/workflow.js';
import {
  captureWorkflowStep,
  workflowEvidenceDirectory,
} from '../support/workflowEvidence.js';
import {
  waitForLiveToastsToDismiss, waitForRestoredMedia, waitForSettingsPaintStable,
} from './steps/settingsSurface/waits.js';
import { assertSettingsChromeInViewport } from './steps/settingsSurface/chromeGeometry.js';
import {
  TAB_SURFACES, activateTab, activeControlMap, assertSettingsArrowIsolation,
  installBrowserDiagnostics, openSettings, settingsDiagnostic, switchSelected,
} from './steps/settingsSurface/navigation.js';

const WORKFLOW = 'settings-surface';
const PROMPT_MARKER = 'OSG real-binary settings persistence journey.';
const DISABLED_UPDATER_ALERTS = Object.freeze([
  'Unable to check for updates',
  'Không thể kiểm tra cập nhật',
  '업데이트를 확인할 수 없습니다',
].map((text) => ({
  text,
  reason: 'The e2e-automation binary compiles its updater channel off; the dedicated updater journey verifies the disabled native outcome and zero network access.',
})));
const SETTING_KEYS = Object.freeze([
  'theme',
  'app_font',
  'preferred_language',
  'time_format',
  'show_waveform_long_videos',
  'transcription_prompt',
]);
const SETTINGS_CHROME_REGIONS = Object.freeze({
  title: Object.freeze({ x: 40, y: 35, width: 140, height: 45 }),
  close: Object.freeze({ x: 1318, y: 34, width: 48, height: 48 }),
  footer: Object.freeze({ x: 40, y: 810, width: 540, height: 60 }),
});

const settingsScreenshotPath = (step) => {
  const attempt = process.env.OSG_E2E_EVIDENCE_ATTEMPT;
  assert.match(attempt ?? '', /^[a-z0-9-]+$/u, 'Settings screenshot has no bounded evidence attempt');
  return join(workflowEvidenceDirectory(WORKFLOW), 'attempts', attempt, `${step}.png`);
};

const settingsChromePixelDigest = (step) => Object.fromEntries(
  Object.entries(SETTINGS_CHROME_REGIONS).map(([name, region]) => [
    name,
    digestFrameRgbaRegion(settingsScreenshotPath(step), region).sha256,
  ]),
);

const assertSettingsChromePixels = (step, baseline) => {
  const digest = settingsChromePixelDigest(step);
  if (baseline !== null) {
    assert.deepEqual(
      digest,
      baseline,
      `${step} lost or moved title, close, or footer pixels in the saved PNG`,
    );
  }
  return digest;
};

const assertDisposableFactoryResetRoot = (root) => {
  const canonicalRoot = resolve(root);
  // Factory reset is destructive, so it may only ever run against a root this harness owns.
  // The ownership proof is the managed run-root contract itself -- authorized parent, the
  // managed staging lane, the exact private layout and a live authority token -- which
  // runRootAuthorization validates and refuses. An earlier version required the root to sit
  // under %TEMP%; run roots moved into the managed staging lane, so that test refused every
  // legitimate root while proving strictly less about ownership than the authority does.
  try {
    runRootAuthorization(canonicalRoot);
  } catch (error) {
    assert.fail(
      `factory reset refuses a run root this harness does not own: ${canonicalRoot} (${error.message})`,
    );
  }
  assert.ok(
    basename(canonicalRoot).startsWith('osg-e2e-run-'),
    `factory reset refuses a non-disposable run root: ${canonicalRoot}`,
  );
  const credentialReferences = withDatabase(root, database => Number(
    database.prepare('SELECT COUNT(*) AS count FROM credential_refs').get().count,
  ));
  assert.equal(
    credentialReferences,
    0,
    'factory reset refuses a profile whose credential references could reach the OS vault',
  );
};

const mediaPickerRequestCount = (root) => {
  const log = readFileSync(join(root, 'logs', 'osg.log'), 'utf8');
  return [...log.matchAll(/"event":"media-picker\.requested"/gu)].length;
};

const publicToolRemovalGuard = async () => {
  const target = await browser.execute(() => {
    const native = [...document.querySelectorAll('[data-native-tool-id]')]
      .find((row) => row.querySelector('[data-tool-action="remove-request"]') !== null);
    if (native !== undefined) {
      return {
        kind: 'native-tool',
        id: native.getAttribute('data-native-tool-id'),
        state: native.getAttribute('data-tool-state'),
      };
    }
    return document.querySelector('.engines-panel__uninstall-all') === null
      ? null
      : { kind: 'all-engines' };
  });
  if (target === null) {
    return { reachable: false, deletionProven: false, reason: 'no installed package exposed removal' };
  }

  if (target.kind === 'native-tool') {
    assert.match(target.id, /^[a-z0-9-]+$/u, 'native tool id is not safe for a public selector');
    const row = `[data-native-tool-id="${target.id}"]`;
    await clickControl(`${row} [data-tool-action="remove-request"]`);
    const confirm = await $(`${row} [data-tool-action="remove-confirm"]`);
    await confirm.waitForDisplayed({ timeout: 10_000 });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '13-tool-removal-confirmation',
      description: 'Removing an installed native tool requires an explicit second public action.',
      details: {
        target: target.id,
        stateBefore: target.state,
        confirmed: false,
        deletionProven: false,
        reason: 'shared tool packages intentionally survive isolated journeys',
      },
      focusSelector: row,
    });
    await clickControl(`${row} [data-tool-action="remove-cancel"]`);
    assert.equal(await $(`${row} [data-tool-action="remove-request"]`).isExisting(), true);
    return { reachable: true, deletionProven: false, target: target.id, cancelled: true };
  }

  await clickControl('.engines-panel__uninstall-all');
  const confirmation = await $('.engines-panel__confirm-all');
  await confirmation.waitForDisplayed({ timeout: 10_000 });
  await captureWorkflowStep({
    workflow: WORKFLOW,
    step: '13-tool-removal-confirmation',
    description: 'Removing installed engines requires a second public action.',
    details: {
      target: 'installed-engines',
      confirmed: false,
      deletionProven: false,
      reason: 'shared engine packages intentionally survive isolated journeys',
    },
    focusSelector: '.engines-panel__confirm-all',
  });
  await clickControl('.engines-panel__confirm-all .engine-card__btn--ghost');
  assert.equal(await $('.engines-panel__uninstall-all').isExisting(), true);
  return { reachable: true, deletionProven: false, target: 'installed-engines', cancelled: true };
};

describe('a customer changes and safely resets Settings', () => {
  it('covers every tab, persists representative choices, and preserves owned work', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the Settings journey requires an isolated application root');
    const cleanSettings = Object.fromEntries(SETTING_KEYS.map((key) => [key, null]));
    assert.deepEqual(
      durableSettings(root, SETTING_KEYS),
      cleanSettings,
      'clean-install display fallbacks were persisted without a user action',
    );

    await openProjectWithMedia();
    await importSubtitles();
    await seekPreviewTo(1);
    await waitForCanvasSubtitleFrame();
    const customerAtStart = durableCustomerIdentity(root);
    assert.equal(customerAtStart.projects.length, 1, 'the public import did not create a project');
    assert.equal(customerAtStart.media.length, 1, 'the public import did not retain its media');
    assert.ok(customerAtStart.cues.length > 0, 'the public subtitle import did not persist cues');
    assert.ok(customerAtStart.sourceFiles.every(({ available, sha256 }) => available && sha256));
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '00-owned-project',
      description: 'A real imported video and subtitle scene are playable before Settings changes.',
      details: {
        projects: customerAtStart.projects.length,
        media: customerAtStart.media.length,
        cues: customerAtStart.cues.length,
        sourceFiles: customerAtStart.sourceFiles.map(({ relativePath, size, sha256 }) => ({
          relativePath, size, sha256,
        })),
      },
      focusSelector: '.video-preview',
    });

    // The import success toast is useful evidence in step 00, but the Settings screenshots
    // describe steady surfaces. Prove that the real timer removes it before opening the modal.
    await waitForLiveToastsToDismiss();

    await installBrowserDiagnostics();
    await openSettings();
    let settingsChromeBaseline = null;
    let darkChromePixelBaseline = null;
    for (const surface of TAB_SURFACES) {
      await activateTab(surface.tab);
      const geometry = await assertSettingsChromeInViewport(
        surface.tab,
        settingsChromeBaseline,
      );
      settingsChromeBaseline ??= geometry;
      const controlMap = await activeControlMap(surface.root, surface.required);
      assert.equal(controlMap.activePanels, 1, `Settings rendered overlapping panels on ${surface.tab}`);
      assert.equal(controlMap.rootPresent, true, `Settings omitted the ${surface.tab} root`);
      assert.ok(
        controlMap.controls >= surface.minimumControls,
        `${surface.tab} rendered too few public controls: ${JSON.stringify(controlMap)}`,
      );
      assert.ok(
        Object.values(controlMap.required).every(Boolean),
        `${surface.tab} omitted a mapped public control: ${JSON.stringify(controlMap.required)}`,
      );
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: surface.step,
        description: surface.claim,
        details: { tab: surface.tab, controlMap, geometry },
        focusSelector: '.settings-modal',
        ...(surface.tab === 'about' ? {
          allowVisibleProblems: {
            errorAlerts: DISABLED_UPDATER_ALERTS,
          },
        } : {}),
      });
      darkChromePixelBaseline = assertSettingsChromePixels(
        surface.step,
        darkChromePixelBaseline,
      );
    }

    const initialAppearance = await appearanceSnapshot();
    await clickControl('.settings-footer-controls .theme-toggle');
    await selectAlternateDropdownOption(
      '.settings-footer-controls > .app-font-dropdown > .custom-dropdown-button',
    );
    await selectAlternateDropdownOption(
      '.settings-footer-controls > .custom-dropdown:not(.app-font-dropdown)'
        + ' > .custom-dropdown-button',
    );
    const changedAppearance = await appearanceSnapshot();
    assert.notEqual(changedAppearance.theme, initialAppearance.theme, 'theme did not change');
    assert.equal(changedAppearance.documentTheme, changedAppearance.theme, 'theme was not painted');
    assert.notEqual(changedAppearance.font, initialAppearance.font, 'application font did not change');
    assert.notEqual(changedAppearance.language, initialAppearance.language, 'language did not change');
    const changedPaint = await waitForSettingsPaintStable();
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '08-appearance-changed',
      description: 'Theme, application font, and language change through their real footer controls.',
      details: { before: initialAppearance, after: changedAppearance, paint: changedPaint },
      focusSelector: '.settings-modal',
      allowVisibleProblems: { errorAlerts: DISABLED_UPDATER_ALERTS },
    });
    const changedChromePixelBaseline = assertSettingsChromePixels(
      '08-appearance-changed',
      null,
    );

    await activateTab('video-processing');
    await assertSettingsArrowIsolation(
      '.video-processing-section .compact-setting:has(label[for="time-format"])'
        + ' .custom-dropdown-button',
    );
    const waveformBefore = await switchSelected('#show-waveform-long-videos');
    assert.equal(typeof waveformBefore, 'boolean', 'waveform preference switch is unavailable');
    await clickControl('#show-waveform-long-videos');
    const waveformAfter = await switchSelected('#show-waveform-long-videos');
    assert.equal(waveformAfter, !waveformBefore, 'waveform preference did not toggle');
    const timeFormatLabels = await selectAlternateDropdownOption(
      '.video-processing-section .compact-setting:has(label[for="time-format"])'
        + ' .custom-dropdown-button',
    );
    const timeFormatExpected = ['seconds', 'hms'][timeFormatLabels.optionIndex];
    assert.ok(timeFormatExpected, 'time format exposed an undocumented option');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '09-processing-edits',
      description: 'A display format and long-video processing preference change through public controls.',
      details: {
        waveform: { before: waveformBefore, after: waveformAfter },
        timeFormat: { expected: timeFormatExpected, labels: timeFormatLabels },
      },
      // The section is intentionally taller than the modal viewport. Bind the evidence to the
      // changed control that the public interaction just brought into view, not to an element that
      // can never be wholly visible.
      focusSelector: '.video-processing-section .compact-setting:has(label[for="time-format"])',
    });
    assertSettingsChromePixels('09-processing-edits', changedChromePixelBaseline);

    await activateTab('prompts');
    const prompt = await $('#transcription-prompt');
    const originalPrompt = await prompt.getValue();
    assert.match(originalPrompt, /\{contentType\}/u, 'the required prompt placeholder is absent');
    const changedPrompt = originalPrompt.includes(PROMPT_MARKER)
      ? originalPrompt
      : `${originalPrompt.trimEnd()}\n\n${PROMPT_MARKER}`;
    await prompt.setValue(changedPrompt);
    assert.equal(await prompt.getValue(), changedPrompt, 'the prompt field did not accept the edit');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '10-prompt-edited',
      description: 'The transcription prompt is edited while its required content placeholder remains intact.',
      details: {
        changedCharacters: changedPrompt.length - originalPrompt.length,
        requiredPlaceholderPresent: changedPrompt.includes('{contentType}'),
      },
      focusSelector: '.transcription-prompt-setting',
    });
    assertSettingsChromePixels('10-prompt-edited', changedChromePixelBaseline);

    const save = await $('.save-btn');
    await browser.waitUntil(async () => !(await save.getAttribute('disabled')), {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: 'Settings never marked the public edits as saveable',
    });
    await clickControl('.save-btn');
    await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });

    const expectedSettings = {
      theme: changedAppearance.theme,
      app_font: changedAppearance.font,
      preferred_language: changedAppearance.language,
      time_format: timeFormatExpected,
      show_waveform_long_videos: String(waveformAfter),
      transcription_prompt: changedPrompt,
    };
    assert.deepEqual(
      durableSettings(root, SETTING_KEYS),
      expectedSettings,
      'the public Save action did not commit the exact settings to SQLite',
    );

    await openSettings();
    const restoredAppearance = await appearanceSnapshot();
    assert.deepEqual(
      {
        theme: restoredAppearance.theme,
        documentTheme: restoredAppearance.documentTheme,
        font: restoredAppearance.font,
        language: restoredAppearance.language,
      },
      {
        theme: expectedSettings.theme,
        documentTheme: expectedSettings.theme,
        font: expectedSettings.app_font,
        language: expectedSettings.preferred_language,
      },
      'appearance choices did not survive closing and reopening Settings',
    );
    await activateTab('video-processing');
    assert.equal(await switchSelected('#show-waveform-long-videos'), waveformAfter);
    const restoredTimeLabel = await $(
      '.video-processing-section .compact-setting:has(label[for="time-format"])'
        + ' .custom-dropdown-button .dropdown-value',
    ).getText();
    assert.equal(restoredTimeLabel, timeFormatLabels.selected, 'time format did not restore in the UI');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '11-persisted-preferences',
      description: 'Appearance and processing choices restore from the durable preference snapshot.',
      details: { appearance: restoredAppearance, waveform: waveformAfter, timeFormat: timeFormatExpected },
      focusSelector: '.settings-modal',
    });
    assertSettingsChromePixels('11-persisted-preferences', changedChromePixelBaseline);

    await activateTab('prompts');
    assert.equal(await $('#transcription-prompt').getValue(), changedPrompt, 'prompt did not restore');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '12-persisted-prompt',
      description: 'The exact edited prompt restores after Settings remounts.',
      details: { characters: changedPrompt.length, requiredPlaceholderPresent: true },
      focusSelector: '.transcription-prompt-setting',
    });
    assertSettingsChromePixels('12-persisted-prompt', changedChromePixelBaseline);

    await activateTab('tools');
    const nativeToolsBefore = directoryShapeDigest(NATIVE_TOOLS_CACHE);
    const enginePackagesBefore = directoryShapeDigest(ENGINE_PACKAGES_CACHE);
    const removalGuard = await publicToolRemovalGuard();
    assert.deepEqual(
      directoryShapeDigest(NATIVE_TOOLS_CACHE),
      nativeToolsBefore,
      'cancelling removal changed native tools',
    );
    assert.deepEqual(
      directoryShapeDigest(ENGINE_PACKAGES_CACHE),
      enginePackagesBefore,
      'cancelling removal changed engines',
    );
    if (!removalGuard.reachable) {
      await captureWorkflowStep({
        workflow: WORKFLOW,
        step: '13-tool-removal-unavailable',
        description: 'No installed package exposes removal in this isolated run; deletion remains unproven.',
        details: removalGuard,
        focusSelector: '.engines-panel',
      });
    }
    assertSettingsChromePixels(
      removalGuard.reachable
        ? '13-tool-removal-confirmation'
        : '13-tool-removal-unavailable',
      changedChromePixelBaseline,
    );

    const customerBeforeReset = durableCustomerIdentity(root);
    const workspaceBeforeReset = durableWorkspaceIdentity(root);
    assert.equal(customerBeforeReset.projects.length, 1, 'reset fixture has more than one project');
    assert.equal(customerBeforeReset.media.length, 1, 'reset fixture has more than one media asset');
    assert.equal(workspaceBeforeReset.initialized, true, 'native workspace authority was not initialized');
    assert.equal(workspaceBeforeReset.current?.projectId, customerBeforeReset.projects[0].id);
    assert.equal(workspaceBeforeReset.current?.mediaId, customerBeforeReset.media[0].id);
    assert.equal(workspaceBeforeReset.projectState?.trackId, customerBeforeReset.tracks[0].id);
    assert.equal(mediaPickerRequestCount(root), 1, 'the setup selected media more than once');
    const diagnosticBeforeReset = await settingsDiagnostic();
    assert.deepEqual(diagnosticBeforeReset.errors, [], 'Settings emitted a browser error');
    assertDisposableFactoryResetRoot(root);
    await clickControl('.factory-reset-btn');
    const resetToast = await $('.toast.toast-warning');
    await resetToast.waitForDisplayed({ timeout: 10_000, timeoutMsg: 'factory reset skipped confirmation' });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '14-factory-reset-confirmation',
      description: 'Factory reset is blocked behind an explicit warning and confirmation action.',
      details: {
        settingsToClear: SETTING_KEYS,
        projectDeletionExpected: false,
        sharedPackageDeletionExpected: false,
      },
      focusSelector: '.toast.toast-warning',
    });
    assertSettingsChromePixels('14-factory-reset-confirmation', changedChromePixelBaseline);
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
    assert.equal(onboarding.dismissedControls, true, 'factory reset did not restore onboarding controls');
    // Preferences and the browser mirror were cleared, but the exact native workspace is product
    // state. It must hydrate without a second picker or content-hash recovery.
    await waitForRestoredMedia();
    await seekPreviewTo(1);
    await waitForCanvasSubtitleFrame();

    const customerAfterReset = durableCustomerIdentity(root);
    assert.deepEqual(
      customerAfterReset,
      customerBeforeReset,
      'factory reset changed customer-owned projects, subtitles, or source bytes',
    );
    assert.equal(customerAfterReset.projects.length, 1, 'reset duplicated the preserved project');
    assert.equal(customerAfterReset.media.length, 1, 'reset duplicated the preserved media asset');
    assert.deepEqual(
      customerAfterReset.cues.map(({ id, track_id: trackId, text_hash: textHash }) => ({
        id, trackId, textHash,
      })),
      customerBeforeReset.cues.map(({ id, track_id: trackId, text_hash: textHash }) => ({
        id, trackId, textHash,
      })),
      'reset restored different cue or track identities',
    );
    assert.deepEqual(
      durableWorkspaceIdentity(root),
      workspaceBeforeReset,
      'reset changed the exact native project, media, track, or alias identity',
    );
    assert.equal(
      mediaPickerRequestCount(root),
      1,
      'factory reset opened a second media picker instead of hydrating the native workspace',
    );
    assert.deepEqual(
      durableSettings(root, SETTING_KEYS),
      cleanSettings,
      'factory reset left one of the edited preferences durable',
    );
    await openSettings();
    await activateTab('prompts');
    const resetPrompt = await $('#transcription-prompt').getValue();
    assert.match(resetPrompt, /\{contentType\}/u, 'factory reset lost the prompt fallback');
    assert.equal(
      resetPrompt.includes(PROMPT_MARKER),
      false,
      'factory reset restored the edited prompt instead of the read-time default',
    );
    assert.deepEqual(
      durableSettings(root, SETTING_KEYS),
      cleanSettings,
      'opening Settings persisted display fallbacks without a user action',
    );
    await clickControl('[data-settings-action="close"]');
    await $('.settings-modal').waitForExist({ reverse: true, timeout: 30_000 });
    assert.deepEqual(
      directoryShapeDigest(NATIVE_TOOLS_CACHE),
      nativeToolsBefore,
      'factory reset changed the shared native-tool package store',
    );
    assert.deepEqual(
      directoryShapeDigest(ENGINE_PACKAGES_CACHE),
      enginePackagesBefore,
      'factory reset changed the shared engine-package store',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '15-factory-reset-safe',
      description: 'After onboarding, the preserved project plays and draws subtitles while shared package shape remains unchanged.',
      details: {
        customerStatePreserved: true,
        workspaceIdentityPreserved: true,
        mediaPickerRequests: 1,
        clearedSettings: SETTING_KEYS,
        nativeToolDirectoryShape: nativeToolsBefore,
        enginePackageDirectoryShape: enginePackagesBefore,
        toolDeletionProven: false,
      },
      focusSelector: '.video-preview',
    });

  });
});

