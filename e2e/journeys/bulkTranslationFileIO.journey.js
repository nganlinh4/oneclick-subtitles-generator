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
// itself is mounted with hideDropZone -- its drop zone never renders; TranslationActions.js:100-174
// duplicates BulkTranslationPool's parse/validate logic for the one drop target that actually
// ships) and the bulk-only "Download All" export in src/components/translation/utils/
// downloadUtils.js. It runs bulk-only (no main subtitles imported) so the bulk-only branch of
// useTranslationState.js:589-679 (`if (!hasMainSubtitles) return { status: 'complete', scope:
// 'bulk' }`) is exercised directly, without re-proving the main-track path those two journeys
// already cover.
//
// BULK FILE IMPORT IS PURE BROWSER FileReader, CREDENTIAL-FREE AND NATIVE-IPC-FREE.
// TranslationActions.js's addFiles/parseFile (and BulkTranslationPool.js's own copy) read dropped
// files with FileReader/File#text() entirely in the WebView; nothing crosses into Rust. SRT files go
// through src/utils/srtParser.js's parseSrtContent; JSON files are parsed as either a bare array or
// `{ subtitles: [...] }`. Wrong extensions, duplicate names and unparsable content are all rejected
// -- but only into a local `errors` array that is `console.warn`'d
// (TranslationActions.js:167-169 and BulkTranslationPool.js:143-146) with the comment "You might
// want to show these errors to the user" LEFT UNACTED ON. THIS IS A REAL, SOURCE-CONFIRMED GAP: a
// rejected bulk file produces NO toast and NO inline error anywhere -- refusal is silent-but-safe
// (the pool is provably unchanged), not the actionable "bounded error" a credential boundary shows.
// This journey proves the real (silent) refusal honestly instead of fabricating a toast that does
// not ship.
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
// A CREDENTIAL-MISSING BULK TRANSLATION FAILS SILENTLY PER FILE, UNLIKE THE MAIN TRACK.
// For a REAL (non-format) target language, translateSubtitles calls runNativeGeminiText ->
// nativeGeminiJobLifecycle.js's createNativeGeminiJobRunner: with no ready Gemini credential,
// `getCredentialId()` resolves null immediately and it throws `fixedError('geminiCredentialUnavailable')`
// before ANY native job is registered (lines 122-191) -- so no job ever appears in SQLite, matching
// geminiCredentialBoundary's proof for generation. But useTranslationBulk.js's handleBulkTranslate
// (lines 105-160) catches that per FILE inside its loop and pushes `{ success: false, error }`
// instead of rethrowing; the outer run therefore reports `status: 'complete'` (not 'failed') and
// useTranslationState.js:589-828 NEVER calls setError for a bulk-only run, so
// TranslationError.js (which only ever shows a toast, never inline -- "No longer render inline
// error") never fires either. With zero successes, `hasBulkTranslations` (index.js:484) stays false,
// so the download buttons and BulkTranslationPreview (both success-gated) never appear. The customer
// sees a transient "Bulk translation complete: 0/N files processed" status line that then
// disappears with NOTHING durable left to show it happened. This journey proves that silent
// per-file refusal precisely -- the "same refusal-boundary pattern as geminiCredentialBoundary" this
// journey was asked to prove turns out, on the bulk path specifically, not to be a toast at all;
// that is the honest finding, not an assumption.

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

    // --- Part B: wrong extension, duplicate name and malformed JSON are refused, silently but
    // safely -- the pool is provably unchanged and no toast/inline error ships for this real path. ---
    await dropBulkFiles([
      { name: 'bulk-pool-notes.txt', content: 'not a subtitle file', mimeType: 'text/plain' },
      { name: ALPHA_NAME, content: 'a different file with the same name', mimeType: 'application/x-subrip' },
      { name: 'bulk-pool-broken.json', content: '{not valid json', mimeType: 'application/json' },
    ]);
    // No product signal marks a refused drop as settled, so this waits out a bounded window and
    // then asserts the pool never grew -- exactly the "no partial state" claim this can honestly make.
    await browser.pause(2_000);
    const afterMalformed = await poolState();
    assert.deepEqual(afterMalformed.fileNames.sort(), [ALPHA_NAME, BETA_NAME].sort(), (
      'a malformed/mismatched drop changed the bulk pool'
    ));
    assert.deepEqual(afterMalformed.errorToasts, [], (
      'a visible error toast now exists for a malformed bulk drop -- update this journey to assert its exact copy'
    ));
    assert.deepEqual(afterMalformed.inlineErrors, []);
    assert.deepEqual(
      durableState(root), before,
      'a client-side-only malformed bulk drop left durable state changed',
    );
    await captureWorkflowStep({
      workflow: WORKFLOW,
      step: '02-malformed-refused-silently',
      description: 'Wrong-extension, duplicate-name and malformed-JSON drops are all refused: the pool stays exactly the two good files, with no toast, no inline error, and no durable state change.',
    });

    // --- Part C: provider translation without a credential refuses cleanly at the job boundary,
    // but -- unlike geminiCredentialBoundary's generation refusal -- fails PER FILE, silently, with
    // no toast and no download surface, because useTranslationBulk.js never rethrows a per-file
    // provider error to the run-level error state. ---
    await clickControl(ADD_LANGUAGE_BUTTON);
    const newLanguageInput = await $('.language-chain .chain-item:last-child input');
    await newLanguageInput.waitForDisplayed({ timeout: 15_000 });
    await newLanguageInput.setValue(TARGET_LANGUAGE);
    await clickControl(TRANSLATE_BUTTON);

    let refused = null;
    await waitUntilWithFreshDiagnostic(async () => !(await browser.execute(
      () => document.querySelector('.translate-button.processing') !== null,
    )), {
      timeout: 60_000,
      interval: 500,
      diagnostic: () => 'the credential-free bulk translation attempt never left its processing state',
    });
    refused = await poolState();
    assert.equal(refused.downloadAllVisible, false, (
      'a credential-free bulk translation reported a successful, downloadable result'
    ));
    assert.deepEqual(refused.errorToasts, [], (
      'a global refusal toast now appears for a credential-free bulk translation -- update this ' +
        'journey to assert its exact copy; today useTranslationBulk.js swallows the per-file error'
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
      description: 'A real target language with no Gemini credential fails every bulk file without registering a native job, though (unlike whole-run refusals) it does so silently rather than with a toast.',
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
