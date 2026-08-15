import { handleRetrySegment } from './retryHandlers';

it('delegates main retries with their exact original IDs', async () => {
  const retryMainTranslation = vi.fn().mockResolvedValue({ status: 'complete' });
  const segment = { fileId: 'main', originalIds: ['string:a', 'string:b'] };

  await expect(handleRetrySegment(segment, { retryMainTranslation }))
    .resolves.toEqual({ status: 'complete' });
  expect(retryMainTranslation).toHaveBeenCalledWith(segment);
});

it('makes non-durable bulk retry an explicit no-op instead of mutating by array index', async () => {
  const retryMainTranslation = vi.fn();

  await expect(handleRetrySegment({
    fileId: 'bulk-0',
    isFromBulk: true,
    startIndex: 0,
    originalId: 'number:1',
  }, { retryMainTranslation })).resolves.toEqual({
    status: 'unsupported',
    code: 'bulkRetryRequiresDurableRevision',
  });
  expect(retryMainTranslation).not.toHaveBeenCalled();
});
