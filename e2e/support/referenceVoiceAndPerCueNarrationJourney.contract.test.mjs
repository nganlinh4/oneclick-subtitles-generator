import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (...segments) => readFileSync(join(import.meta.dirname, ...segments), 'utf8');

const journeyPath = join(
  import.meta.dirname, '..', 'journeys', 'referenceVoiceAndPerCueNarration.journey.js',
);
const journey = readFileSync(journeyPath, 'utf8');
const oracle = read('narrationControlOracle.js');
const narrationMethodSelection = read('..', '..', 'src', 'components', 'narration', 'components', 'NarrationMethodSelection.js');
const audioControls = read('..', '..', 'src', 'components', 'narration', 'components', 'AudioControls.js');
const referenceAudioSection = read('..', '..', 'src', 'components', 'narration', 'components', 'ReferenceAudioSection.js');
const f5ttsSection = read('..', '..', 'src', 'components', 'narration', 'sections', 'F5TTSNarrationSection.js');
const chatterboxSection = read('..', '..', 'src', 'components', 'narration', 'sections', 'ChatterboxNarrationSection.js');
const resultRow = read('..', '..', 'src', 'components', 'narration', 'components', 'ResultRow.js');
const narrationResults = read('..', '..', 'src', 'components', 'narration', 'components', 'NarrationResults.js');
const nativeNarrationController = read('..', '..', 'src', 'components', 'narration', 'hooks', 'useNativeNarrationController.js');
const audioPlayback = read('..', '..', 'src', 'components', 'narration', 'hooks', 'useAudioPlayback.js');
const gttsSection = read('..', '..', 'src', 'components', 'narration', 'sections', 'GTTSNarrationSection.js');
const narrationGenerationJourney = read('..', 'journeys', 'narrationGeneration.journey.js');
const narrationLocaleEn = JSON.parse(read('..', '..', 'src', 'i18n', 'locales', 'en', 'narration.json'));

const assertJourneyContract = (source) => {
  // Part 1: the honest reference-voice boundary. Both cloning methods' radios must be proven
  // disabled, unavailable-styled, tooltip-matched, and functionally inert against a raw click.
  assert.match(source, /REFERENCE_VOICE_METHODS = Object\.freeze\(\['f5tts', 'chatterbox'\]\)/u);
  assert.match(source, /state\.disabled,\s*\n\s*true,/u);
  assert.match(source, /state\.unavailableClass, true/u);
  // HelpIcon/Tooltip renders no native `title` attribute -- its text only exists in a document.body
  // portal after a click toggles Tooltip.jsx's own visibility state, so the journey must trigger
  // that click and read the portal rather than a (permanently null) DOM attribute.
  assert.match(source, /\.oc-tooltip\.oc-tooltip-visible \.oc-tooltip-content/u);
  assert.match(source, /tooltip,\s*\n\s*REFERENCE_VOICE_ENGINE_UNAVAILABLE_MESSAGE/u);
  assert.match(source, /referenceVoiceControlsMounted\(\)/u);
  assert.match(source, /document\.querySelector\(`#method-\$\{method\}`\)\?\.click\(\)/u);

  // Part 2: the durable per-cue regenerate ownership claim.
  assert.match(source, /verifyPerCueRegenerationRebinding\(/u);
  assert.match(source, /verifySiblingArtifactsUntouched\(siblings\)/u);
  assert.match(source, /regeneratedOrdinal: REGENERATED_ORDINAL/u);
  assert.match(source, /assert\.notEqual\(\s*\n\s*sha256File\(regeneratedPath\),\s*\n\s*preRegenerateHashes\.get\(REGENERATED_ORDINAL\)\.sha256,/u);
  assert.match(source, /afterSize: statSync\(path\)\.size/u);
  assert.match(source, /afterSha256: sha256File\(path\)/u);

  // Play/pause drives the real hidden <audio> element, not only a CSS class.
  assert.match(source, /playState\.audioPaused === false && Boolean\(playState\.audioSrc\)/u);
  assert.match(source, /playState\.audioPaused === true/u);

  for (const [label, forbidden] of [
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand/u],
    ['native picker', /showOpen|showSave|OSG_E2E_MEDIA_SELECTION/u],
    ['raw SQL', /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|app_settings|projects|jobs)\b/iu],
    ['a real provider credential value', /AIza|ya29\.|client_secret['"]?\s*:\s*['"][^'"]{10,}/u],
    ['microphone capture', /getUserMedia|MediaRecorder/u],
  ]) {
    assert.doesNotMatch(source, forbidden, `journey contains forbidden ${label}`);
  }
};

test('the journey proves the honest reference-voice boundary and single-cue regenerate ownership', () => {
  assertJourneyContract(journey);
});

test('the contract fails when any one load-bearing assertion is removed', () => {
  for (const needle of [
    'verifyPerCueRegenerationRebinding(',
    'verifySiblingArtifactsUntouched(siblings)',
    "assert.equal(state.unavailableClass, true, `${method}'s label lost its unavailable styling`);",
    'document.querySelector(`#method-${method}`)?.click()',
  ]) {
    const weakened = journey.replace(needle, '/* removed */');
    assert.notEqual(weakened, journey, `mutation needle is stale: ${needle}`);
    assert.throws(() => assertJourneyContract(weakened), undefined, needle);
  }
});

test('ground truth: F5-TTS/Chatterbox method radios are really disabled, not just their upload button', () => {
  // NarrationMethodSelection.js disables the radio INPUT itself, which is a stronger boundary than
  // AudioControls.js separately disabling Upload/Record: the customer cannot even select the tab.
  assert.match(narrationMethodSelection, /id="method-f5tts"/u);
  assert.match(narrationMethodSelection, /disabled=\{isGenerating \|\| !isF5Available\}/u);
  assert.match(narrationMethodSelection, /id="method-chatterbox"/u);
  assert.match(narrationMethodSelection, /disabled=\{isGenerating \|\| !isChatterboxAvailable\}/u);
  assert.match(narrationMethodSelection, /className=\{`method-f5tts \$\{!isF5Available \? 'unavailable' : ''\}`\}/u);
  assert.match(narrationMethodSelection, /className=\{`method-chatterbox \$\{!isChatterboxAvailable \? 'unavailable' : ''\}`\}/u);
  assert.match(
    narrationMethodSelection,
    /'This narration engine is not ready\. Install or start it in Settings > Tools\.'/u,
  );
  // The handler itself refuses to switch to an unavailable method even if a click were dispatched.
  assert.match(narrationMethodSelection, /availableMethods\[method\] === true/u);
});

test('ground truth: reference-voice upload/record controls are gated on the same isAvailable prop', () => {
  assert.match(audioControls, /disabled=\{isRecording \|\| isStartingRecording \|\| !isAvailable\}/u);
  assert.match(f5ttsSection, /isAvailable=\{isAvailable\}/u);
  assert.match(chatterboxSection, /isAvailable=\{isChatterboxAvailable\}/u);
  assert.match(referenceAudioSection, /reference-audio-row/u);
  assert.match(audioControls, /audio-controls-row/u);
  // gTTS -- the engine this journey actually generates with -- has no reference-voice UI at all,
  // confirming the journey's Part 2 must use a different section than Part 1's boundary check.
  assert.doesNotMatch(gttsSection, /ReferenceAudioSection|AudioControls/u);
});

test('ground truth: retry() regenerates exactly one cue in place and persists the merged results', () => {
  assert.match(nativeNarrationController, /const retry = useCallback\(async \(method, subtitleId\) => \{/u);
  assert.match(nativeNarrationController, /return await run\(method, \[subtitle\], \{ replace: false \}\)/u);
  assert.match(nativeNarrationController, /await persistNativeResults\(method, next, authority, source\)/u);
});

test('ground truth: ResultRow exposes exactly play/download/regenerate for a succeeded cue, no delete', () => {
  assert.match(resultRow, /onClick=\{\(\) => playAudio\(result\)\}/u);
  assert.match(resultRow, /onClick=\{\(\) => downloadAudio\(result\)\}/u);
  assert.match(resultRow, /onClick=\{retry\}/u);
  assert.doesNotMatch(resultRow, /onDelete|onRemove|delete-button|remove-button/iu);
  assert.match(resultRow, /'play_arrow'/u);
  assert.match(resultRow, /'pause'/u);
  // The regenerate icon is literal JSX text content, not a quoted string.
  assert.match(resultRow, />refresh<\/span>/u);
});

test('ground truth: playback drives the hidden <audio> element via isPlaying/currentAudio, not a mock', () => {
  assert.match(audioPlayback, /audioRef\.current\.play\(\)/u);
  assert.match(audioPlayback, /audioRef\.current\.pause\(\)/u);
  assert.match(gttsSection, /<audio[\s\S]{0,80}ref=\{audioRef\}/u);
  assert.match(resultRow, /data-narration-result-state=\{result\.success \? 'succeeded'/u);
  assert.match(narrationResults, /results-virtualized-list/u);
});

test('the oracle module normalizes artifact identifiers before comparing, matching SQLite hex vs. checkpoint UUID', () => {
  assert.match(oracle, /normalizeId = \(value\) => String\(value \?\? ''\)\.replaceAll\('-', ''\)\.toLowerCase\(\)/u);
  assert.match(oracle, /normalizeId\(after\.artifactId\)/u);
});

test('the oracle pins the LOADED i18n resource text (which i18next prefers), not a call site\'s fallback default', () => {
  // i18next's t(key, fallback) returns the loaded resource value whenever the key exists; the
  // fallback string embedded at each call site (asserted with its own literal '>' above) is only
  // ever used if the key were missing. The resource is what a customer actually sees.
  assert.equal(
    narrationLocaleEn.engineUnavailableMessage,
    'This narration engine is not ready. Install or start it in Settings → Tools.',
  );
  assert.match(oracle, /REFERENCE_VOICE_ENGINE_UNAVAILABLE_MESSAGE = \(\s*\n\s*'This narration engine is not ready\. Install or start it in Settings → Tools\.'/u);
});

test('this journey follows the same durable-checkpoint oracle shape narrationGeneration.journey.js already proves', () => {
  assert.match(narrationGenerationJourney, /durableProjectNarrations\(root\)/u);
  assert.match(narrationGenerationJourney, /verifyNarrationGenerationOwnership\(/u);
  assert.match(journey, /durableProjectNarrations\(root\)/u);
  assert.match(journey, /verifyNarrationGenerationOwnership\(/u);
});
