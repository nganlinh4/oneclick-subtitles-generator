import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (...segments) => readFileSync(join(import.meta.dirname, ...segments), 'utf8');

const journeyPath = join(import.meta.dirname, '..', 'journeys', 'manualLyricsAndGeniusBoundary.journey.js');
const journey = readFileSync(journeyPath, 'utf8');
const addSubtitlesButton = read('..', '..', 'src', 'components', 'AddSubtitlesButton.js');
const subtitlesInputModal = read('..', '..', 'src', 'components', 'SubtitlesInputModal.js');
const lyricsInputSection = read('..', '..', 'src', 'components', 'LyricsInputSection.js');
const useGeniusLyrics = read('..', '..', 'src', 'hooks', 'useGeniusLyrics.js');
const providerService = read('..', '..', 'src', 'platform', 'providerService.js');
const geniusLyricsLocale = read('..', '..', 'src', 'i18n', 'locales', 'en', 'lyrics.json');
const modalHandlers = read('..', '..', 'src', 'components', 'app', 'ModalHandlers.js');
const userSubtitlesStore = read('..', '..', 'src', 'utils', 'userSubtitlesStore.js');
const processingHandlers = read('..', '..', 'src', 'components', 'app', 'handlers', 'processingHandlers.js');
const geniusProviderCommand = read('..', '..', 'apps', 'desktop', 'src-tauri', 'src', 'providers.rs');
const geminiCredentialBoundaryJourney = read('..', 'journeys', 'geminiCredentialBoundary.journey.js');
const database = read('..', 'support', 'database.js');

const assertJourneyContract = (source) => {
  // Manual entry is proven durable in the SAME project-auxiliary row translations use, and reopening
  // the modal round-trips the exact saved text.
  assert.match(source, /durableUserSubtitles\(root\)/u);
  assert.match(source, /savedRows\[0\]\.userSubtitles, MANUAL_SAVED/u);
  assert.match(source, /prefilled, MANUAL_SAVED/u);
  assert.match(source, /durableUserSubtitles\(root\)\[0\]\?\.userSubtitles, MANUAL_APPENDED/u);

  // The honest semantics finding: manual text alone produces zero cues.
  assert.match(source, /afterSave\.counts\.cues, before\.counts\.cues/u);

  // Genius refuses before any native call, as a toast (never inline), leaving state untouched.
  assert.match(source, /refusal\.errorToasts\[0\][\s\S]{0,160}endsWith\(GENIUS_MESSAGE\)/u);
  assert.match(source, /refusal\.inlineErrors, \[\]/u);
  assert.match(source, /afterGenius\.counts\.cues, before\.counts\.cues/u);
  assert.match(source, /afterGenius\.jobs, afterSave\.jobs/u);
  assert.match(source, /doesNotMatch\(log, \/genius\/iu/u);

  // Clearing is durable too.
  assert.match(source, /durableUserSubtitles\(root\)\[0\]\?\.userSubtitles \?\? null, null/u);

  for (const [label, forbidden] of [
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand/u],
    ['native picker', /showOpen|showSave|input\s*\[\s*type\s*=\s*["']file/u],
    ['raw SQL', /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|app_settings|projects|jobs)\b/iu],
    ['a real provider credential value', /AIza|ya29\.|client_secret['"]?\s*:\s*['"][^'"]{10,}/u],
    ['a real Genius credential', /genius[_-]?token['"]?\s*:\s*['"][^'"]{6,}/iu],
  ]) {
    assert.doesNotMatch(source, forbidden, `journey contains forbidden ${label}`);
  }
};

test('the journey proves durable/editable manual entry and the credential-free Genius refusal', () => {
  assertJourneyContract(journey);
});

test('the contract fails when any one load-bearing assertion is removed', () => {
  for (const needle of [
    "savedRows[0].userSubtitles, MANUAL_SAVED",
    "afterSave.counts.cues, before.counts.cues",
    "endsWith(GENIUS_MESSAGE)",
    "afterGenius.jobs, afterSave.jobs",
  ]) {
    const weakened = journey.replace(needle, '/* removed */');
    assert.notEqual(weakened, journey, `mutation needle is stale: ${needle}`);
    assert.throws(() => assertJourneyContract(weakened), undefined, needle);
  }
});

test('manual entry really has no timing/cue path: it is reference text gated behind Gemini', () => {
  assert.match(addSubtitlesButton, /onSubtitlesAdd\(text\)/u);
  assert.match(modalHandlers, /setUserProvidedSubtitlesForCache\(cacheId, subtitlesText/u);
  assert.match(userSubtitlesStore, /patchProjectAuxiliary\(/u);
  assert.doesNotMatch(userSubtitlesStore, /INSERT INTO cues|cues_table|createCue/iu);
  // userProvidedSubtitles only reaches a generation request under the Gemini-only preset.
  assert.match(processingHandlers, /promptPreset === 'timing-generation'/u);
  assert.match(processingHandlers, /subtitleOptions\.userProvidedSubtitles = suppliedSubtitles/u);
});

test('save always strips blank lines regardless of how the text arrived', () => {
  assert.match(subtitlesInputModal, /const finalText = autoEraseBlankLines \? removeBlankLines\(text\) : text;/u);
  assert.match(subtitlesInputModal, /await onSave\(finalText\)/u);
  assert.match(subtitlesInputModal, /initialText = ''/u); // reopening prefills from the caller's saved text
});

test('Genius lookup really refuses before any native call, with the exact copy this journey asserts', () => {
  assert.match(providerService, /requireReadyCredential\(current, 'geniusAccessToken'\)/u);
  const guardIndex = providerService.indexOf("requireReadyCredential(current, 'geniusAccessToken')");
  const invokeIndex = providerService.indexOf("invoke('genius_lyrics'");
  assert.ok(guardIndex >= 0 && invokeIndex > guardIndex, 'the credential guard must precede the native invoke');
  assert.match(providerService, /'Genius API key not set\. Please provide it through the settings\.'/u);
  assert.match(geniusLyricsLocale, /"apiKeyNotSet": "Genius API key not set\. Please provide it through the settings\."/u);
  assert.match(useGeniusLyrics, /err\.message\.includes\('Genius API key not set'\)/u);
  assert.match(useGeniusLyrics, /t\('lyrics\.genius\.apiKeyNotSet'\)/u);
  // The native command itself requires an already-resolved credential id argument, so a
  // credential-free attempt cannot reach it even if the JS guard were bypassed.
  assert.match(geniusProviderCommand, /credential_id: CredentialId/u);
});

test('the Genius refusal surfaces only as a toast, matching the watched inline-error-over-video class', () => {
  assert.match(lyricsInputSection, /showErrorToast\(error\)/u);
  assert.doesNotMatch(lyricsInputSection, /className="error"|role="alert"/u);
});

test('this journey follows the same refusal-boundary shape geminiCredentialBoundary already proves', () => {
  assert.match(geminiCredentialBoundaryJourney, /errorToasts:/u);
  assert.match(geminiCredentialBoundaryJourney, /after\.jobs\.filter/u);
  assert.match(journey, /errorToasts:/u);
  assert.match(journey, /afterGenius\.jobs/u);
});

test('the database helper this journey depends on reads the real auxiliary row, not a fixture', () => {
  assert.match(database, /export const durableUserSubtitles/u);
  assert.match(database, /project\.legacyAux\.v1\.%/u);
});
