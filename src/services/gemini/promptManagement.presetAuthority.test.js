import { getTranscriptionPrompt } from './promptManagement';

const context = (overrides = {}) => ({
  presetId: 'settings',
  settingsPrompt: 'Settings {contentType} prompt',
  customLanguage: '',
  useTranscriptionRules: false,
  transcriptionRules: null,
  userPromptPresets: [],
  ...overrides,
});

it.each(['undefined', 'null', '']) (
  'falls back from hostile Settings prompt value %j at the action boundary',
  (settingsPrompt) => {
    expect(getTranscriptionPrompt('video', null, {
      promptContext: context({ settingsPrompt }),
    })).toBe(
      'Transcribe all spoken content in this video. Include the exact start and end times for each segment of speech.',
    );
  },
);

it('normalizes a legacy Settings prompt before substituting content type', () => {
  expect(getTranscriptionPrompt('audio', null, {
    promptContext: context({ settingsPrompt: 'Legacy custom prompt' }),
  })).toBe('Legacy custom prompt\n\naudio');
});

it('normalizes hostile duplicate tokens in a user preset at the action boundary', () => {
  expect(getTranscriptionPrompt('video', null, {
    promptContext: context({
      presetId: 'user-hostile',
      userPromptPresets: [{
        id: 'user-hostile',
        prompt: 'Before {contentType} after {contentType}',
      }],
    }),
  })).toBe('Before video after ');
});
