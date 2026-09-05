import { getTranscriptionPrompt } from './promptManagement';

const promptContext = { presetId: 'general', useTranscriptionRules: false };
it.each(['audio', 'video'])('passes the requested cue length to %s generation', contentType => {
  const prompt = getTranscriptionPrompt(contentType, null, {
    promptContext, autoSplitSubtitles: true, maxWordsPerSubtitle: 12,
  });
  expect(prompt).toContain('at most 12 words per cue');
  expect(prompt).toContain('time each cue independently');
});
it('does not override supplied line identities or disabled splitting', () => {
  expect(getTranscriptionPrompt('audio', 'An exact supplied line', {
    promptContext, autoSplitSubtitles: true, maxWordsPerSubtitle: 2,
  })).not.toContain('Subtitle cue length:');
  expect(getTranscriptionPrompt('video', null, {
    promptContext, autoSplitSubtitles: false, maxWordsPerSubtitle: 12,
  })).not.toContain('Subtitle cue length:');
});
it.each([0, -1, 1.5, Infinity, 'bad', 1001])('rejects invalid cue-length guidance %s', maximum => {
  expect(getTranscriptionPrompt('audio', null, {
    promptContext, autoSplitSubtitles: true, maxWordsPerSubtitle: maximum,
  })).not.toContain('Subtitle cue length:');
});
