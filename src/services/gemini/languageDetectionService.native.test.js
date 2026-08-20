import { detectSubtitleLanguage } from './languageDetectionService';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';

vi.mock('../../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktopRuntime: () => true,
}));
vi.mock('../../platform/nativeGeminiText', () => ({
  runNativeGeminiText: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  runNativeGeminiText.mockReset();
  global.fetch = vi.fn(() => {
    throw new Error('native language detection must not use browser fetch');
  });
});

afterAll(() => {
  delete global.fetch;
});

test('native language detection uses structured Rust Gemini output', async () => {
  runNativeGeminiText.mockResolvedValue({
    text: JSON.stringify({
      languageCode: 'ko',
      languageName: 'Korean',
      isMultiLanguage: false,
      secondaryLanguages: [],
    }),
  });

  await expect(detectSubtitleLanguage([
    { text: '안녕하세요' },
  ], 'original', 'gemini-3.5-flash-lite')).resolves.toEqual({
    languageCode: 'ko',
    languageName: 'Korean',
    isMultiLanguage: false,
    secondaryLanguages: [],
  });
  expect(runNativeGeminiText).toHaveBeenCalledWith(expect.objectContaining({
    task: 'analyzeSubtitles',
    model: 'gemini-3.5-flash-lite',
    responseJsonSchema: expect.objectContaining({ type: 'object' }),
  }));
  expect(global.fetch).not.toHaveBeenCalled();
});

test('native language detection retains the safe English fallback on failure', async () => {
  runNativeGeminiText.mockRejectedValue(new Error('native failure'));

  await expect(detectSubtitleLanguage([
    { text: 'unknown' },
  ], 'original', 'gemini-3.5-flash-lite')).resolves.toEqual({
    languageCode: 'en',
    languageName: 'English',
    isMultiLanguage: false,
    secondaryLanguages: [],
  });
  expect(global.fetch).not.toHaveBeenCalled();
});
