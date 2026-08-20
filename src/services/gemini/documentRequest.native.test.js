import { runGeminiDocumentRequest } from './documentRequest';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';

vi.mock('../../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktopRuntime: () => true,
}));
vi.mock('../../platform/nativeGeminiText', () => ({
  runNativeGeminiText: vi.fn(),
}));

const options = {
  subtitlesText: 'A subtitle transcript',
  model: 'gemini-3.5-flash-lite',
  customPrompt: null,
  getDefaultPrompt: (text) => `Summarize: ${text}`,
  createSchema: () => ({
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string' },
    },
  }),
  errorLabel: 'Summary error:',
  abortMessage: 'Summary request was aborted',
};

beforeEach(() => {
  localStorage.clear();
  runNativeGeminiText.mockReset();
  global.fetch = vi.fn(() => {
    throw new Error('native document requests must not use browser fetch');
  });
});

afterAll(() => {
  delete global.fetch;
});

test('native document processing preserves structured title and content', async () => {
  runNativeGeminiText.mockResolvedValue({
    text: JSON.stringify({ title: 'Native title', content: 'Native content' }),
  });

  await expect(runGeminiDocumentRequest(options))
    .resolves.toBe('Native title\n\nNative content');
  expect(runNativeGeminiText).toHaveBeenCalledWith(expect.objectContaining({
    task: 'analyzeSubtitles',
    model: 'gemini-3.5-flash-lite',
    prompt: 'Summarize: A subtitle transcript',
    responseJsonSchema: expect.objectContaining({ type: 'object' }),
    signal: expect.any(AbortSignal),
  }));
  expect(global.fetch).not.toHaveBeenCalled();
});

test('native document processing keeps plain-text fallback semantics', async () => {
  runNativeGeminiText.mockResolvedValue({ text: 'A plain native response' });

  await expect(runGeminiDocumentRequest(options)).resolves.toBe('A plain native response');
  expect(global.fetch).not.toHaveBeenCalled();
});

test('native cancellation keeps the caller-specific abort message', async () => {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  runNativeGeminiText.mockRejectedValue(error);

  await expect(runGeminiDocumentRequest(options))
    .rejects.toThrow('Summary request was aborted');
  expect(global.fetch).not.toHaveBeenCalled();
});
