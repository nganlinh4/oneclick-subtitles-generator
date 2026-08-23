import {
  runGeminiDocumentRequest,
  runGeminiDocumentRequestResult,
} from './documentRequest';
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

test('typed document processing preserves the exact native delivery without acknowledging it', async () => {
  const acknowledge = vi.fn();
  runNativeGeminiText.mockResolvedValue({
    text: 'A durable native response',
    job: { id: 'job-1' },
    deliveryId: 'delivery-1',
    acknowledge,
  });

  const result = await runGeminiDocumentRequestResult(options);

  expect(result).toMatchObject({
    status: 'complete',
    text: 'A durable native response',
    failedChunkIds: [],
    deliveries: [{ jobId: 'job-1', deliveryId: 'delivery-1' }],
  });
  expect(result.deliveries[0].acknowledge).toBe(acknowledge);
  expect(acknowledge).not.toHaveBeenCalled();
});

test('typed document processing refuses empty provider output and retains its delivery', async () => {
  const acknowledge = vi.fn();
  runNativeGeminiText.mockResolvedValue({
    text: '   ',
    job: { id: 'job-empty' },
    deliveryId: 'delivery-empty',
    acknowledge,
  });

  const result = await runGeminiDocumentRequestResult(options);

  expect(result).toMatchObject({
    status: 'refused',
    code: 'emptyDocumentResult',
    text: null,
    retryable: true,
    failedChunkIds: [1],
    deliveries: [{ jobId: 'job-empty', deliveryId: 'delivery-empty' }],
  });
  expect(acknowledge).not.toHaveBeenCalled();
});

test('typed document processing refuses structurally empty output selected by its owner', async () => {
  const acknowledge = vi.fn();
  runNativeGeminiText.mockResolvedValue({
    text: JSON.stringify({ title: '', content: '' }),
    job: { id: 'job-empty-structured' },
    deliveryId: 'delivery-empty-structured',
    acknowledge,
  });

  const result = await runGeminiDocumentRequestResult({
    ...options,
    validateProcessedText: ({ structured }) => (
      typeof structured?.content === 'string' && structured.content.trim().length > 0
    ),
  });

  expect(result).toMatchObject({
    status: 'refused',
    code: 'emptyDocumentResult',
    failedChunkIds: [1],
  });
  expect(result.deliveries[0].acknowledge).toBe(acknowledge);
  expect(acknowledge).not.toHaveBeenCalled();
});

test('native cancellation keeps the caller-specific abort message', async () => {
  const error = new Error('cancelled');
  error.name = 'AbortError';
  runNativeGeminiText.mockRejectedValue(error);

  await expect(runGeminiDocumentRequest(options))
    .rejects.toThrow('Summary request was aborted');
  expect(global.fetch).not.toHaveBeenCalled();
});
