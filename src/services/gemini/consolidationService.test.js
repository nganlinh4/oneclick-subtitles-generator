import {
  completeDocument,
  completeDocumentWithResult,
} from './consolidationService';
import {
  createCompleteDocumentResult,
  createIncompleteDocumentResult,
  runGeminiDocumentRequestResult,
} from './documentRequest';

vi.mock('./documentRequest', async (importOriginal) => ({
  ...(await importOriginal()),
  runGeminiDocumentRequestResult: vi.fn(),
}));

const words = (count) => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');

const completed = (text, acknowledge = vi.fn()) => createCompleteDocumentResult({
  text,
  deliveries: [{
    jobId: `job-${text}`,
    deliveryId: `delivery-${text}`,
    acknowledge,
  }],
});

beforeEach(() => {
  runGeminiDocumentRequestResult.mockReset();
});

test('a failed second chunk produces a retryable partial result without synthetic document text', async () => {
  const firstAck = vi.fn();
  const thirdAck = vi.fn();
  runGeminiDocumentRequestResult
    .mockResolvedValueOnce(completed('first complete chunk', firstAck))
    .mockRejectedValueOnce(Object.assign(new Error('provider failed'), { code: 'nativeGeminiFailed' }))
    .mockResolvedValueOnce(completed('third complete chunk', thirdAck));

  const result = await completeDocumentWithResult(words(301), 'model', null, 1);

  expect(result).toMatchObject({
    status: 'partial',
    code: 'documentChunksIncomplete',
    text: null,
    retryable: true,
    failedChunkIds: [2],
    completedChunks: [
      { chunkId: 1, text: 'first complete chunk' },
      { chunkId: 3, text: 'third complete chunk' },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('Processing failed');
  expect(result.deliveries).toHaveLength(2);
  expect(firstAck).not.toHaveBeenCalled();
  expect(thirdAck).not.toHaveBeenCalled();
});

test('all successful chunks produce one complete document in source order', async () => {
  const firstAck = vi.fn();
  const secondAck = vi.fn();
  runGeminiDocumentRequestResult
    .mockResolvedValueOnce(completed('first', firstAck))
    .mockResolvedValueOnce(completed('second', secondAck));

  const result = await completeDocumentWithResult(words(151), 'model', null, 1);

  expect(result).toMatchObject({
    status: 'complete',
    text: 'first\n\nsecond',
    retryable: false,
    failedChunkIds: [],
  });
  expect(result.completedChunks).toEqual([
    { chunkId: 1, text: 'first' },
    { chunkId: 2, text: 'second' },
  ]);
  expect(result.deliveries).toHaveLength(2);
  expect(firstAck).not.toHaveBeenCalled();
  expect(secondAck).not.toHaveBeenCalled();
});

test('only invalid empty chunk results produce a refused result with every failed chunk id', async () => {
  const firstAck = vi.fn();
  const secondAck = vi.fn();
  runGeminiDocumentRequestResult
    .mockResolvedValueOnce(createIncompleteDocumentResult({
      status: 'refused',
      code: 'emptyDocumentResult',
      failures: [{ chunkId: 1, code: 'emptyDocumentResult' }],
      deliveries: [{ jobId: 'job-1', deliveryId: 'delivery-1', acknowledge: firstAck }],
    }))
    .mockResolvedValueOnce(createIncompleteDocumentResult({
      status: 'refused',
      code: 'emptyDocumentResult',
      failures: [{ chunkId: 1, code: 'emptyDocumentResult' }],
      deliveries: [{ jobId: 'job-2', deliveryId: 'delivery-2', acknowledge: secondAck }],
    }));

  const result = await completeDocumentWithResult(words(151), 'model', null, 1);

  expect(result).toMatchObject({
    status: 'refused',
    code: 'documentNoValidOutput',
    text: null,
    retryable: true,
    failedChunkIds: [1, 2],
    completedChunks: [],
  });
  expect(result.deliveries).toHaveLength(2);
  expect(firstAck).not.toHaveBeenCalled();
  expect(secondAck).not.toHaveBeenCalled();
});

test('the string compatibility facade rejects partial output instead of returning a fake document', async () => {
  runGeminiDocumentRequestResult
    .mockResolvedValueOnce(completed('first'))
    .mockRejectedValueOnce(new Error('second chunk failed'));

  await expect(completeDocument(words(151), 'model', null, 1)).rejects.toMatchObject({
    name: 'DocumentProcessingError',
    code: 'documentChunksIncomplete',
    documentResult: expect.objectContaining({
      status: 'partial',
      failedChunkIds: [2],
    }),
  });
});
