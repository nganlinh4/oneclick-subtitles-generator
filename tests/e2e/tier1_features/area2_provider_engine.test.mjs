// Tier 1: Feature Coverage - Area 2: Specialized Provider & Native Engine (F05-F10)
// Specifications: ORIGINAL_REQUEST.md §R2, PROJECT.md F05-F10, WORD_NATIVE_TRANSCRIPTION_HANDOFF.md

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_GEMINI_35_TRANSCRIBE,
  buildTranscriptionRequest,
  parseDurationToNanoseconds,
  parseDurationToMs,
  projectWordWith100msOvershootPolicy,
  projectWindowOffset,
  namespaceSpeaker,
} from '../support/contracts.mjs';
import { createProviderSseChunk } from '../support/e2e_test_harness.mjs';

test('T1.2.1: Provider wire request formatting for gemini-3.5-transcribe with wordTimestamp and language hints', () => {
  const dummyAudio = Buffer.from('fake-wav-bytes').toString('base64');
  const request = buildTranscriptionRequest({
    audioBase64: dummyAudio,
    mimeType: 'audio/wav',
    wordTimestamp: true,
    diarization: true,
    languageHints: ['en', 'vi'],
  });

  assert.equal(MODEL_GEMINI_35_TRANSCRIBE, 'gemini-3.5-transcribe');
  assert.equal(request.generationConfig.audioTranscriptionConfig.wordTimestamp, true);
  assert.equal(request.generationConfig.audioTranscriptionConfig.diarization, true);
  assert.deepEqual(request.generationConfig.audioTranscriptionConfig.languageHints, ['en', 'vi']);
  assert.equal(request.contents[0].parts[0].inlineData.mimeType, 'audio/wav');
});

test('T1.2.2: Provider response parser extracts audioTranscription.words and speaker labels', () => {
  const sseChunk = createProviderSseChunk({
    words: [
      { word: 'Hello', startOffset: '0.120s', endOffset: '0.450s', speakerLabel: '1' },
      { word: 'world', startOffset: '0.500s', endOffset: '0.900s', speakerLabel: '1' },
    ],
    isDone: false,
  });

  assert.ok(sseChunk.startsWith('data: '));
  const payload = JSON.parse(sseChunk.replace('data: ', '').trim());
  const words = payload.candidates[0].content.parts[0].audioTranscription.words;

  assert.equal(words.length, 2);
  assert.equal(words[0].word, 'Hello');
  assert.equal(words[0].startOffset, '0.120s');
  assert.equal(words[0].speakerLabel, '1');
  assert.equal(words[1].word, 'world');
});

test('T1.2.3: Duration parser accurately parses standard provider durations with bounded integer arithmetic', () => {
  // Nanosecond precision parsing
  assert.equal(parseDurationToNanoseconds('0s'), 0n);
  assert.equal(parseDurationToNanoseconds('1s'), 1_000_000_000n);
  assert.equal(parseDurationToNanoseconds('12.345s'), 12_345_000_000n);
  assert.equal(parseDurationToNanoseconds('0.000000001s'), 1n);

  // Millisecond conversion
  assert.equal(parseDurationToMs('0.120s'), 120);
  assert.equal(parseDurationToMs('1.500s'), 1500);
  assert.equal(parseDurationToMs('300.100s'), 300100);
});

test('T1.2.4: 100ms overshoot projection policy clamps <=100ms overshoot and quarantines >100ms', () => {
  const mediaDurationMs = 300_000; // 5 minute media

  // Case A: Normal word within media
  const normal = projectWordWith100msOvershootPolicy(
    { word: 'valid', start_offset: '298.000s', end_offset: '299.500s' },
    mediaDurationMs
  );
  assert.equal(normal.status, 'accepted');
  assert.equal(normal.word.start_ms, 298000);
  assert.equal(normal.word.end_ms, 299500);

  // Case B: Measured 100ms overshoot (300.1s on 300s extraction from research ledger)
  const clamped = projectWordWith100msOvershootPolicy(
    { word: 'overshoot', start_offset: '299.500s', end_offset: '300.100s' },
    mediaDurationMs
  );
  assert.equal(clamped.status, 'clamped');
  assert.equal(clamped.word.original_end_ms, 300100);
  assert.equal(clamped.word.clamped_end_ms, 300000);
  assert.equal(clamped.word.overshoot_ms, 100);

  // Case C: Overshoot > 100ms (quarantined)
  const quarantined = projectWordWith100msOvershootPolicy(
    { word: 'excessive', start_offset: '299.000s', end_offset: '300.250s' },
    mediaDurationMs
  );
  assert.equal(quarantined.status, 'quarantined');
  assert.ok(quarantined.reason.includes('overshoot_exceeds_100ms'));
});

test('T1.2.5: Strict provider separation excludes prompt schemas, FPS, thinking, and resolution from ASR request', () => {
  const dummyAudio = Buffer.from('audio-bytes').toString('base64');
  const request = buildTranscriptionRequest({
    audioBase64: dummyAudio,
    wordTimestamp: true,
  });

  // Verify none of the text/generation fields leaked into transcription request
  const part = request.contents[0].parts[0];
  assert.equal(part.text, undefined);
  assert.equal(request.generationConfig.thinkingConfig, undefined);
  assert.equal(request.generationConfig.fps, undefined);
  assert.equal(request.generationConfig.responseSchema, undefined);
});

test('T1.2.6: Authoritative native engine applies capture-to-project offset projection and speaker namespacing', () => {
  // Window 1 starts at 60,000ms (1 minute into project)
  const windowStartMs = 60_000;
  const wordStartOffsetMs = 4_500;
  const wordEndOffsetMs = 4_950;

  const projectStartMs = projectWindowOffset(windowStartMs, wordStartOffsetMs);
  const projectEndMs = projectWindowOffset(windowStartMs, wordEndOffsetMs);

  assert.equal(projectStartMs, 64_500);
  assert.equal(projectEndMs, 64_950);

  // Speaker namespacing per window
  const window0Speaker = namespaceSpeaker(0, 'speaker_1');
  const window1Speaker = namespaceSpeaker(1, 'speaker_1');

  assert.equal(window0Speaker, 'w0:speaker_1');
  assert.equal(window1Speaker, 'w1:speaker_1');
  assert.notEqual(window0Speaker, window1Speaker, 'Window speakers must be namespaced to prevent cross-window false identity');
});
