import { translateSubtitles } from './translation';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';

const runtimeMocks = vi.hoisted(() => ({
  isDesktopRuntime: vi.fn(() => true),
}));

vi.mock('../../platform/runtimeEnvironment', () => ({
  isDesktopRuntime: runtimeMocks.isDesktopRuntime,
}));
vi.mock('../../platform/nativeGeminiText', () => ({
  runNativeGeminiText: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  runtimeMocks.isDesktopRuntime.mockReturnValue(true);
  global.fetch = vi.fn(() => {
    throw new Error('native translation must not use browser fetch');
  });
  runNativeGeminiText.mockReset();
});

afterAll(() => {
  delete global.fetch;
});

test('native translation uses the Rust task and preserves subtitle timing', async () => {
  localStorage.setItem('original_subtitles_map', JSON.stringify({
    1: { id: 1, start: 90, end: 91, text: 'Stale project' },
  }));
  runNativeGeminiText.mockResolvedValue({
    text: JSON.stringify([
      { original: 'Hello', translated: '안녕하세요' },
      { original: 'World', translated: '세계' },
    ]),
    usage: null,
  });
  const subtitles = [
    { id: 1, start: 0, end: 1, text: 'Hello' },
    { id: 2, start: 1, end: 2, text: 'World' },
  ];

  const translated = await translateSubtitles(
    subtitles,
    'Korean',
    'gemini-3.5-flash-lite'
  );

  expect(translated).toEqual([
    expect.objectContaining({ id: 1, start: 0, end: 1, text: '안녕하세요' }),
    expect.objectContaining({ id: 2, start: 1, end: 2, text: '세계' }),
  ]);
  expect(runNativeGeminiText).toHaveBeenCalledWith(expect.objectContaining({
    task: 'translate',
    model: 'gemini-3.5-flash-lite',
    responseJsonSchema: expect.objectContaining({ type: 'array' }),
    signal: expect.any(AbortSignal),
  }));
  expect(localStorage.getItem('original_subtitles_map')).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('native translation retries a structurally short response through Rust only', async () => {
  runNativeGeminiText
    .mockResolvedValueOnce({
      text: JSON.stringify([{ original: 'One', translated: '하나' }]),
    })
    .mockResolvedValueOnce({
      text: JSON.stringify([
        { original: 'One', translated: '하나' },
        { original: 'Two', translated: '둘' },
      ]),
    });

  await expect(translateSubtitles([
    { id: 1, start: 0, end: 1, text: 'One' },
    { id: 2, start: 1, end: 2, text: 'Two' },
  ], 'Korean', 'gemini-3.5-flash-lite')).resolves.toHaveLength(2);

  expect(runNativeGeminiText).toHaveBeenCalledTimes(2);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('chunked translation reuses the explicit native translator without a module cycle', async () => {
  runNativeGeminiText
    .mockResolvedValueOnce({
      text: JSON.stringify([{ original: 'One', translated: '하나' }]),
    })
    .mockResolvedValueOnce({
      text: JSON.stringify([{ original: 'Two', translated: '둘' }]),
    });

  await expect(translateSubtitles([
    { id: 1, start: 0, end: 1, text: 'One' },
    { id: 2, start: 70, end: 71, text: 'Two' },
  ], 'Korean', 'gemini-3.5-flash-lite', null, 1)).resolves.toEqual([
    expect.objectContaining({ id: 1, text: '하나' }),
    expect.objectContaining({ id: 2, text: '둘' }),
  ]);

  expect(runNativeGeminiText).toHaveBeenCalledTimes(2);
  expect(localStorage.getItem('original_subtitles_map')).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('browser compatibility replaces the full map while recursive chunks preserve it', async () => {
  runtimeMocks.isDesktopRuntime.mockReturnValue(false);
  localStorage.setItem('original_subtitles_map', JSON.stringify({
    1: { id: 1, start: 90, end: 91, text: 'Stale project' },
  }));
  runNativeGeminiText
    .mockResolvedValueOnce({
      text: JSON.stringify([{ original: 'One', translated: '하나' }]),
    })
    .mockResolvedValueOnce({
      text: JSON.stringify([{ original: 'Two', translated: '둘' }]),
    });

  await translateSubtitles([
    { id: 1, start: 0, end: 1, text: 'One' },
    { id: 2, start: 70, end: 71, text: 'Two' },
  ], 'Korean', 'gemini-3.5-flash-lite', null, 1);

  expect(JSON.parse(localStorage.getItem('original_subtitles_map'))).toEqual({
    1: { id: 1, start: 0, end: 1, text: 'One', index: 0 },
    2: { id: 2, start: 70, end: 71, text: 'Two', index: 1 },
  });
});

test('native cancellation preserves the established translation error contract', async () => {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  runNativeGeminiText.mockRejectedValue(error);

  await expect(translateSubtitles([
    { id: 1, start: 0, end: 1, text: 'One' },
  ], 'Korean', 'gemini-3.5-flash-lite')).rejects.toThrow('Translation request was aborted');
  expect(global.fetch).not.toHaveBeenCalled();
});
