import {
  TRANSCRIPTION_CONTENT_TYPE_TOKEN,
  hasExactlyOneContentTypeToken,
  normalizeTranscriptionPrompt,
} from './transcriptionPromptInvariant';

it('keeps a valid prompt byte-for-byte unchanged', () => {
  const prompt = 'Transcribe this {contentType} exactly.\nKeep punctuation.';

  expect(normalizeTranscriptionPrompt(prompt, 'unused {contentType} fallback'))
    .toBe(prompt);
  expect(hasExactlyOneContentTypeToken(prompt)).toBe(true);
});

it('appends one required token to a non-empty legacy prompt', () => {
  expect(normalizeTranscriptionPrompt('Legacy prompt without the variable   '))
    .toBe(`Legacy prompt without the variable\n\n${TRANSCRIPTION_CONTENT_TYPE_TOKEN}`);
});

it('keeps the first token and removes hostile duplicate tokens', () => {
  const normalized = normalizeTranscriptionPrompt(
    'Before {contentType} middle {contentType} after {contentType}.'
  );

  expect(normalized).toBe('Before {contentType} middle  after .');
  expect(normalized.split(TRANSCRIPTION_CONTENT_TYPE_TOKEN)).toHaveLength(2);
});

it('restores the last valid prompt for an empty or non-string draft', () => {
  const lastValid = 'Previously valid {contentType} prompt';

  expect(normalizeTranscriptionPrompt('', lastValid)).toBe(lastValid);
  expect(normalizeTranscriptionPrompt(null, lastValid)).toBe(lastValid);
  expect(normalizeTranscriptionPrompt('undefined', lastValid)).toBe(lastValid);
  expect(normalizeTranscriptionPrompt('null', lastValid)).toBe(lastValid);
});
