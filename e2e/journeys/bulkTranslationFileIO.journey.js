// AUTHORED, NOT EXECUTED in this pass -- see e2e/inventory.json's "bulkTranslationFileIO" note.
// Never launches the desktop binary or wdio from this lane; the next lane to run it owns turning
// this into a passing (or honestly failing) real-binary attempt.
//
// GROUND TRUTH READ FROM SOURCE BEFORE WRITING ANY STEP.
//
// SCOPE, AND WHAT THIS JOURNEY DOES NOT DUPLICATE. translationPersistence.journey.js and
// translatedDocumentExports.journey.js already own the MAIN (single-track) provider-free Format
// translation: its ownership/persistence/preview-selection/relaunch (translationPersistence) and its
// SRT/JSON/TXT export through the global Download Center (translatedDocumentExports). Neither ever
// adds a bulk file. This journey owns the entirely separate bulk-pool surface instead:
// src/components/translation/TranslationActions.js's OWN drop zone/file input (BulkTranslationPool
// itself is mounted with hideDropZone -- its drop zone never renders; TranslationActions.js:106-206
// duplicates BulkTranslationPool's parse/validate logic for the one drop target that actually
// ships) and the bulk-only "Download All" export in src/components/translation/utils/
// downloadUtils.js. It runs bulk-only (no main subtitles imported) so the bulk-only branch of
// useTranslationState.js:589-679 (`if (!hasMainSubtitles) return { status: 'complete', scope:
// 'bulk' }`) is exercised directly, without re-proving the main-track path those two journeys
// already cover.
//
// BULK FILE IMPORT IS PURE BROWSER FileReader, CREDENTIAL-FREE AND NATIVE-IPC-FREE.
// TranslationActions.js's addFiles/parseFile (and BulkTranslationPool.js's own, still-unreachable
// copy behind its `hideDropZone` guard) read dropped files with FileReader/File#text() entirely in
// the WebView; nothing crosses into Rust. SRT files go through src/utils/srtParser.js's
// parseSrtContent; JSON files are parsed as either a bare array or `{ subtitles: [...] }`. Wrong
// extensions, duplicate names and unparsable content are all rejected AND reported: addFiles
// (TranslationActions.js:176-206) collects each rejection's filename/reason into one bounded
// array, and reportRejectedFiles (TranslationActions.js:160-173) turns the whole drop into exactly
// ONE grouped warning toast -- "{{count}} file(s) skipped: name: reason; name: reason; ..." capped
// at MAX_REPORTED_REJECTIONS=3 entries with a "+N more" tail -- through the same showWarningToast
// channel src/utils/toastUtils.js's other customer-input-rejection callers use (for example
// CustomGeminiModelsCard.js's duplicate-model-ID refusal). THIS WAS PREVIOUSLY A REAL,
// SOURCE-CONFIRMED GAP (only `console.warn`'d, per the comment "You might want to show these
// errors to the user" left unacted on) that is now fixed at its root: a rejected bulk file is
// reported through the product's existing bounded toast channel, grouped into a single message
// per drop rather than a toast storm, and never rendered inline over the video (an explicitly
// watched defect class). The toast text carries only the customer's own filename (never a
// filesystem path -- browsers never expose one via File#name) and a parser's own error text
// (token/position info, never file content).
//
// BULK FORMAT-MODE TRANSLATION IS THE SAME PROVIDER-FREE PATH THE MAIN TRACK USES.
// src/services/gemini/translation.js:126-248's translateSubtitles takes the `isFormatMode` branch
// (targetLanguage === []) before ever calling runNativeGeminiText, using
// formatSubtitlesWithChain (src/services/gemini/translationChainFormatter.js:51-111): each chain
// item's value is concatenated in order, so a [delimiter("BULK: "), original] chain (built the same
// way translatedDocumentExports/translationPersistence build a PREFIX chain) produces
// "BULK: " + originalText for every cue, with start/end untouched. useTranslationBulk.js's
// handleBulkTranslate (src/hooks/useTranslationBulk.js) runs this per bulk file and keeps the
// SAME timings; export reuses src/components/translation/utils/downloadUtils.js's
// handleBulkDownloadAll, which (on desktop) writes each file through
// platform/subtitleDocumentExportService.js's exportSubtitleDocument -- THE SAME NATIVE SAVE
// BOUNDARY subtitleDocumentRoundTrip/translatedDocumentExports already prove, just called once per
// bulk file instead of once. This journey therefore reuses support/subtitleDocumentOracle.js's
// independent Node SRT/JSON parser rather than re-authoring one.
//
// BULK TRANSLATIONS ARE NOT A DURABLE SQLITE TRACK. Unlike the main translation
// (persistTranslationForIdentity -> the `project.legacyAux.v1.<projectId>` auxiliary row
// support/database.js's durableTranslations reads), `bulkTranslations` is plain React state
// (useTranslationBulk.js) with an explicit comment that "React state is not a persistence receipt"
// -- there is no SQLite row for a bulk result. The real durability boundary for bulk output is the
// EXPORTED FILE on disk, which is exactly what this journey verifies byte-for-byte; it does not
// claim (because the product does not offer) a SQLite-backed bulk track binding.
//
// A TOTAL CREDENTIAL-MISSING BULK TRANSLATION NOW FAILS HONESTLY, MATCHING THE MAIN TRACK.
// For a REAL (non-format) target language, translateSubtitles calls runNativeGeminiText ->
// nativeGeminiJobLifecycle.js's createNativeGeminiJobRunner: with no ready Gemini credential,
// `getCredentialId()` resolves null immediately and it throws `fixedError('geminiCredentialUnavailable')`
// before ANY native job is registered (lines 122-191) -- so no job ever appears in SQLite, matching
// geminiCredentialBoundary's proof for generation. useTranslationBulk.js's handleBulkTranslate still
// catches that per FILE inside its loop (it must, to keep the documented complete-with-warnings
// semantics for a PARTIAL failure -- see the chosen semantics below), but now records each
// failure's error `code` and, once every file in the run has finished, checks whether NOTHING
// succeeded and EVERY failure carries the exact `geminiCredentialUnavailable` signature
// (useTranslationBulk.js's `isCredentialMissing` check). When that total-refusal condition holds,
// it calls the SAME `setError` the single-track path's catch block calls with the SAME error
// object's `.message` -- so TranslationError.js's existing `showErrorToast(error.replace(...))`
// (it still never renders inline -- "No longer render inline error") fires exactly once, and the
// run returns `{ status: 'failed' }` instead of `{ status: 'complete' }`. useTranslationState.js's
// existing `if (bulkOutcome?.status === 'failed' && !hasMainSubtitles) return bulkOutcome;` (already
// present before this fix) then carries that 'failed' status out of handleTranslate unchanged, so
// the misleading "Bulk translation complete: 0/N files processed" status line never publishes for
// this case. CHOSEN SEMANTICS (see the commit message for the full reasoning): a run where at least
// one file succeeds keeps reporting 'complete' -- a partial failure is "complete with warnings",
// exactly the existing X/N status text -- and a run where every file fails for a REASON OTHER THAN
// (or a MIX including something other than) the missing-credential signature also keeps reporting
// 'complete', unchanged from before this fix; only a TOTAL, UNIFORM credential-missing failure is
// promoted to 'failed' with one refusal toast. This journey proves the total-failure case, which is
// the one this defect was filed against; the partial/mixed cases are covered by the colocated
// vitest regressions instead (src/hooks/useTranslationBulk.credentialFailure.test.js).

/* global $, browser, describe, document, getComputedStyle, it, DataTransfer, DragEvent, File */

import { strict as assert } from 'node:assert';
import { extname, join } from 'node:path';
import process from 'node:process';

import { durableState } from '../support/database.js';
import { clickControl } from '../support/editor.js';
import {
  snapshotOutputDirectory, verifySubtitleDocumentExport, waitForNewDocumentExports,
} from '../support/subtitleDocumentOracle.js';
import { openProjectWithMedia } from '../support/workflow.js';
import { captureWorkflowStep } from '../support/workflowEvidence.js';

const WORKFLOW = 'bulk-translation-file-io';
const DROP_ZONE = '.bulk-drop-zone';
const ADD_LANGUAGE_BUTTON = '.add-chain-item-btn:not(.delimiter):not(.original)'; // "Add Language"
const ADD_ORIGINAL_BUTTON = '.add-chain-item-btn.original';
const TRANSLATE_BUTTON = '.translate-button';
const PREFIX = 'BULK: ';
const TARGET_LANGUAGE = 'Spanish';

const ALPHA_NAME = 'bulk-pool-alpha.srt';
const ALPHA_CUES = Object.freeze([
  Object.freeze({ ordinal: 1, startMs: 500, endMs: 2_000, text: 'Alpha line one' }),
  Object.freeze({ ordinal: 2, startMs: 2_500, endMs: 4_000, text: 'Alpha line two' }),
]);
const ALPHA_SRT = ALPHA_CUES.map(({ ordinal, startMs, endMs, text }) => {
  const stamp = (ms) => {
    const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60_000) / 1_000)).padStart(2, '0');
    const msPart = String(ms % 1_000).padStart(3, '0');
    return `${h}:${m}:${s},${msPart}`;
  };
  return `${ordinal}\n${stamp(startMs)} --> ${stamp(endMs)}\n${text}`;
}).join('\n\n');

const BETA_NAME = 'bulk-pool-beta.json';
const BETA_CUES = Object.freeze([
  Object.freeze({ ordinal: 1, startMs: 1_000, endMs: 2_500, text: 'Beta line one' }),
  Object.freeze({ ordinal: 2, startMs: 3_000, endMs: 4_500, text: 'Beta line two' }),
]);
const BETA_JSON = JSON.stringify(BETA_CUES.map(({ startMs, endMs, text }) => ({
  start: startMs / 1_000, end: endMs / 1_000, text,
})));

const expectedPrefixed = (cues) => cues.map((cue) => Object.freeze({ ...cue, text: `${PREFIX}${cue.text}` }));

const poolState = () => browser.execute(() => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const text = (node) => (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
  return {
    fileNames: [...document.querySelectorAll('.bulk-file-card .file-name')].map(text),
    countLabel: document.querySelector('.bulk-files-count')?.textContent?.trim() ?? null,
    errorToasts: [...document.querySelectorAll('.toast-item.live .toast.toast-error')]
      .filter(visible).map(text).filter(Boolean),
    // Rejected-file drops surface a WARNING toast (reportRejectedFiles), not an error toast --
    // matching how other customer-input rejections report (for example
    // CustomGeminiModelsCard.js's duplicate-model-ID refusal). The workflow-evidence screenshot
    // guard only ever tracks `.toast-error`, so this journey reads warning toasts itself.
    warningToasts: [...document.querySelectorAll('.toast-item.live .toast.toast-warning')]
      .filter(visible).map(text).filter(Boolean),
    inlineErrors: [...document.querySelectorAll('.error, .error-message, [role="alert"]')]
      .filter((node) => node.closest('.toast-item') === null && visible(node)).map(text).filter(Boolean),
    downloadAllVisible: document.querySelector('.download-all-button') !== null,
  };
});

const waitUntilWithFreshDiagnostic = async (predicate, { diagnostic, ...options }) => {
  try {
    return await browser.waitUntil(predicate, { ...options, timeoutMsg: 'condition did not settle before its timeout' });
  } catch (error) {
    throw new Error(diagnostic(), { cause: error });
  }
};

/** Drop real File objects on the real bulk drop zone -- the same DataTransfer technique every
 * other document-import journey here uses (subtitleDocumentRoundTrip.journey.js). */
const dropBulkFiles = async (files) => {
  const result = await browser.execute((selector, entries) => {
    const target = document.querySelector(selector);
    if (target === null) return 'missing-drop-target';
    const transfer = new DataTransfer();
    for (const { name, content, mimeType } of entries) {
      transfer.items.add(new File([content], name, { type: mimeType }));
    }
    for (const type of ['dragover', 'drop']) {
      target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
    return 'dropped';
  }, DROP_ZONE, files);
  assert.equal(result, 'dropped', 'the real bulk translation drop zone is absent');
};

describe('a customer imports, refuses malformed, and exports a bulk translation pool', () => {
  it('proves credential-free import/refusal/export and the provider-translation refusal boundary', async () => {
    const root = process.env.OSG_E2E_DATA_ROOT;
    assert.ok(root, 'the harness must have an isolated data root');
    const output = join(root, 'output');

    await openProjectWithMedia();
    const before = durableState(root);

    // --- Part A: real SRT + JSON files import into the pool, credential-free. ---
    await dropBulkFiles([
      { name: ALPHA_NAME, content: ALPHA_SRT, mimeType: 'application/x-subrip' },
      { name: BETA_NAME, content: BETA_JSON, mimeType: 'application/json' },
    ]);
    let pool = null;
    await waitUntilWithFreshDiagnostic(async () => {
      pool = await poolState();
      return pool.fileNames.length === 2;
    }, {
      timeout: 30_000,
      interval: 200,
      diagnostic: () => `both real bulk files never reached the pool: ${JSON.stringify(pool)}`,
    });
    assert.deepEqual(pool.fileNames.sort(), [ALPHA_NAME, BETA_NAME].sort());
    assert.match(pool.countLabel ?? '', /2/);
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '01-pool-imported',
      description: 'A real SRT and a real JSON file both entered the bulk pool through the actual drop zone.',
      details: { fileNames: pool.fileNames },
    });

    // --- Part B: wrong extension, duplicate name and malformed JSON are refused as ONE grouped,
    // bounded WARNING toast (reportRejectedFiles) naming each rejected file and its reason -- the
    // pool itself is provably unchanged and nothing ever renders inline over the video (an
    // explicitly watched defect class). This is the toast IS the subject under test: the exact
    // grouped copy is asserted below rather than merely its absence. ---
    await dropBulkFiles([
      { name: 'bulk-pool-notes.txt', content: 'not a subtitle file', mimeType: 'text/plain' },
      { name: ALPHA_NAME, content: 'a different file with the same name', mimeType: 'application/x-subrip' },
      { name: 'bulk-pool-broken.json', content: '{not valid json', mimeType: 'application/json' },
    ]);
    let afterMalformed = null;
    await waitUntilWithFreshDiagnostic(async () => {
      afterMalformed = await poolState();
      return afterMalformed.warningToasts.length > 0;
    }, {
      timeout: 15_000,
      interval: 200,
      diagnostic: () => `the malformed bulk drop never produced its grouped refusal toast: ${JSON.stringify(afterMalformed)}`,
    });
    assert.deepEqual(afterMalformed.fileNames.sort(), [ALPHA_NAME, BETA_NAME].sort(), (
      'a malformed/mismatched drop changed the bulk pool'
    ));
    assert.equal(afterMalformed.warningToasts.length, 1, (
      `a rejected drop produced more than one toast -- update this journey if a toast storm is now intentional: ${JSON.stringify(afterMalformed.warningToasts)}`
    ));
    // The rendered toast's innerText carries its close control and severity heading around the
    // message, so the summary is matched where it actually begins rather than at character zero.
    const rejectionToast = afterMalformed.warningToasts[0].replace(/\s+/gu, ' ').trim();
    assert.match(rejectionToast, /(^|\s)3 file\(s\) skipped:/, rejectionToast);
    assert.match(rejectionToast, /bulk-pool-notes\.txt: unsupported file type \(only \.srt and \.json are supported\)/, rejectionToast);
    assert.match(
      rejectionToast,
      new RegExp(`${ALPHA_NAME.replace('.', '\\.')}: a file with this name was already added`),
      rejectionToast,
    );
    assert.match(rejectionToast, /bulk-pool-broken\.json: could not be read \(/, rejectionToast);
    assert.deepEqual(afterMalformed.errorToasts, [], (
      'a rejected bulk drop produced an ERROR-classed toast -- reportRejectedFiles uses showWarningToast, not showErrorToast'
    ));
    assert.deepEqual(afterMalformed.inlineErrors, [], (
      'a rejected bulk drop rendered inline over the video -- an explicitly watched defect class'
    ));
    assert.deepEqual(
      durableState(root), before,
      'a client-side-only malformed bulk drop left durable state changed',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-malformed-refused-with-toast',
      description: 'Wrong-extension, duplicate-name and malformed-JSON drops are refused as one grouped, actionable warning toast naming each rejected file; the pool stays exactly the two good files and nothing renders inline.',
      details: { rejectionToast },
      // The workflow-evidence screenshot guard only ever tracks `.toast-error`, so a warning toast
      // needs no allowance here -- it is not flagged as a visible problem by that independent guard.
    });

    // --- Part C: provider translation without a ready credential now refuses the WHOLE bulk-only
    // run, matching (not merely echoing) geminiCredentialBoundary's single-track proof: every bulk
    // file fails with the exact same missing-credential signature, useTranslationBulk.js detects
    // that total-refusal shape and reuses the single-track's own setError -> TranslationError ->
    // showErrorToast path instead of reporting a misleading 'complete'. The toast IS the subject
    // under test here too, so its exact text is named through allowVisibleProblems -- the same
    // pattern geminiCredentialBoundary.journey.js uses for its own refusal toast. ---
    await clickControl(ADD_LANGUAGE_BUTTON);
    const newLanguageInput = await $('.language-chain .chain-item:last-child input');
    await newLanguageInput.waitForDisplayed({ timeout: 15_000 });
    await newLanguageInput.setValue(TARGET_LANGUAGE);
    await clickControl(TRANSLATE_BUTTON);

    let refused = null;
    await waitUntilWithFreshDiagnostic(async () => {
      refused = await poolState();
      const stillProcessing = await browser.execute(
        () => document.querySelector('.translate-button.processing') !== null,
      );
      return !stillProcessing && refused.errorToasts.length > 0;
    }, {
      timeout: 60_000,
      interval: 500,
      diagnostic: () => `the credential-free bulk translation refusal never settled: ${JSON.stringify(refused)}`,
    });
    assert.equal(refused.downloadAllVisible, false, (
      'a credential-free bulk translation reported a successful, downloadable result'
    ));
    assert.equal(refused.errorToasts.length, 1, (
      `a credential-missing bulk run did not surface exactly one refusal toast: ${JSON.stringify(refused.errorToasts)}`
    ));
    const refusalToast = refused.errorToasts[0];
    assert.match(refusalToast, /native gemini operation could not be completed/i, refusalToast);
    assert.deepEqual(refused.inlineErrors, [], (
      'the credential-missing bulk refusal rendered inline over the video -- an explicitly watched defect class'
    ));
    const afterCredentialFree = durableState(root);
    assert.deepEqual(
      afterCredentialFree.jobs.filter(({ kind }) => kind === 'translate'),
      before.jobs.filter(({ kind }) => kind === 'translate'),
      'a credential-free bulk translation registered a native translate job',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '03-provider-translation-refused',
      description: 'A real target language with no Gemini credential fails every bulk file identically; useTranslationBulk.js now reports the run FAILED (not complete) and shows exactly one bounded refusal toast, without registering a native job.',
      details: { refusalToast },
      allowVisibleProblems: {
        errorToasts: [{
          text: refusalToast,
          reason: 'The visible missing-credential refusal is the customer state under test, the same as geminiCredentialBoundary.',
        }],
      },
    });

    // The refusal toast auto-dismisses on its own timer; wait it out so Part D's "no error toast"
    // assertion below is not a race against this toast still being on screen.
    await waitUntilWithFreshDiagnostic(async () => (await poolState()).errorToasts.length === 0, {
      timeout: 15_000,
      interval: 250,
      diagnostic: () => 'the credential-missing refusal toast from Part C never auto-dismissed before Part D',
    });

    // Remove the real-language chain item so the next phase runs the provider-free Format path.
    await clickControl('.language-chain .chain-item:last-child .remove-btn');
    await browser.waitUntil(async () => (await browser.execute(
      () => document.querySelectorAll('.chain-item.language-item:not(.original)').length,
    )) === 1, { timeout: 10_000, interval: 100, timeoutMsg: 'the added target language was never removed' });

    // --- Part D: credential-free bulk Format-mode translation, then a byte-faithful export round
    // trip through the real native save boundary -- the SAME command the single-track document
    // journeys already prove, exercised here for two DIFFERENT formats in one customer click. ---
    await clickControl(ADD_ORIGINAL_BUTTON);
    await clickControl('.delimiter-display');
    const customDelimiter = await $('.delimiter-custom-input input');
    await customDelimiter.waitForDisplayed({ timeout: 15_000 });
    await customDelimiter.setValue(PREFIX);
    await browser.keys('Escape');
    await clickControl(`${TRANSLATE_BUTTON}.format-button`);

    let formatted = null;
    await waitUntilWithFreshDiagnostic(async () => {
      formatted = await poolState();
      return formatted.downloadAllVisible;
    }, {
      timeout: 60_000,
      interval: 500,
      diagnostic: () => `the credential-free bulk Format translation never completed: ${JSON.stringify(formatted)}`,
    });
    assert.deepEqual(formatted.errorToasts, [], 'the credential-free bulk Format translation produced an error toast');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '04-bulk-format-translated',
      description: 'Both bulk files were formatted (provider-free) with the customer-chosen prefix, and the bulk download controls appeared.',
    });

    const outputBefore = snapshotOutputDirectory(output);
    await clickControl('.download-all-button');
    const exportedPaths = await waitForNewDocumentExports({ directory: output, before: outputBefore, count: 2 });
    assert.equal(exportedPaths.length, 2, 'bulk Download All did not save exactly two files');

    const byExtension = Object.fromEntries(
      exportedPaths.map((path) => [extname(path).toLowerCase().slice(1), path]),
    );
    assert.deepEqual(Object.keys(byExtension).sort(), ['json', 'srt'], (
      'bulk export did not preserve each file\'s own original SRT/JSON format'
    ));
    const srtResult = verifySubtitleDocumentExport({
      path: byExtension.srt, format: 'srt', expected: expectedPrefixed(ALPHA_CUES),
    });
    const jsonResult = verifySubtitleDocumentExport({
      path: byExtension.json, format: 'json', expected: expectedPrefixed(BETA_CUES),
    });
    assert.notEqual(srtResult.sha256, jsonResult.sha256, 'the two bulk exports are byte-identical');
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '05-bulk-export-verified',
      description: 'Download All saved exactly the two expected files, independently parsed with the exact prefixed text and untouched timings.',
      details: {
        srt: { sha256: srtResult.sha256, sizeBytes: srtResult.sizeBytes },
        json: { sha256: jsonResult.sha256, sizeBytes: jsonResult.sizeBytes },
      },
    });
  });
});
