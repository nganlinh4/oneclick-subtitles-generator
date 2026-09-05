import { PROMPT_PRESETS, getTranscriptionPrompt, shouldSplitGeneratedSubtitles } from './promptManagement';
import english from '../../i18n/locales/en/settings.json';
import vietnamese from '../../i18n/locales/vi/settings.json';
import korean from '../../i18n/locales/ko/settings.json';

const options = presetId => ({ promptContext: { presetId, useTranscriptionRules: false } });

it.each(PROMPT_PRESETS)('$id keeps UI copy separate from prompt instructions', preset => {
  expect(preset.description.length).toBeLessThan(90);
  expect(preset.description).not.toMatch(/\{|TARGET_LANGUAGE|\.\.\./);
  expect(preset.prompt.split('{contentType}')).toHaveLength(2);
  for (const locale of [english, vietnamese, korean]) {
    expect(locale[preset.descriptionKey.replace('settings.', '')]).toBeTruthy();
  }
});

it.each(['', '   ', undefined])('refuses translation without a target: %j', customLanguage => {
  expect(() => getTranscriptionPrompt('audio', null, {
    promptContext: { presetId: 'translate-directly', customLanguage },
  })).toThrow('Please enter a target language');
});

it('substitutes the chosen language literally', () => {
  const prompt = getTranscriptionPrompt('audio', null, {
    promptContext: { presetId: 'translate-directly', customLanguage: 'French ($&)' },
  });
  expect(prompt).toContain('French ($&)');
  expect(prompt).not.toContain('TARGET_LANGUAGE');
});

it('preserves chapter boundaries in both request and output splitting policy', () => {
  const chapter = { ...options('chaptering'), autoSplitSubtitles: true, maxWordsPerSubtitle: 12 };
  expect(shouldSplitGeneratedSubtitles(chapter)).toBe(false);
  expect(getTranscriptionPrompt('audio', null, chapter)).not.toContain('Subtitle cue length:');
  expect(shouldSplitGeneratedSubtitles({ ...chapter, ...options('general') })).toBe(true);
  expect(shouldSplitGeneratedSubtitles({ ...chapter, ...options('general'), userProvidedSubtitles: 'Exact line' })).toBe(false);
});

it.each(['extract-text', 'describe-video'])('does not turn %s into an audio task', presetId => {
  expect(() => getTranscriptionPrompt('audio', null, options(presetId))).toThrow('requires video frames');
});
