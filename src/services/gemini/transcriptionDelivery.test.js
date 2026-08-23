import {
  acknowledgeGeminiTranscriptionDeliveries,
  bindGeminiTranscriptionDeliveries,
  bindNativeGeminiTranscriptionDelivery,
  getGeminiTranscriptionDeliveries,
  listPendingGeminiTranscriptionDeliveries,
  retryPendingGeminiTranscriptionDeliveries,
} from './transcriptionDelivery';

vi.mock('../subtitleCache', () => ({
  isDurableSubtitleCheckpointReceipt: vi.fn((receipt, context) => (
    receipt?.kind === 'durable-subtitle-checkpoint' && receipt.runId === context.runId
  )),
  isSuccessfulSubtitleCacheSaveReceipt: vi.fn((receipt) => receipt?.success === true),
}));

const context = Object.freeze({
  runId: 'run-a',
  cacheId: 'cache-a',
  projectId: 'project-a',
});
const receipt = Object.freeze({
  kind: 'durable-subtitle-checkpoint',
  runId: 'run-a',
  cacheId: 'cache-a',
  projectId: 'project-a',
  subtitleCount: 1,
});
const nativeResult = (suffix, acknowledge = vi.fn().mockResolvedValue(undefined)) => ({
  job: { id: `job-${suffix}` },
  deliveryId: `delivery-${suffix}`,
  acknowledge,
});

it('keeps native delivery capabilities beside rows without serializing them into subtitles', () => {
  const rows = [{ start: 0, end: 1, text: 'Hello' }];
  bindNativeGeminiTranscriptionDelivery(rows, nativeResult('a'));

  expect(getGeminiTranscriptionDeliveries(rows)).toEqual([
    expect.objectContaining({ jobId: 'job-a', deliveryId: 'delivery-a' }),
  ]);
  expect(JSON.stringify(rows)).toBe('[{"start":0,"end":1,"text":"Hello"}]');
  expect(Object.keys(rows[0])).toEqual(['start', 'end', 'text']);
});

it('preserves multiple segment deliveries and acknowledges only after validation', async () => {
  const order = [];
  const first = [{ start: 0, end: 1, text: 'One' }];
  const second = [{ start: 1, end: 2, text: 'Two' }];
  bindNativeGeminiTranscriptionDelivery(first, nativeResult('one', async () => order.push('ack-one')));
  bindNativeGeminiTranscriptionDelivery(second, nativeResult('two', async () => order.push('ack-two')));
  const merged = bindGeminiTranscriptionDeliveries(
    [{ start: 0, end: 2, text: 'Merged' }],
    first,
    second,
  );
  const validateOwnership = vi.fn(async () => order.push('validate'));

  await expect(acknowledgeGeminiTranscriptionDeliveries({
    rows: merged,
    receipt,
    context,
    validateOwnership,
  })).resolves.toEqual({ acknowledged: true, pending: [] });

  expect(order).toEqual(['validate', 'ack-one', 'validate', 'ack-two']);
});

it('does not acknowledge on a forged or mismatched checkpoint', async () => {
  const acknowledge = vi.fn();
  const rows = bindNativeGeminiTranscriptionDelivery(
    [{ start: 0, end: 1, text: 'Hello' }],
    nativeResult('forged', acknowledge),
  );

  await expect(acknowledgeGeminiTranscriptionDeliveries({
    rows,
    receipt: { ...receipt, runId: 'wrong' },
    context,
    validateOwnership: vi.fn(),
  })).rejects.toThrow('exact checkpoint');
  expect(acknowledge).not.toHaveBeenCalled();
});

it('retains an exact acknowledgement after response loss and retries without provider work', async () => {
  const acknowledge = vi.fn()
    .mockRejectedValueOnce(new Error('response lost'))
    .mockResolvedValueOnce(undefined);
  const rows = bindNativeGeminiTranscriptionDelivery(
    [{ start: 0, end: 1, text: 'Hello' }],
    nativeResult('pending', acknowledge),
  );
  const validateOwnership = vi.fn().mockResolvedValue(undefined);

  await expect(acknowledgeGeminiTranscriptionDeliveries({
    rows,
    receipt,
    context,
    validateOwnership,
  })).resolves.toMatchObject({ acknowledged: false });
  expect(listPendingGeminiTranscriptionDeliveries()).toContainEqual(expect.objectContaining({
    jobId: 'job-pending',
    deliveryId: 'delivery-pending',
  }));

  await expect(retryPendingGeminiTranscriptionDeliveries({
    cacheId: context.cacheId,
    projectId: context.projectId,
    validateOwnership,
  })).resolves.toEqual({ acknowledged: true, pending: [] });
  expect(acknowledge).toHaveBeenCalledTimes(2);
});
