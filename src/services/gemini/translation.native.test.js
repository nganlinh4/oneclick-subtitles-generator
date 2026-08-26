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

const providerText = (subtitles, languageRows = { Korean: [] }) => JSON.stringify({
  schemaVersion: 1,
  translations: Object.entries(languageRows).map(([languageId, translated]) => ({
    languageId,
    rows: subtitles.map((subtitle, index) => ({
      sourceId: subtitle.originalId
        ?? (subtitle.id === undefined ? `ordinal:${index}` : `${typeof subtitle.id}:${subtitle.id}`),
      original: subtitle.text,
      translated: translated[index],
    })),
  })),
});

test('native translation uses the Rust task and preserves subtitle timing', async () => {
  localStorage.setItem('original_subtitles_map', JSON.stringify({
    1: { id: 1, start: 90, end: 91, text: 'Stale project' },
  }));
  const subtitles = [
    { id: 1, start: 0, end: 1, text: 'Hello' },
    { id: 2, start: 1, end: 2, text: 'World' },
  ];
  runNativeGeminiText.mockResolvedValue({
    text: providerText(subtitles, { Korean: ['안녕하세요', '세계'] }),
    usage: null,
  });

  const translated = await translateSubtitles(
    subtitles,
    'Korean',
    'gemini-3.5-flash-lite'
  );

  expect(translated).toMatchObject({ status: 'complete', deliveries: [] });
  expect(translated.rows).toEqual([
    expect.objectContaining({ id: 1, start: 0, end: 1, text: '안녕하세요' }),
    expect.objectContaining({ id: 2, start: 1, end: 2, text: '세계' }),
  ]);
  expect(runNativeGeminiText).toHaveBeenCalledWith(expect.objectContaining({
    task: 'translate',
    model: 'gemini-3.5-flash-lite',
    responseJsonSchema: expect.objectContaining({
      type: 'object',
      properties: expect.objectContaining({ translations: expect.any(Object) }),
    }),
    signal: expect.any(AbortSignal),
  }));
  expect(localStorage.getItem('original_subtitles_map')).toBeNull();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('native translation retries a structurally short response through Rust only', async () => {
  const subtitles = [
    { id: 1, start: 0, end: 1, text: 'One' },
    { id: 2, start: 1, end: 2, text: 'Two' },
  ];
  runNativeGeminiText
    .mockResolvedValueOnce({
      text: JSON.stringify({
        schemaVersion: 1,
        translations: [{
          languageId: 'Korean',
          rows: [{ sourceId: 'number:1', original: 'One', translated: '하나' }],
        }],
      }),
    })
    .mockResolvedValueOnce({
      text: providerText(subtitles, { Korean: ['하나', '둘'] }),
    });

  await expect(translateSubtitles(
    subtitles,
    'Korean',
    'gemini-3.5-flash-lite'
  )).resolves.toMatchObject({ rows: expect.arrayContaining([expect.any(Object)]) });

  expect(runNativeGeminiText).toHaveBeenCalledTimes(2);
  expect(global.fetch).not.toHaveBeenCalled();
});

test('preserves every native delivery across invalid-response retries without acknowledging it', async () => {
  const subtitles = [
    { id: 1, start: 0, end: 1, text: 'One' },
    { id: 2, start: 1, end: 2, text: 'Two' },
  ];
  const firstAck = vi.fn(async () => {});
  const secondAck = vi.fn(async () => {});
  runNativeGeminiText
    .mockResolvedValueOnce({
      text: JSON.stringify({ schemaVersion: 1, translations: [] }),
      job: { id: 'job-1' },
      deliveryId: 'delivery-1',
      acknowledge: firstAck,
    })
    .mockResolvedValueOnce({
      text: providerText(subtitles, { Korean: ['하나', '둘'] }),
      job: { id: 'job-2' },
      deliveryId: 'delivery-2',
      acknowledge: secondAck,
    });

  const outcome = await translateSubtitles(
    subtitles,
    'Korean',
    'gemini-3.5-flash-lite'
  );

  expect(outcome.deliveries).toEqual([
    expect.objectContaining({ jobId: 'job-1', deliveryId: 'delivery-1', acknowledge: firstAck }),
    expect.objectContaining({ jobId: 'job-2', deliveryId: 'delivery-2', acknowledge: secondAck }),
  ]);
  expect(firstAck).not.toHaveBeenCalled();
  expect(secondAck).not.toHaveBeenCalled();
});

test('chunked translation reuses the explicit native translator without a module cycle', async () => {
  const subtitles = [
    { id: 1, start: 0, end: 1, text: 'One' },
    { id: 2, start: 70, end: 71, text: 'Two' },
  ];
  const firstAck = vi.fn(async () => {});
  const secondAck = vi.fn(async () => {});
  runNativeGeminiText
    .mockResolvedValueOnce({
      text: providerText([subtitles[0]], { Korean: ['하나'] }),
      job: { id: 'job-1' },
      deliveryId: 'delivery-1',
      acknowledge: firstAck,
    })
    .mockResolvedValueOnce({
      text: providerText([subtitles[1]], { Korean: ['둘'] }),
      job: { id: 'job-2' },
      deliveryId: 'delivery-2',
      acknowledge: secondAck,
    });

  const outcome = await translateSubtitles(
    subtitles,
    'Korean',
    'gemini-3.5-flash-lite',
    null,
    1
  );
  expect(outcome).toMatchObject({
    rows: [
      expect.objectContaining({ id: 1, text: '하나' }),
      expect.objectContaining({ id: 2, text: '둘' }),
    ],
  });
  expect(outcome.deliveries).toEqual([
    expect.objectContaining({ acknowledge: firstAck }),
    expect.objectContaining({ acknowledge: secondAck }),
  ]);

  expect(runNativeGeminiText).toHaveBeenCalledTimes(2);
  expect(firstAck).not.toHaveBeenCalled();
  expect(secondAck).not.toHaveBeenCalled();
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
      text: providerText([{ id: 1, start: 0, end: 1, text: 'One' }], { Korean: ['하나'] }),
    })
    .mockResolvedValueOnce({
      text: providerText([{ id: 2, start: 70, end: 71, text: 'Two' }], { Korean: ['둘'] }),
    });

  await translateSubtitles([
    { id: 1, start: 0, end: 1, text: 'One' },
    { id: 2, start: 70, end: 71, text: 'Two' },
  ], 'Korean', 'gemini-3.5-flash-lite', null, 1);

  expect(JSON.parse(localStorage.getItem('original_subtitles_map'))).toEqual({
    1: {
      id: 1,
      start: 0,
      end: 1,
      text: 'One',
      originalId: 'number:1',
      sourceOrder: 0,
      index: 0,
    },
    2: {
      id: 2,
      start: 70,
      end: 71,
      text: 'Two',
      originalId: 'number:2',
      sourceOrder: 1,
      index: 1,
    },
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

test('format-only mode refuses to substitute a requested-language label for provider text', async () => {
  await expect(translateSubtitles(
    [{ id: 1, start: 0, end: 1, text: 'One' }],
    [],
    'gemini-3.5-flash-lite',
    null,
    0,
    false,
    ' ',
    false,
    null,
    [
      { id: 1, type: 'language', value: 'Original', isOriginal: true },
      { id: 2, type: 'delimiter', value: ' / ' },
      { id: 3, type: 'language', value: 'Korean', isOriginal: false },
    ]
  )).rejects.toThrow('cannot fabricate');
  expect(runNativeGeminiText).not.toHaveBeenCalled();
});

test('format-only mode ignores the editor blank target placeholder', async () => {
  const outcome = await translateSubtitles(
    [{ id: 1, start: 0, end: 1, text: 'One' }],
    [],
    'gemini-3.5-flash-lite',
    null,
    0,
    false,
    ' ',
    false,
    null,
    [
      { id: 1, type: 'language', value: '', isOriginal: false },
      { id: 2, type: 'delimiter', value: 'FMT: ', style: { open: '', close: '' } },
      { id: 3, type: 'language', value: 'Original', isOriginal: true },
    ]
  );

  expect(outcome).toMatchObject({
    status: 'complete',
    rows: [expect.objectContaining({ text: 'FMT: One' })],
  });
  expect(runNativeGeminiText).not.toHaveBeenCalled();
});

test.each([
  [['Korean', 'korean'], 'unique'],
  [[' Korean'], 'non-blank'],
])('refuses ambiguous requested language IDs before provider work', async (languages, message) => {
  await expect(translateSubtitles(
    [{ id: 1, start: 0, end: 1, text: 'One' }],
    languages,
    'gemini-3.5-flash-lite'
  )).rejects.toThrow(message);
  expect(runNativeGeminiText).not.toHaveBeenCalled();
});

test('an owned signal wins when the native provider settles after ignoring abort', async () => {
  let resolveProvider;
  runNativeGeminiText.mockImplementationOnce(() => new Promise((resolve) => {
    resolveProvider = resolve;
  }));
  const controller = new AbortController();
  const pending = translateSubtitles(
    [{ id: 1, originalId: 'number:1', sourceOrder: 0, start: 0, end: 1, text: 'One' }],
    'Korean',
    'gemini-3.5-flash-lite',
    null,
    0,
    false,
    ' ',
    false,
    null,
    null,
    'main',
    false,
    { signal: controller.signal, assertOwned: vi.fn(async () => {}) }
  );
  await vi.waitFor(() => expect(runNativeGeminiText).toHaveBeenCalledTimes(1));
  controller.abort();
  resolveProvider({
    text: providerText([
      { originalId: 'number:1', start: 0, end: 1, text: 'One' },
    ], { Korean: ['하나'] }),
  });

  await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'translationAborted' });
});
