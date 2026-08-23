import { getTranscriptionRulesSync } from '../../utils/transcriptionRulesStore';
import { buildTranslationPrompt } from './translationPromptBuilder';

vi.mock('../../utils/transcriptionRulesStore', () => ({
  getTranscriptionRulesSync: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getTranscriptionRulesSync.mockReturnValue(null);
});

test('appends the hydrated project rules when translation requests their context', () => {
  getTranscriptionRulesSync.mockReturnValue({
    atmosphere: 'quiet interview',
    terminology: [{ term: 'OSG', definition: 'keep unchanged' }],
  });

  const prompt = buildTranslationPrompt({
    subtitleText: 'Hello',
    targetLanguage: 'Vietnamese',
    isMultiLanguage: false,
    customPrompt: 'Translate {subtitlesText} to {targetLanguage}.',
    includeRules: true,
  });

  expect(prompt).toContain('Translate Hello to Vietnamese.');
  expect(prompt).toContain('Atmosphere/Context: quiet interview');
  expect(prompt).toContain('OSG: keep unchanged');
});

test('does not invent rules context when the active project has none', () => {
  const prompt = buildTranslationPrompt({
    subtitleText: 'Hello',
    targetLanguage: 'Vietnamese',
    isMultiLanguage: false,
    customPrompt: 'Translate {subtitlesText} to {targetLanguage}.',
    includeRules: true,
  });

  expect(prompt).toBe('Translate Hello to Vietnamese.');
});
