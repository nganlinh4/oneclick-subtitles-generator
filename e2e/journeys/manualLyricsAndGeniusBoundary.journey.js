// AUTHORED, NOT EXECUTED in this pass -- see e2e/inventory.json's "manualLyricsAndGeniusBoundary"
// note. Never launches the desktop binary or wdio from this lane; the next lane to run it owns
// turning this into a passing (or honestly failing) real-binary attempt.
//
// GROUND TRUTH READ FROM SOURCE BEFORE WRITING ANY STEP.
//
// "ADD SUBTITLES" IS REFERENCE TEXT, NOT A SECOND CUE-CREATION PATH. src/components/
// AddSubtitlesButton.js opens SubtitlesInputModal.js -- one plain textarea, one line per intended
// subtitle, explicitly untimed ("Paste your subtitles here without timings..."). Saving calls
// handleUserSubtitlesAdd (src/components/app/ModalHandlers.js:103-132), which persists the exact
// string through setUserProvidedSubtitlesForCache (src/utils/userSubtitlesStore.js) into the
// SAME project-auxiliary SQLite row translations use (projectAuxiliaryStore.js's
// `project.legacyAux.v1.<projectId>` app_settings key, field `userSubtitles`) -- durable, but NOT a
// subtitles/cues row. Nothing in this save path ever writes to the `cues` table.
//
// TURNING THAT TEXT INTO TIMED CUES REQUIRES GEMINI, NOT THIS JOURNEY.
// src/components/app/handlers/processingHandlers.js:124-132 only forwards
// `subtitleOptions.userProvidedSubtitles` when `options.promptPreset === 'timing-generation'` --
// a Gemini prompt preset (src/components/VideoProcessingModalGeminiPanel.js), never wired to any
// local ASR engine. So the honest, credential-free, product-accurate scope for the MANUAL half is:
// entry survives as durable per-project reference text, is editable/clearable afterward, and
// deliberately produces ZERO cues by itself -- converting it into timed cues is Gemini-gated and is
// the separate, still-unauthored geminiTranscriptionSuccessAndWindowing tracker's job.
//
// GENIUS LOOKUP HAS NO CREDENTIAL-FREE PATH EITHER, AND NEVER REACHES NATIVE IPC.
// src/platform/providerService.js:253-266's fetchGeniusLyrics calls requireReadyCredential(current,
// 'geniusAccessToken') BEFORE invoke('genius_lyrics', ...) -- with no ready credential it throws
// NativeProviderServiceError('credentialNotFound', 'Genius API key not set. Please provide it
// through the settings.') synchronously; the native genius_lyrics Tauri command
// (apps/desktop/src-tauri/src/providers.rs:135-159, which requires an already-resolved
// CredentialId argument) is never invoked, so there is no network call, no job, and nothing for the
// native log to record. src/hooks/useGeniusLyrics.js:134-141 recognises that exact message text and
// re-maps it through t('lyrics.genius.apiKeyNotSet') (identical English copy), sets its `error`
// state, and src/components/LyricsInputSection.js:38-42 turns that into a TOAST
// (showErrorToast) -- never inline copy. This matches the watched inline-error-over-video defect
// class this lane checks against: the refusal must stay a toast, never paint over the editor or the
// video surface. Lane F (settingsCredentialsAndYoutubeOAuth) owns storing/clearing a Genius key in
// Settings; this journey never touches Settings and never supplies one.

/* global $, browser, describe, document, getComputedStyle, it */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { durableState, durableUserSubtitles } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'manual-lyrics-and-genius-boundary';
const MODAL = '.subtitles-input-modal';
const TEXTAREA = `${MODAL} textarea.custom-scrollbar-textarea`;
const ADD_BUTTON = '.add-subtitles-button';
const CLEAR_BUTTON = '.clear-subtitles-button';
const SAVE_BUTTON = `${MODAL} .save-button`;
const CANCEL_BUTTON = `${MODAL} .cancel-button`;
const GENIUS_TOGGLE = '.lyrics-toggle-button';
const GENIUS_MESSAGE = 'Genius API key not set. Please provide it through the settings.';

const MANUAL_TYPED = 'Manual cue one\n\nManual cue two\nManual cue three';
const MANUAL_SAVED = 'Manual cue one\nManual cue two\nManual cue three';
const MANUAL_APPENDED = `${MANUAL_SAVED}\nManual cue four`;

const surfaceState = () => browser.execute(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const text = (node) => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
  return {
    errorToasts: [...document.querySelectorAll('.toast-item.live .toast.toast-error')]
      .filter(visible).map(text).filter(Boolean),
    inlineErrors: [...document.querySelectorAll('.error, .error-message, [role="alert"]')]
      .filter((node) => node.closest('.toast-item') === null && visible(node)).map(text).filter(Boolean),
    hasSubtitlesButton: document.querySelector('.add-subtitles-button.has-subtitles') !== null,
    modalOpen: document.querySelector('.subtitles-input-modal') !== null,
    lyricsSectionOpen: document.querySelector('.lyrics-input-section') !== null,
  };
});

const waitUntilWithFreshDiagnostic = async (predicate, { diagnostic, ...options }) => {
  try {
    return await browser.waitUntil(predicate, { ...options, timeoutMsg: 'condition did not settle before its timeout' });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
};

const openManualModal = async () => {
  await clickControl(ADD_BUTTON);
  const modal = await $(MODAL);
  await modal.waitForDisplayed({ timeout: 30_000, timeoutMsg: 'the manual subtitles modal never opened' });
};

const closeManualModal = async () => {
  await clickControl(CANCEL_BUTTON);
  await $(MODAL).waitForExist({ reverse: true, timeout: 15_000, timeoutMsg: 'the manual subtitles modal never closed' });
};

const readTextareaValue = () => browser.execute(
  (selector) => document.querySelector(selector)?.value ?? null, TEXTAREA,
);

describe('a customer enters manual subtitles and finds the Genius lookup credential boundary', () => {
  it('persists editable reference text durably and refuses Genius lookup without a credential', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the harness must have an isolated data root');

    await openProjectWithMedia();
    const before = durableState(root);
    assert.deepEqual(
      durableUserSubtitles(root).map((row) => row.userSubtitles).filter((value) => value !== null),
      [],
      'a clean profile must start with no durable manual-subtitle reference text',
    );

    // --- Part A: manual entry survives as durable reference text, and produces zero cues. ---
    await openManualModal();
    const textarea = await $(TEXTAREA);
    await textarea.waitForDisplayed({ timeout: 15_000 });
    await textarea.setValue(MANUAL_TYPED);
    await clickControl(SAVE_BUTTON);
    await $(MODAL).waitForExist({ reverse: true, timeout: 15_000, timeoutMsg: 'saving manual subtitles never closed the modal' });
    let surface = await surfaceState();
    await waitUntilWithFreshDiagnostic(async () => {
      surface = await surfaceState();
      return surface.hasSubtitlesButton;
    }, {
      timeout: 15_000,
      interval: 200,
      diagnostic: () => `the Add Subtitles control never reported a saved state: ${JSON.stringify(surface)}`,
    });
    assert.deepEqual(surface.errorToasts, [], 'saving manual subtitles produced an unexpected error toast');

    const savedRows = durableUserSubtitles(root);
    assert.equal(savedRows.length, 1, 'manual subtitles were not persisted under exactly one project row');
    assert.equal(
      savedRows[0].userSubtitles, MANUAL_SAVED,
      'the durable reference text does not match the auto-erased-blank-lines save the customer saw',
    );
    const afterSave = durableState(root);
    assert.equal(
      afterSave.counts.cues, before.counts.cues,
      'manual reference text was converted into subtitle cues -- it must remain reference-only until a Gemini timing-generation run',
    );
    assert.deepEqual(
      afterSave.jobs.filter(({ kind }) => kind === 'transcribe' || kind === 'translate'),
      before.jobs.filter(({ kind }) => kind === 'transcribe' || kind === 'translate'),
      'saving manual reference text started a provider job',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-manual-text-durable',
      description: 'Manual subtitle text is durable per-project reference text with zero cues created.',
      details: { savedText: MANUAL_SAVED },
    });

    // --- Part B: reopening shows the exact saved text, and an edit is durably re-saved. ---
    await openManualModal();
    const prefilled = await readTextareaValue();
    assert.equal(prefilled, MANUAL_SAVED, 'reopening the modal did not prefill the exact durable text');
    await (await $(TEXTAREA)).setValue(MANUAL_APPENDED);
    await clickControl(SAVE_BUTTON);
    await $(MODAL).waitForExist({ reverse: true, timeout: 15_000 });
    assert.equal(
      durableUserSubtitles(root)[0]?.userSubtitles, MANUAL_APPENDED,
      'the edited manual subtitles were not durably re-saved',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-manual-text-edited',
      description: 'Reopening the modal round-trips the exact durable text, and an edit is durably re-saved.',
      details: { editedText: MANUAL_APPENDED },
    });

    // --- Part C: the Genius lookup refuses before any native call, as a toast, with no state
    // corruption -- exactly the boundary geminiCredentialBoundary proves for Gemini generation. ---
    await openManualModal();
    await clickControl(GENIUS_TOGGLE);
    const lyricsSection = await $('.lyrics-input-section');
    await lyricsSection.waitForDisplayed({ timeout: 15_000, timeoutMsg: 'the Genius lookup fields never appeared' });
    await (await $('#artist-input')).setValue('A Test Artist');
    await (await $('#song-input')).setValue('A Test Song');
    await clickControl('.fetch-lyrics-button');

    let refusal = null;
    await waitUntilWithFreshDiagnostic(async () => {
      refusal = await surfaceState();
      return refusal.errorToasts.length > 0;
    }, {
      timeout: 15_000,
      interval: 200,
      diagnostic: () => `no credential-free Genius refusal toast appeared: ${JSON.stringify(refusal)}`,
    });
    // A rendered toast's innerText carries its own chrome - the close control and the severity
    // heading - around the message, so the exact copy is asserted as the toast's tail rather than
    // its whole text. Anchored at the end, an extra or altered sentence still fails.
    assert.ok(
      refusal.errorToasts[0].replace(/\s+/gu, ' ').trim().endsWith(GENIUS_MESSAGE),
      `the Genius refusal toast has unexpected copy: ${JSON.stringify(refusal.errorToasts[0])}`,
    );
    assert.deepEqual(refusal.inlineErrors, [], 'the Genius refusal painted an inline error instead of only a toast');
    assert.equal(refusal.modalOpen, true, 'the failed lookup unexpectedly closed the manual subtitles modal');
    assert.equal(refusal.lyricsSectionOpen, true, 'the failed lookup unexpectedly hid the lyrics section');

    const afterGenius = durableState(root);
    assert.equal(
      durableUserSubtitles(root)[0]?.userSubtitles, MANUAL_APPENDED,
      'the failed Genius lookup altered the durable manual reference text',
    );
    assert.equal(afterGenius.counts.cues, before.counts.cues, 'the failed Genius lookup created cues');
    assert.deepEqual(afterGenius.jobs, afterSave.jobs, 'the failed Genius lookup registered a native job');

    const logPath = join(root, 'logs', 'osg.log');
    if (existsSync(logPath)) {
      const log = readFileSync(logPath, 'utf8');
      assert.doesNotMatch(log, /genius/iu, 'the native log recorded a Genius request lifecycle event');
    }
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-genius-refused-credential-free',
      description: 'A credential-free Genius lookup refuses as a toast before any native call, with the modal and its state untouched.',
      details: { toast: refusal.errorToasts[0] },
      allowVisibleProblems: {
        // The screenshot guard reads toast text single-spaced (trim + collapse); refusal.errorToasts
        // was normalized the same way by surfaceState(). The visible missing-credential refusal is
        // the customer state this journey is proving (idiom: geminiCredentialBoundary.journey.js).
        errorToasts: refusal.errorToasts.map((toast) => ({
          text: toast.replace(/\s+/g, ' ').trim(),
          reason: 'The visible missing-credential Genius refusal is the customer state under test.',
        })),
      },
    });

    // Close without saving; the refusal must not have staged an uncommitted change either.
    await closeManualModal();
    assert.equal(
      durableUserSubtitles(root)[0]?.userSubtitles, MANUAL_APPENDED,
      'closing the modal after a failed lookup changed the durable reference text',
    );

    // The Genius refusal toast auto-dismisses on its own timer (showErrorToast's default 8000ms,
    // plus ToastPanel's 500ms dismiss animation before the node leaves `.toast-item.live` -- see
    // src/utils/toastUtils.js and src/components/common/ToastPanel.js's removeToast); wait it out
    // so Part D's own workflow-evidence screenshot is not a race against this toast still being on
    // screen (idiom: bulkTranslationFileIO.journey.js's identical wait after its own refusal toast).
    await waitUntilWithFreshDiagnostic(async () => (await surfaceState()).errorToasts.length === 0, {
      timeout: 15_000,
      interval: 250,
      diagnostic: () => 'the Genius refusal toast from Part C never auto-dismissed before Part D',
    });

    // --- Part D: clearing is durable too. ---
    await clickControl(CLEAR_BUTTON);
    let cleared = null;
    await waitUntilWithFreshDiagnostic(async () => {
      cleared = await surfaceState();
      return cleared.hasSubtitlesButton === false;
    }, {
      timeout: 15_000,
      interval: 200,
      diagnostic: () => `the Add Subtitles control never returned to its empty state: ${JSON.stringify(cleared)}`,
    });
    assert.equal(
      durableUserSubtitles(root)[0]?.userSubtitles ?? null, null,
      'clearing manual subtitles did not clear the durable reference text',
    );
    // The Genius refusal from the previous step is a real toast with a real lifetime, and this
    // step is about cleared text, not about that refusal. Let it retire on its own rather than
    // declaring an allowance for a toast this step does not document.
    await waitUntilWithFreshDiagnostic(async () => {
      cleared = await surfaceState();
      return cleared.errorToasts.length === 0;
    }, {
      timeout: 20_000,
      interval: 250,
      diagnostic: () => `the Genius refusal toast never retired before the cleared-text capture: ${JSON.stringify(cleared.errorToasts)}`,
    });
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-manual-text-cleared',
      description: 'Clearing manual subtitles durably clears the project-owned reference text.',
    });
  });
});
