import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (...segments) => readFileSync(join(import.meta.dirname, ...segments), 'utf8');

const journeyPath = join(import.meta.dirname, '..', 'journeys', 'providerBoundaries.journey.js');
const journey = readFileSync(journeyPath, 'utf8');
const oracle = read('providerRefusalOracle.js');
const jobLifecycle = read('..', '..', 'src', 'platform', 'nativeGeminiJobLifecycle.js');
const nativeGeminiText = read('..', '..', 'src', 'platform', 'nativeGeminiText.js');
const documentRequest = read('..', '..', 'src', 'services', 'gemini', 'documentRequest.js');
const consolidationService = read('..', '..', 'src', 'services', 'gemini', 'consolidationService.js');
const translation = read('..', '..', 'src', 'services', 'gemini', 'translation.js');
const imageGenerationService = read('..', '..', 'src', 'services', 'gemini', 'imageGenerationService.js');
const errorMessages = read('..', '..', 'src', 'components', 'background', 'errorMessages.js');
const backgroundImageGenerator = read('..', '..', 'src', 'components', 'BackgroundImageGenerator.js');
const backgroundMusicSection = read('..', '..', 'src', 'components', 'BackgroundMusicSection.jsx');
const promptDjIndex = read('..', '..', 'promptdj-midi', 'index.tsx');
const promptDjMidi = read('..', '..', 'promptdj-midi', 'components', 'PromptDjMidi.ts');
const playPauseMorph = read('..', '..', 'promptdj-midi', 'components', 'PlayPauseMorphWrapper.tsx');
const methodOverlay = read('..', '..', 'src', 'components', 'TranscriptionMethodSelectionOverlay.js');
const geminiPanel = read('..', '..', 'src', 'components', 'VideoProcessingModalGeminiPanel.js');
const downloadOptionsModal = read('..', '..', 'src', 'components', 'DownloadOptionsModal.js');
const translationActions = read('..', '..', 'src', 'components', 'translation', 'TranslationActions.js');
const bulkTranslationJourney = read('..', 'journeys', 'bulkTranslationFileIO.journey.js');
const geminiCredentialBoundaryJourney = read('..', 'journeys', 'geminiCredentialBoundary.journey.js');
const database = read('..', 'support', 'database.js');

test('the fixed refusal message this journey shares comes from the real credential-resolution wall, not a guess', () => {
  assert.match(jobLifecycle, /const fixedError = \(code = 'nativeGeminiFailed'\) => \{/u);
  assert.match(jobLifecycle, /The native Gemini operation could not be completed/u);
  assert.match(jobLifecycle, /let lastError = fixedError\('geminiCredentialUnavailable'\)/u);
  // With no credential, getCredentialId() resolves null and the attempt loop breaks immediately --
  // no `start()` (and therefore no native command) is ever called before that fixed error throws.
  assert.match(jobLifecycle, /if \(credentialId === null \|\| attemptedCredentials\.has\(credentialId\)\) break;/u);
  assert.match(oracle, /NATIVE_GEMINI_REFUSAL_MESSAGE = 'The native Gemini operation could not be completed'/u);
  assert.match(journey, /NATIVE_GEMINI_REFUSAL_MESSAGE/u);
});

test('toast refusal text reads the customer message, not the close icon or localized heading', () => {
  assert.match(oracle, /toast\.querySelector\('p'\) \?\? toast/u);
  assert.match(oracle, /errorMessages: errorNodes\.map\(toastMessage\)/u);
  assert.match(journey, /toasts\.errorMessages, \[expectedMessage\]/u);
});

test('document consolidate/summarize and translation both route through the same unwrapped nativeGeminiText call', () => {
  assert.match(documentRequest, /runNativeGeminiText/u);
  assert.match(documentRequest, /task: 'analyzeSubtitles'/u);
  assert.match(translation, /runNativeGeminiText/u);
  assert.match(nativeGeminiText, /createNativeGeminiJobRunner/u);
  // The default (No Split) path throws directly rather than catching per-chunk, which is exactly
  // why this journey keeps Split Duration at 0 for its toast-based refusal assertion.
  assert.match(consolidationService, /if \(splitDuration > 0\) \{/u);
  assert.match(consolidationService, /return requestConsolidation\(subtitlesText, model, customPrompt\);/u);
  assert.match(journey, /04-document-consolidate-refused/u);
  assert.match(journey, /05-document-summarize-refused/u);
  assert.match(journey, /06-main-track-translation-refused/u);
});

test('background image generation really produces the generic "Generation failed" fallback for this raw message', () => {
  assert.match(imageGenerationService, /runNativeGeminiText\(\{\s*task: 'analyzeSubtitles'/u);
  assert.match(errorMessages, /return t\('backgroundGenerator\.error\.generic', 'Generation failed'\);/u);
  // None of the specific patterns (api key / quota / HTTP status / CORS / network) match the raw
  // NativeGeminiError text, so the fallback above is genuinely what fires -- confirmed by every
  // specific branch requiring a substring this text does not contain.
  for (const specific of [/api key not set/iu, /quota/iu, /HTTP\s+\d{3}/u, /cors/iu, /\bnetwork\b/iu]) {
    assert.doesNotMatch('The native Gemini operation could not be completed', specific);
  }
  assert.match(backgroundImageGenerator, /window\.addToast\(getFriendlyErrorMessage\(t, err(?:\?\.message \|\| String\(err\))?\), 'error', 5000\)/u);
  assert.match(journey, /expectedMessage: 'Generation failed'/u);
});

test("PromptDJ's refusal never reaches Rust: the embedded app itself gates play/pause on credentialAvailable", () => {
  assert.match(backgroundMusicSection, /getActiveGeminiCredentialId\(\) !== null/u);
  assert.match(backgroundMusicSection, /type: 'pm-dj-native-init', available/u);
  assert.match(promptDjIndex, /nativeAvailable = data\.available;/u);
  assert.match(promptDjIndex, /pdjMidi\.credentialAvailable = nativeAvailable;/u);
  assert.match(promptDjIndex, /Please set your Gemini API key in the main app first\./u);
  assert.match(promptDjMidi, /if \(!this\.credentialAvailable\) \{/u);
  assert.match(promptDjMidi, /this\.dispatchEvent\(new CustomEvent\('error', \{ detail: 'Please set your Gemini API key in the main app first\.' \}\)\);/u);
  // The play dispatch that WOULD reach BackgroundMusicSection.jsx's native bridge is guarded behind
  // the SAME credentialAvailable check, on the line immediately after the refusal branch returns.
  const guardIndex = promptDjMidi.indexOf('if (!this.credentialAvailable)');
  const playDispatchIndex = promptDjMidi.indexOf("this.dispatchEvent(new CustomEvent('play'");
  assert.ok(guardIndex >= 0 && playDispatchIndex > guardIndex, 'the credential guard must precede the play dispatch');
  assert.match(playPauseMorph, /customElements\.define\('play-pause-morph', PlayPauseMorphElement\)/u);
  assert.match(journey, /credentialAvailable === false/u);
  assert.match(journey, /PROMPTDJ_MESSAGE = 'Please set your Gemini API key in the main app first\.'/u);
});

test('both Gemini transcription methods are really offered on a non-Vercel desktop build', () => {
  assert.match(methodOverlay, /const isOldMethodDisabled = isVercelMode;/u);
  assert.match(methodOverlay, /data-transcription-method=\{method\.id\}/u);
  assert.match(methodOverlay, /data-method-available=\{method\.disabled \? 'false' : 'true'\}/u);
  assert.match(journey, /methodAvailability\.newMethod, 'true'/u);
  assert.match(journey, /methodAvailability\.oldMethod, 'true'/u);
});

test('the max-duration request-window slider is a real native input this journey actually actuates', () => {
  assert.match(geminiPanel, /id="max-duration-slider"/u);
  assert.match(geminiPanel, /min=\{1\}/u);
  assert.match(geminiPanel, /max=\{20\}/u);
  assert.match(geminiPanel, /className="parallel-info"/u);
  assert.match(journey, /actuateNativeRange\(\{/u);
  assert.match(journey, /selector: durationSlider/u);
  assert.match(journey, /parallelInfoPresent, false/u);
});

test('the credential-free split-duration control is real, and the chunked-refusal edge case is documented rather than silently skipped', () => {
  assert.match(downloadOptionsModal, /id="consolidation-split-duration-slider"/u);
  assert.match(journey, /splitSlider = '#consolidation-split-duration-slider'/u);
  assert.match(journey, /actuateNativeRange\(\{ driver: browser, selector: splitSlider, value: 5/u);
  assert.match(journey, /GROUND TRUTH: a NONZERO split duration takes/u);
});

test('main-track translation exercises the direct call path bulkTranslationFileIO does not, and shares its refusal text', () => {
  assert.match(translationActions, /className=\{`translate-button \$\{isFormatMode \? 'format-button' : ''\}`\}/u);
  assert.match(bulkTranslationJourney, /native gemini operation could not be completed/iu);
  assert.match(journey, /add-chain-item-btn:not\(\.delimiter\):not\(\.original\)/u);
  assert.match(journey, /TARGET_LANGUAGE = 'Spanish'/u);
  assert.match(journey, /afterC\.cues, beforeC\.cues/u);
});

test('this journey follows the same refusal-boundary and log-silence shape geminiCredentialBoundary already proves', () => {
  assert.match(geminiCredentialBoundaryJourney, /errorToasts:/u);
  assert.match(geminiCredentialBoundaryJourney, /after\.jobs\.filter/u);
  assert.match(journey, /jobsOfKind\(after\), jobsOfKind\(before\)/u);
  assert.match(journey, /PROVIDER_JOB_KINDS/u);
});

test('the durable-state oracle this journey depends on reads real SQLite, not a fixture', () => {
  assert.match(database, /export const durableState = \(root\) => withDatabase/u);
  assert.match(database, /FROM jobs/u);
  assert.match(database, /FROM artifacts/u);
});

test('the journey never substitutes a native command, private IPC, raw SQL, or a real credential', () => {
  for (const [label, forbidden] of [
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand/u],
    ['native picker', /showOpen|showSave|input\s*\[\s*type\s*=\s*["']file/u],
    ['raw SQL', /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|app_settings|projects|jobs)\b/iu],
    ['a real provider credential value', /AIza|ya29\.|client_secret['"]?\s*:\s*['"][^'"]{10,}/u],
  ]) {
    assert.doesNotMatch(journey, forbidden, `journey contains forbidden ${label}`);
  }
});

test('the contract fails when any one load-bearing assertion is removed', () => {
  const assertJourneyStillProvesTheWall = (source) => {
    assert.match(source, /methodAvailability\.oldMethod, 'true'/u);
    assert.match(source, /NATIVE_GEMINI_REFUSAL_MESSAGE/u);
    assert.match(source, /expectedMessage: 'Generation failed'/u);
    assert.match(source, /credentialAvailable === false/u);
    assert.match(source, /afterE\.jobs, beforeE\.jobs/u);
  };
  assertJourneyStillProvesTheWall(journey);
  for (const needle of [
    "methodAvailability.oldMethod, 'true'",
    "expectedMessage: 'Generation failed'",
    'credentialAvailable === false',
    'afterE.jobs, beforeE.jobs',
  ]) {
    const weakened = journey.replace(needle, '/* removed */');
    assert.notEqual(weakened, journey, `mutation needle is stale: ${needle}`);
    assert.throws(() => assertJourneyStillProvesTheWall(weakened), undefined, needle);
  }
});
