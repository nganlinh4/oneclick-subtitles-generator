import { saveCompleteDocumentResult } from './documentProcessingResult';

test.each(['partial', 'refused'])(
  'a %s document result never reaches normal save or success notification',
  async (status) => {
    const save = vi.fn();
    const notifySaved = vi.fn();
    const result = Object.freeze({
      status,
      text: null,
      retryable: true,
      failedChunkIds: [2],
      deliveries: Object.freeze([{ acknowledge: vi.fn() }]),
    });

    await expect(saveCompleteDocumentResult({
      result,
      filename: 'document.txt',
      save,
      notifySaved,
    })).resolves.toBe(result);
    expect(save).not.toHaveBeenCalled();
    expect(notifySaved).not.toHaveBeenCalled();
    expect(result.deliveries[0].acknowledge).not.toHaveBeenCalled();
  },
);

test('a complete result is saved and reported only after the save receipt succeeds', async () => {
  const save = vi.fn().mockResolvedValue({ status: 'saved', path: 'document.txt' });
  const notifySaved = vi.fn();
  const acknowledge = vi.fn();
  const result = Object.freeze({
    status: 'complete',
    text: 'finished document',
    retryable: false,
    failedChunkIds: Object.freeze([]),
    deliveries: Object.freeze([{ acknowledge }]),
  });

  await expect(saveCompleteDocumentResult({
    result,
    filename: 'document.txt',
    save,
    notifySaved,
  })).resolves.toMatchObject({
    status: 'saved',
    path: 'document.txt',
    documentResult: result,
  });
  expect(save).toHaveBeenCalledExactlyOnceWith('finished document', 'document.txt');
  expect(notifySaved).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledTimes(1);
});

test('a delivery acknowledgement failure retains the durable result and suppresses success', async () => {
  const save = vi.fn().mockResolvedValue({ status: 'saved', path: 'document.txt' });
  const notifySaved = vi.fn();
  const acknowledge = vi.fn().mockRejectedValue(new Error('ack transport unavailable'));

  await expect(saveCompleteDocumentResult({
    result: {
      status: 'complete',
      text: 'finished document',
      deliveries: [{ acknowledge }],
    },
    filename: 'document.txt',
    save,
    notifySaved,
  })).rejects.toThrow('ack transport unavailable');

  expect(save).toHaveBeenCalledTimes(1);
  expect(acknowledge).toHaveBeenCalledTimes(1);
  expect(notifySaved).not.toHaveBeenCalled();
});

test('a cancelled save never reports document success', async () => {
  const save = vi.fn().mockResolvedValue({ status: 'cancelled' });
  const notifySaved = vi.fn();

  await expect(saveCompleteDocumentResult({
    result: { status: 'complete', text: 'finished document' },
    filename: 'document.txt',
    save,
    notifySaved,
  })).resolves.toMatchObject({ status: 'cancelled' });
  expect(notifySaved).not.toHaveBeenCalled();
});
