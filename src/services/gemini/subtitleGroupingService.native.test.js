import { groupSubtitlesForNarration } from './subtitleGroupingService';
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
    throw new Error('native subtitle grouping must not use browser fetch');
  });
});

afterAll(() => {
  delete global.fetch;
});

test('native subtitle grouping preserves timing and source lineage', async () => {
  runNativeGeminiText.mockResolvedValue({
    text: JSON.stringify({ groups: { 1: [1, 2], 2: [3] } }),
  });
  const subtitles = [
    { id: 1, start: 0, end: 1, text: 'This is' },
    { id: 2, start: 1, end: 2, text: 'one thought.' },
    { id: 3, start: 3, end: 4, text: 'Another.' },
  ];

  const result = await groupSubtitlesForNarration(
    subtitles,
    'en',
    'gemini-3.5-flash-lite',
    'moderate'
  );

  expect(result.success).toBe(true);
  expect(result.groupedSubtitles).toEqual([
    expect.objectContaining({
      id: 1,
      start: 0,
      end: 2,
      text: 'This is one thought.',
      original_ids: [1, 2],
    }),
    expect.objectContaining({
      id: 2,
      start: 3,
      end: 4,
      text: 'Another.',
      original_ids: [3],
    }),
  ]);
  expect(runNativeGeminiText).toHaveBeenCalledWith(expect.objectContaining({
    task: 'analyzeSubtitles',
    model: 'gemini-3.5-flash-lite',
  }));
  expect(global.fetch).not.toHaveBeenCalled();
});

test('native grouping failure preserves the original subtitles', async () => {
  runNativeGeminiText.mockRejectedValue(new Error('native failure'));
  const subtitles = [{ id: 1, start: 0, end: 1, text: 'Keep me' }];

  const result = await groupSubtitlesForNarration(
    subtitles,
    'en',
    'gemini-3.5-flash-lite'
  );

  expect(result).toMatchObject({
    success: false,
    groupedSubtitles: subtitles,
    groupMapping: {},
  });
  expect(global.fetch).not.toHaveBeenCalled();
});
