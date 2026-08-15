import {
  DEFAULT_TRANSCRIPTION_PROMPT,
  getEmptySpeechPolicy,
  getTranscriptionPrompt,
} from './promptManagement';

const selectPreset = (preset, prompt = null) => {
  localStorage.clear();
  if (preset !== null) localStorage.setItem('video_processing_prompt_preset', preset);
  if (prompt !== null) localStorage.setItem('transcription_prompt', prompt);
};

afterEach(() => localStorage.clear());

it.each(['general', 'focus-lyrics', 'translate-directly', 'diarize-speakers'])(
  'enables proven-silence handling for the built-in %s speech preset',
  (preset) => {
    selectPreset(preset);
    expect(getEmptySpeechPolicy('video')).toBe('provenSilence');
  }
);

it.each(['extract-text', 'describe-video', 'chaptering'])(
  'does not reinterpret the built-in %s visual preset as speech-only',
  (preset) => {
    selectPreset(preset);
    expect(getEmptySpeechPolicy('video')).toBeUndefined();
  }
);

it('fails open for custom and unknown prompt intents', () => {
  selectPreset('settings', 'Describe ambience, silence, and visible activity.');
  expect(getEmptySpeechPolicy('video')).toBeUndefined();

  selectPreset('my-custom-preset');
  expect(getEmptySpeechPolicy('video')).toBeUndefined();
});

it('uses a selected saved user prompt without treating it as speech-only', () => {
  localStorage.setItem('user_prompt_presets', JSON.stringify([{
    id: 'user-scene-notes',
    title: 'Scene notes',
    prompt: 'Describe every quiet scene in this {contentType}.',
  }]));
  localStorage.setItem('video_processing_prompt_preset', 'user-scene-notes');

  expect(getTranscriptionPrompt('video')).toBe('Describe every quiet scene in this video.');
  expect(getEmptySpeechPolicy('video')).toBeUndefined();
});

it('recognizes only an exact built-in speech prompt in settings', () => {
  selectPreset('settings', DEFAULT_TRANSCRIPTION_PROMPT);
  expect(getEmptySpeechPolicy('audio')).toBe('provenSilence');

  selectPreset('settings', DEFAULT_TRANSCRIPTION_PROMPT.replace('{contentType}', 'audio'));
  expect(getEmptySpeechPolicy('audio')).toBe('provenSilence');

  localStorage.setItem(
    'transcription_prompt',
    `${DEFAULT_TRANSCRIPTION_PROMPT.replace('{contentType}', 'audio')} Add a description.`
  );
  expect(getEmptySpeechPolicy('audio')).toBeUndefined();
});

it('never short-circuits supplied-line timing', () => {
  selectPreset('general');
  expect(getEmptySpeechPolicy('video', 'A line that still needs timing')).toBeUndefined();
});
