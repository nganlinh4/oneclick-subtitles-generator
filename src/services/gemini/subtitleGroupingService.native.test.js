import { groupSubtitlesForNarration } from './subtitleGroupingService';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';

const JOB_ID = '01890f39-7b62-7c4e-8c9a-000000000401';
const DELIVERY_ID = '01890f39-7b62-7c4e-8c9a-000000000402';
const acknowledge = vi.fn();

const delivery = (value) => ({
  text: JSON.stringify(value),
  job: { id: JOB_ID },
  deliveryId: DELIVERY_ID,
  acknowledge,
});

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
  acknowledge.mockReset();
  global.fetch = vi.fn(() => {
    throw new Error('native subtitle grouping must not use browser fetch');
  });
});

afterAll(() => {
  delete global.fetch;
});

test('native subtitle grouping preserves timing and source lineage', async () => {
  runNativeGeminiText.mockResolvedValue(delivery({ groups: [[1, 2], [3]] }));
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
  expect(result).toMatchObject({
    providerJobId: JOB_ID,
    deliveryId: DELIVERY_ID,
    acknowledge,
  });
  expect(acknowledge).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('native grouping failure stays failed instead of fabricating a fallback', async () => {
  runNativeGeminiText.mockRejectedValue(new Error('native failure'));
  const subtitles = [{ id: 1, start: 0, end: 1, text: 'Keep me' }];

  await expect(groupSubtitlesForNarration(
    subtitles,
    'en',
    'gemini-3.5-flash-lite'
  )).rejects.toThrow('native failure');
  expect(global.fetch).not.toHaveBeenCalled();
});

test.each([
  ['prose wrapped JSON', 'result: {"groups":[[1],[2],[3]]}'],
  ['legacy object groups', JSON.stringify({ groups: { 1: [1], 2: [2], 3: [3] } })],
  ['duplicate', JSON.stringify({ groups: [[1, 2], [2, 3]] })],
  ['missing', JSON.stringify({ groups: [[1], [3]] })],
  ['shuffled', JSON.stringify({ groups: [[2], [1, 3]] })],
  ['unknown', JSON.stringify({ groups: [[1, 2], [3, 4]] })],
  ['string coercion', JSON.stringify({ groups: [['1', 2], [3]] })],
  ['extra root property', JSON.stringify({ groups: [[1], [2], [3]], explanation: 'ok' })],
])('rejects %s without acknowledging or inventing groups', async (_label, text) => {
  runNativeGeminiText.mockResolvedValue({ ...delivery({ groups: [[1], [2], [3]] }), text });
  const subtitles = [
    { id: 'a', start: 0, end: 1, text: 'A' },
    { id: 'b', start: 1, end: 2, text: 'B' },
    { id: 'c', start: 2, end: 3, text: 'C' },
  ];
  await expect(groupSubtitlesForNarration(subtitles)).rejects.toMatchObject({
    code: expect.stringMatching(/^invalidSubtitleGrouping/u),
  });
  expect(acknowledge).not.toHaveBeenCalled();
});

test.each([
  ['blank text', [{ id: 1, start: 0, end: 1, text: '  ' }]],
  ['zero duration', [{ id: 1, start: 1, end: 1, text: 'A' }]],
  ['unordered timing', [
    { id: 1, start: 2, end: 3, text: 'A' },
    { id: 2, start: 1, end: 4, text: 'B' },
  ]],
  ['duplicate IDs', [
    { id: 'same', start: 0, end: 1, text: 'A' },
    { id: 'same', start: 1, end: 2, text: 'B' },
  ]],
])('refuses invalid source: %s', async (_label, subtitles) => {
  await expect(groupSubtitlesForNarration(subtitles)).rejects.toMatchObject({
    code: 'invalidSubtitleGroupingData',
  });
  expect(runNativeGeminiText).not.toHaveBeenCalled();
});
