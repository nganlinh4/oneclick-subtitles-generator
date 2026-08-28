import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (...segments) => readFileSync(join(import.meta.dirname, ...segments), 'utf8');

const journeyPath = join(
  import.meta.dirname, '..', 'journeys', 'transcriptionRulesAndAnalysis.journey.js',
);
const journey = readFileSync(journeyPath, 'utf8');
const oracle = read('segmentationShapeOracle.js');
const asrControls = read('asrSegmentationControls.js');
const videoAnalysisButton = read('..', '..', 'src', 'components', 'VideoAnalysisButton.js');
const buttonsContainer = read('..', '..', 'src', 'components', 'app', 'ButtonsContainer.jsx');
const analysisUtils = read('..', '..', 'src', 'utils', 'videoProcessing', 'analysisUtils.js');
const videoAnalysisService = read('..', '..', 'src', 'services', 'videoAnalysisService.js');
const nativeGeminiJobLifecycle = read('..', '..', 'src', 'platform', 'nativeGeminiJobLifecycle.js');
const geminiPanel = read('..', '..', 'src', 'components', 'VideoProcessingModalGeminiPanel.js');
const asrProcessingOptions = read('..', '..', 'src', 'components', 'AsrProcessingOptions.js');
const useAsrOptions = read('..', '..', 'src', 'components', 'useAsrOptions.js');
const asrAdapter = read('..', '..', 'src', 'services', 'engines', 'AsrAdapter.js');
const runVideoProcess = read('..', '..', 'src', 'components', 'runVideoProcess.js');
const asrOptionsRs = read('..', '..', 'crates', 'osg-asr', 'src', 'options.rs');
const segmentRs = read('..', '..', 'crates', 'osg-asr', 'src', 'segment.rs');
const geminiCredentialBoundaryJourney = read('..', 'journeys', 'geminiCredentialBoundary.journey.js');
const runIsolated = read('..', 'run-isolated.mjs');

const assertJourneyContract = (source) => {
  // Part 1: video analysis / transcription rules refuse cleanly with zero side effects.
  assert.match(source, /surface\.errorToasts\.length > 0 && surface\.processing === false/u);
  assert.match(source, /assert\.equal\(surface\.hasAnalysis, false,/u);
  assert.match(source, /assertNoNewProviderJob\(\{ before: beforeAnalysis, after: afterAnalysis,/u);
  assert.match(source, /assert\.equal\(afterAnalysis\.counts\.cues, 0,/u);
  assert.match(source, /doesNotMatch\(\s*\n\s*log,\s*\n\s*\/"event":"gemini\\\.\(\?:started\|progress\|completed\|failed\|cancelled\)"\/u,/u);
  assert.match(source, /assert\.equal\(rulesToggle\.disabled, true,/u);
  assert.match(source, /assert\.equal\(rulesToggle\.checked, false,/u);

  // Part 2: local ASR segmentation shape, proven across two real runs.
  assert.match(source, /verifyWordCappedSegmentationShape\(\{ cues: wordCappedCues, maxWords: WORD_CAP \}\)/u);
  assert.match(source, /verifySegmentationShapeDirection\(\{ wordCapped, sentence \}\)/u);
  assert.match(source, /selectAsrStrategy\('word'\)/u);
  assert.match(source, /selectAsrStrategy\('sentence'\)/u);
  assert.match(source, /selector: '#asr-max-words'/u);
  assert.match(source, /clickControl\('#asr-preserve-sentences'\)/u);

  for (const [label, forbidden] of [
    ['private IPC', /__TAURI__|invokeDesktop|invokeCommand/u],
    ['native picker', /showOpen|showSave|OSG_E2E_MEDIA_SELECTION/u],
    ['raw SQL', /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO|FROM|app_settings|projects|jobs)\b/iu],
    ['a real provider credential value', /AIza|ya29\.|client_secret['"]?\s*:\s*['"][^'"]{10,}/u],
  ]) {
    assert.doesNotMatch(source, forbidden, `journey contains forbidden ${label}`);
  }
};

test('the journey proves the honest analysis/rules refusal and the two-run segmentation-shape direction', () => {
  assertJourneyContract(journey);
});

test('the contract fails when any one load-bearing assertion is removed', () => {
  for (const needle of [
    'assertNoNewProviderJob({ before: beforeAnalysis, after: afterAnalysis, providerKinds: PROVIDER_JOB_KINDS });',
    'verifyWordCappedSegmentationShape({ cues: wordCappedCues, maxWords: WORD_CAP });',
    'const direction = verifySegmentationShapeDirection({ wordCapped, sentence });',
    "assert.equal(rulesToggle.disabled, true, 'the transcription-rules toggle is usable without any analysis');",
  ]) {
    const weakened = journey.replace(needle, '/* removed */');
    assert.notEqual(weakened, journey, `mutation needle is stale: ${needle}`);
    assert.throws(() => assertJourneyContract(weakened), undefined, needle);
  }
});

test('ground truth: VideoAnalysisButton is mounted in the real app tree, not orphaned', () => {
  assert.match(buttonsContainer, /import VideoAnalysisButton from/u);
  assert.match(buttonsContainer, /<VideoAnalysisButton/u);
  assert.match(videoAnalysisButton, /className=\{`video-analysis-button \$\{hasAnalysis \? 'has-analysis' : ''\}/u);
  assert.match(videoAnalysisButton, /onClick=\{hasAnalysis \? handleEditRules : handleAnalyzeVideo\}/u);
});

test('ground truth: "Add analysis" is Gemini-gated with no credential-free success path', () => {
  assert.match(videoAnalysisButton, /analyzeVideoAndWaitForUserChoice/u);
  assert.match(analysisUtils, /analyzeVideoWithGemini/u);
  assert.match(videoAnalysisService, /runNativeGeminiMediaAnalysis/u);
  // The native runner resolves a credential the same way every other native Gemini command does;
  // an absent credential breaks the attempt loop before any request reaches the network.
  assert.match(nativeGeminiJobLifecycle, /const credentialId = await getCredentialId\(\)/u);
  assert.match(nativeGeminiJobLifecycle, /if \(credentialId === null \|\| attemptedCredentials\.has\(credentialId\)\) break;/u);
  assert.match(nativeGeminiJobLifecycle, /let lastError = fixedError\('geminiCredentialUnavailable'\)/u);
});

test('ground truth: "edit rules" and manual rule authoring are reachable only after analysis exists', () => {
  assert.match(videoAnalysisButton, /onClick=\{hasAnalysis \? handleEditRules : handleAnalyzeVideo\}/u);
  assert.match(videoAnalysisButton, /const handleEditRules = async \(\) => \{/u);
  // hasAnalysis is derived from durably-saved rules; there is no separate "start blank" entry point.
  assert.match(videoAnalysisButton, /setHasAnalysis\(!!rules\)/u);
});

test('ground truth: "Use transcription rules from analysis" is wired only into the Gemini panel, never local ASR', () => {
  assert.match(geminiPanel, /id="use-transcription-rules"/u);
  assert.match(geminiPanel, /disabled=\{!transcriptionRulesAvailable\}/u);
  assert.match(geminiPanel, /checked=\{useTranscriptionRules && transcriptionRulesAvailable\}/u);
  assert.match(geminiPanel, /'Please create analysis by pressing "Add analysis" button'/u);
  assert.doesNotMatch(asrProcessingOptions, /useTranscriptionRules|transcriptionRules/u);
});

test('ground truth: the public ASR splitting controls map exactly onto SegmentationOptions', () => {
  assert.match(asrProcessingOptions, /parakeetSplittingMethod', 'Splitting method'/u);
  assert.match(asrProcessingOptions, /wordsSlider\('asr-max-words',/u);
  assert.match(asrProcessingOptions, /id="asr-preserve-sentences"/u);
  assert.match(useAsrOptions, /asr_\$\{engineId\}_segment_strategy/u);
  assert.match(useAsrOptions, /asr_\$\{engineId\}_preserve_sentences/u);
  assert.match(runVideoProcess, /asrMaxWords: asrStrategy === 'sentence' && asrPreserveSentences \? -1 : asrMaxWords/u);
  assert.match(asrAdapter, /strategy: options\.asrStrategy \|\| 'sentence'/u);
  assert.match(asrAdapter, /maxWords: options\.asrMaxWords \?\? 7/u);
});

test('ground truth: Rust enforces the public per-strategy word cap the journey asserts', () => {
  assert.match(asrOptionsRs, /pub enum SegmentStrategy \{/u);
  assert.match(asrOptionsRs, /Sentence,\s*\n\s*Word,\s*\n\s*Character,/u);
  assert.match(asrOptionsRs, /max_characters: u16,/u);
  assert.match(asrOptionsRs, /max_words: Option<u8>,/u);
  assert.match(asrOptionsRs, /pause_threshold_ms: u32,/u);
  // The word-strategy segment boundary: a segment ends once it holds `limit` words.
  assert.match(segmentRs, /options\.strategy\(\) == SegmentStrategy::Word && index \+ 1 - start >= usize::from\(limit\)/u);
  // append_balanced with no max_words pushes the WHOLE group unsplit -- the "preserve sentences" path.
  assert.match(segmentRs, /let Some\(max_words\) = max_words\.map\(usize::from\) else \{/u);
});

test('this journey follows the same credential-refusal shape geminiCredentialBoundary.journey.js proves', () => {
  assert.match(geminiCredentialBoundaryJourney, /providerKinds = new Set\(\['transcribe', 'translate', 'analyzeSubtitles'\]\)/u);
  assert.match(journey, /PROVIDER_JOB_KINDS = Object\.freeze\(\['analyzeSubtitles', 'transcribe', 'translate'\]\)/u);
  assert.match(geminiCredentialBoundaryJourney, /doesNotMatch\(log, \/"event":"gemini\\\.\(\?:started\|progress\|completed\|failed\|cancelled\)"\/\)/u);
});

test('run-isolated.mjs excludes this heavy two-run ASR journey from the ordinary default suite', () => {
  assert.match(runIsolated, /'transcriptionRulesAndAnalysis\.journey\.js',/u);
  assert.match(runIsolated, /NON_DEFAULT_JOURNEYS = new Set\(\[/u);
});

test('the oracle module counts words the same way the journey/Rust joiner produces them', () => {
  assert.match(oracle, /trimmed\.split\(\/\\s\+\/u\)\.length/u);
});

test('the ASR strategy dropdown helper scopes to the splitting-method half, not any dropdown', () => {
  assert.match(asrControls, /SPLITTING_METHOD_LABEL = 'Splitting method'/u);
  assert.match(asrControls, /\.asr-options-grid \.combined-option-half/u);
});
