import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (...segments) => readFileSync(join(import.meta.dirname, ...segments), 'utf8');

const journeyPath = join(import.meta.dirname, '..', 'journeys', 'bulkTranslationFileIO.journey.js');
const journey = readFileSync(journeyPath, 'utf8');
const translationActions = read('..', '..', 'src', 'components', 'translation', 'TranslationActions.js');
const bulkTranslationPool = read('..', '..', 'src', 'components', 'translation', 'BulkTranslationPool.js');
const translationIndex = read('..', '..', 'src', 'components', 'translation', 'index.js');
const useTranslationState = read('..', '..', 'src', 'hooks', 'useTranslationState.js');
const useTranslationBulk = read('..', '..', 'src', 'hooks', 'useTranslationBulk.js');
const translationJs = read('..', '..', 'src', 'services', 'gemini', 'translation.js');
const chainFormatter = read('..', '..', 'src', 'services', 'gemini', 'translationChainFormatter.js');
const nativeGeminiJobLifecycle = read('..', '..', 'src', 'platform', 'nativeGeminiJobLifecycle.js');
const downloadUtils = read('..', '..', 'src', 'components', 'translation', 'utils', 'downloadUtils.js');
const fileUtils = read('..', '..', 'src', 'utils', 'fileUtils.js');
const translationErrorComponent = read('..', '..', 'src', 'components', 'translation', 'TranslationError.js');
const translationPersistenceJourney = read('..', 'journeys', 'translationPersistence.journey.js');
const translatedDocumentExportsJourney = read('..', 'journeys', 'translatedDocumentExports.journey.js');
const subtitleDocumentOracle = read('..', 'support', 'subtitleDocumentOracle.js');

const assertJourneyContract = (source) => {
  // Import is real files onto the real (only) bulk drop zone -- never a fabricated pool entry.
  assert.match(source, /document\.querySelector\(selector\)/u);
  assert.match(source, /pool\.fileNames\.length === 2/u);

  // Malformed/mismatched drops are proven refused with NO partial durable state and the pool
  // provably unchanged -- and the journey does not fabricate a toast that does not ship.
  assert.match(source, /afterMalformed\.fileNames\.sort\(\), \[ALPHA_NAME, BETA_NAME\]\.sort\(\)/u);
  assert.match(source, /durableState\(root\), before/u);
  assert.match(source, /afterMalformed\.errorToasts, \[\]/u);

  // Provider-translation refusal: no native job, and the journey documents (does not assume) the
  // silent per-file failure shape rather than a global toast.
  assert.match(source, /refused\.downloadAllVisible, false/u);
  assert.match(source, /afterCredentialFree\.jobs\.filter/u);
  assert.match(source, /kind === 'translate'/u);

  // Export round trip reuses the independent Node parser for BOTH real formats, not one.
  assert.match(source, /waitForNewDocumentExports\(/u);
  assert.match(source, /verifySubtitleDocumentExport\(\{\s*\n\s*path: byExtension\.srt/u);
  assert.match(source, /verifySubtitleDocumentExport\(\{\s*\n\s*path: byExtension\.json/u);
  assert.match(source, /expectedPrefixed\(ALPHA_CUES\)/u);
  assert.match(source, /expectedPrefixed\(BETA_CUES\)/u);

  for (const [label, forbidden] of [
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand/u],
    ['native picker', /showOpen|showSave/u],
    ['raw SQL', /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|app_settings|projects|jobs)\b/iu],
    ['a real provider credential value', /AIza|ya29\.|client_secret['"]?\s*:\s*['"][^'"]{10,}/u],
  ]) {
    assert.doesNotMatch(source, forbidden, `journey contains forbidden ${label}`);
  }
};

test('the journey proves credential-free import/refusal/export and the provider-translation boundary', () => {
  assertJourneyContract(journey);
});

test('the contract fails when any one load-bearing assertion is removed', () => {
  for (const needle of [
    "afterMalformed.fileNames.sort(), [ALPHA_NAME, BETA_NAME].sort()",
    "durableState(root), before",
    "refused.downloadAllVisible, false",
    "expectedPrefixed(ALPHA_CUES)",
  ]) {
    const weakened = journey.replace(needle, '/* removed */');
    assert.notEqual(weakened, journey, `mutation needle is stale: ${needle}`);
    assert.throws(() => assertJourneyContract(weakened), undefined, needle);
  }
});

test('the real drop target is TranslationActions.js, not BulkTranslationPool\'s own (hidden) one', () => {
  assert.match(translationActions, /hideDropZone=\{true\}/u);
  assert.match(translationActions, /className=\{`bulk-drop-zone /u);
  assert.match(translationActions, /onDrop=\{handleDrop\}/u);
  assert.match(bulkTranslationPool, /\{!hideDropZone && \(/u);
});

test('a rejected bulk file really is only console.warn\'d -- no toast, no setError call', () => {
  assert.match(translationActions, /console\.warn\('Bulk file errors:', errors\)/u);
  assert.doesNotMatch(translationActions, /showErrorToast|window\.addToast|setError/u);
  assert.match(bulkTranslationPool, /console\.warn\('Bulk file errors:', errors\)/u);
});

test('bulk Format mode really is the provider-free branch, with the same chain formatter the main track uses', () => {
  assert.match(translationJs, /const isFormatMode = Array\.isArray\(targetLanguage\) && targetLanguage\.length === 0;/u);
  assert.match(translationJs, /if \(isFormatMode\) \{/u);
  assert.doesNotMatch(translationJs.slice(
    translationJs.indexOf('if (isFormatMode) {'),
    translationJs.indexOf('return completeTranslationResult(formatted, deliverySink);'),
  ), /runNativeGeminiText/u);
  assert.match(chainFormatter, /formattedText \+= originalText;/u); // original text carried unchanged
  assert.match(chainFormatter, /\} else if \(item\.type === 'delimiter'\) \{/u); // delimiter concatenated in chain order
});

test('bulk translations are React state, not a durable SQLite track like the main translation', () => {
  assert.match(useTranslationBulk, /React state is not a persistence receipt/u);
  assert.doesNotMatch(useTranslationBulk, /persistTranslationForIdentity/u);
});

test('a credential-missing bulk file really is swallowed per-file, never rethrown to the run', () => {
  assert.match(nativeGeminiJobLifecycle, /fixedError\('geminiCredentialUnavailable'\)/u);
  // With no ready credential, getCredentialId() resolves null and the loop breaks BEFORE
  // runAttempt (the only call site of `start`, i.e. startGeminiJob) is ever reached.
  assert.match(nativeGeminiJobLifecycle, /if \(credentialId === null \|\| attemptedCredentials\.has\(credentialId\)\) break;/u);
  const runnerSource = nativeGeminiJobLifecycle.slice(nativeGeminiJobLifecycle.indexOf('const run = async'));
  assert.doesNotMatch(runnerSource.split('throw lastError;')[0], /startGeminiJob|start\(/u);
  assert.match(useTranslationBulk, /catch \(fileError\) \{/u);
  assert.match(useTranslationBulk, /results\.push\(\{\s*\n\s*originalFile: bulkFile,\s*\n\s*error: fileError\.message/u);
  assert.doesNotMatch(useTranslationBulk, /throw fileError/u);
});

test('a failed bulk-only run never reaches setError, and TranslationError only ever shows a toast', () => {
  assert.match(useTranslationState, /if \(!hasMainSubtitles\) return \{ status: 'complete', scope: 'bulk' \};/u);
  assert.match(translationErrorComponent, /No longer render inline error/u);
  assert.match(translationErrorComponent, /showErrorToast\(error\.replace/u);
});

test('download buttons and the bulk preview are both gated on at least one success', () => {
  assert.match(translationIndex, /hasBulkTranslations=\{bulkTranslations\.length > 0 && bulkTranslations\.some\(bt => bt\.success\)\}/u);
});

test('bulk export writes each file through the same native save boundary the document journeys prove', () => {
  assert.match(downloadUtils, /await downloadJSON\(download\.subtitles, download\.filename\)/u);
  assert.match(downloadUtils, /await downloadSRT\(download\.subtitles, download\.filename\)/u);
  assert.match(fileUtils, /return exportSubtitleDocument\(\{ suggestedName: filename, format, content \}\);/u);
  assert.match(subtitleDocumentOracle, /export const waitForNewDocumentExports/u);
});

test('this journey targets its own ground: it does not duplicate translationPersistence or translatedDocumentExports', () => {
  assert.doesNotMatch(journey, /importSubtitles\(\)/u);
  assert.match(translationPersistenceJourney, /importSubtitles\(\)/u);
  assert.match(translatedDocumentExportsJourney, /importSubtitles\(\)/u);
  assert.doesNotMatch(journey, /download-btn-primary|download-options-modal/u);
});
