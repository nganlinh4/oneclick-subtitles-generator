// Durable translation commits: receipts, native delivery acknowledgement and partial results.
import { act, waitFor } from '@testing-library/react';
import { PartialTranslationError } from '../services/gemini/translationChunkProcessor';
import { useTranslationState } from './useTranslationState';
import {
  deferred,
  issueReceipt,
  mocks,
  mountTranslationState,
  resetTranslationStateMocks,
  sourceB,
  startTranslation,
  translationResult,
} from './useTranslationStateTestFixtures';

vi.mock('react-i18next', async () => (
  (await import('./useTranslationStateTestFixtures')).reactI18nextMock()
));
vi.mock('../services/geminiService', async () => (
  (await import('./useTranslationStateTestFixtures')).geminiServiceMock()
));
vi.mock('../services/lifecycleOrchestrator', async () => (
  (await import('./useTranslationStateTestFixtures')).lifecycleOrchestratorMock()
));
vi.mock('../platform/translationPersistence', async () => (
  (await import('./useTranslationStateTestFixtures')).translationPersistenceMock()
));
vi.mock('../utils/userSubtitlesStore', async () => (
  (await import('./useTranslationStateTestFixtures')).userSubtitlesStoreMock()
));
vi.mock('../utils/transcriptionRulesStore', async () => (
  (await import('./useTranslationStateTestFixtures')).transcriptionRulesStoreMock()
));
vi.mock('./useTranslationBulk', async () => (
  (await import('./useTranslationStateTestFixtures')).translationBulkMock()
));

beforeEach(resetTranslationStateMocks);

const mount = (initialRows) => mountTranslationState(useTranslationState, initialRows);
const start = startTranslation;

it('does not publish before a deferred durable acknowledgement and rejects a project switch', async () => {
  const view = await mount();
  const save = deferred();
  mocks.persist.mockImplementationOnce(async (_identity, terminal) => {
    await save.promise;
    const record = { ...terminal, revision: 1 };
    return issueReceipt(record);
  });
  const pending = start(view.result);
  await waitFor(() => expect(mocks.persist).toHaveBeenCalledTimes(1));
  expect(view.onComplete).not.toHaveBeenCalledWith(expect.any(Array));
  expect(view.result.current.translatedSubtitles).toBeNull();

  act(() => {
    mocks.activeCacheId = 'cache-b';
    mocks.cacheListener?.('cache-b', 'cache-a');
    view.rerender({ rows: sourceB });
  });
  save.resolve();
  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  expect(view.onComplete).not.toHaveBeenCalledWith(expect.any(Array));
  view.unmount();
});

it('unmounts after the provider response without publishing a deferred save receipt', async () => {
  const view = await mount();
  const save = deferred();
  mocks.persist.mockImplementationOnce(async (_identity, terminal) => {
    await save.promise;
    return issueReceipt({ ...terminal, revision: 1 });
  });
  const pending = start(view.result);
  await waitFor(() => expect(mocks.persist).toHaveBeenCalledTimes(1));

  view.unmount();
  save.resolve();
  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  expect(view.onComplete).not.toHaveBeenCalledWith(expect.any(Array));
});

it('fails closed on durable rejection or a cloned structural receipt', async () => {
  const first = await mount();
  mocks.persist.mockRejectedValueOnce(new Error('disk full'));
  await expect(start(first.result)).resolves.toMatchObject({ status: 'failed' });
  expect(first.onComplete).not.toHaveBeenCalledWith(expect.any(Array));
  first.unmount();

  mocks.hydratedRecord = null;
  const second = await mount();
  mocks.persist.mockImplementationOnce(async (_identity, terminal) => {
    const genuine = issueReceipt({ ...terminal, revision: 1 });
    return { ...genuine };
  });
  await expect(start(second.result)).resolves.toMatchObject({ status: 'failed' });
  expect(second.onComplete).not.toHaveBeenCalledWith(expect.any(Array));
  expect(second.result.current.translatedSubtitles).toBeNull();
  second.unmount();
});

it('acknowledges native deliveries only after the exact durable project/source receipt', async () => {
  const view = await mount();
  const save = deferred();
  const acknowledge = vi.fn(async () => {});
  mocks.translate.mockImplementationOnce(async (input) => translationResult(input, 'T:', [
    Object.freeze({ jobId: 'job-1', deliveryId: 'delivery-1', acknowledge }),
  ]));
  mocks.persist.mockImplementationOnce(async (_identity, terminal) => {
    await save.promise;
    return issueReceipt({ ...terminal, revision: 7 });
  });

  const pending = start(view.result);
  await waitFor(() => expect(mocks.persist).toHaveBeenCalledTimes(1));
  expect(acknowledge).not.toHaveBeenCalled();
  save.resolve();

  await expect(pending).resolves.toMatchObject({
    status: 'complete',
    pendingDeliveryCount: 0,
  });
  expect(mocks.assertReceipt).toHaveBeenLastCalledWith(
    expect.any(Object),
    expect.objectContaining({ cacheId: 'cache-a', projectId: 'project-a' }),
    expect.objectContaining({
      revision: 7,
      sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: 'complete',
    })
  );
  expect(acknowledge).toHaveBeenCalledTimes(1);
  view.unmount();
});

it('cannot clear a newer project result when an older request finally returns', async () => {
  const view = await mount();
  const provider = deferred();
  mocks.translate.mockReturnValueOnce(provider.promise);
  let oldRun;
  act(() => { oldRun = start(view.result); });
  await waitFor(() => expect(mocks.translate).toHaveBeenCalledTimes(1));

  act(() => {
    mocks.activeCacheId = 'cache-b';
    mocks.cacheListener?.('cache-b', 'cache-a');
    view.rerender({ rows: sourceB });
  });
  // Reset legitimately replaces the cancelled lease; a new translation then owns project B.
  await act(async () => {
    await expect(view.result.current.handleReset()).resolves.toMatchObject({ status: 'cleared' });
  });
  await act(async () => {
    await expect(start(view.result)).resolves.toMatchObject({ status: 'complete' });
  });
  const publishedB = view.result.current.translatedSubtitles;
  expect(publishedB).toEqual([expect.objectContaining({ text: 'T:Other' })]);
  view.onComplete.mockClear();

  await act(async () => {
    provider.resolve(translationResult(mocks.translate.mock.calls[0][0]));
    await expect(oldRun).resolves.toEqual({ status: 'cancelled' });
  });
  expect(view.result.current.translatedSubtitles).toEqual(publishedB);
  expect(view.onComplete).not.toHaveBeenCalled();
  expect(mocks.persist).toHaveBeenCalledTimes(1);
  view.unmount();
});

it('leaves every delivery pending when persistence or receipt validation refuses', async () => {
  const persistenceFailure = await mount();
  const firstAck = vi.fn(async () => {});
  mocks.translate.mockImplementationOnce(async (input) => translationResult(input, 'T:', [
    Object.freeze({ jobId: 'job-1', deliveryId: 'delivery-1', acknowledge: firstAck }),
  ]));
  mocks.persist.mockRejectedValueOnce(new Error('disk full'));
  await expect(start(persistenceFailure.result)).resolves.toMatchObject({ status: 'failed' });
  expect(firstAck).not.toHaveBeenCalled();
  persistenceFailure.unmount();

  mocks.hydratedRecord = null;
  const receiptFailure = await mount();
  const secondAck = vi.fn(async () => {});
  mocks.translate.mockImplementationOnce(async (input) => translationResult(input, 'T:', [
    Object.freeze({ jobId: 'job-2', deliveryId: 'delivery-2', acknowledge: secondAck }),
  ]));
  mocks.assertReceipt.mockImplementationOnce(() => {
    throw new Error('wrong project receipt');
  });
  await expect(start(receiptFailure.result)).resolves.toMatchObject({ status: 'failed' });
  expect(secondAck).not.toHaveBeenCalled();
  receiptFailure.unmount();
});

it('attempts all acknowledgements after persistence and reports failed acknowledgements as pending', async () => {
  const view = await mount();
  const failedAck = vi.fn(async () => { throw new Error('transport unavailable'); });
  const successfulAck = vi.fn(async () => {});
  mocks.translate.mockImplementationOnce(async (input) => translationResult(input, 'T:', [
    Object.freeze({ jobId: 'job-1', deliveryId: 'delivery-1', acknowledge: failedAck }),
    Object.freeze({ jobId: 'job-2', deliveryId: 'delivery-2', acknowledge: successfulAck }),
  ]));

  await expect(start(view.result)).resolves.toMatchObject({
    status: 'complete',
    pendingDeliveryCount: 1,
  });
  expect(failedAck).toHaveBeenCalledTimes(1);
  expect(successfulAck).toHaveBeenCalledTimes(1);
  expect(view.onComplete).toHaveBeenCalledWith(expect.any(Array));
  view.unmount();
});

it('publishes successful chunks from a partial result and can durably fill the missing rows', async () => {
  const view = await mount();
  const acknowledge = vi.fn(async () => {});
  const completed = [{
    id: 'a-1',
    start: 0,
    end: 1,
    text: 'T:Hello',
    originalId: 'string:a-1',
    sourceOrder: 0,
    language: 'en',
  }];
  const partialError = new PartialTranslationError(completed, [{
    chunkIndex: 1,
    startOrder: 1,
    endOrder: 1,
    errorCode: 'providerFailed',
  }]);
  partialError.result = Object.freeze({
    status: 'partial',
    rows: partialError.completedSubtitles,
    deliveries: Object.freeze([Object.freeze({
      jobId: 'job-partial',
      deliveryId: 'delivery-partial',
      acknowledge,
    })]),
  });
  mocks.translate.mockRejectedValueOnce(partialError);

  let partialOutcome;
  await act(async () => {
    partialOutcome = await start(view.result);
  });
  expect(partialOutcome).toMatchObject({ status: 'partial' });
  expect(mocks.persist).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: 'project-a' }),
    expect.objectContaining({
      status: 'partial',
      sourceEntryCount: 2,
      baseSubtitles: completed,
      failedChunks: [expect.objectContaining({ chunkIndex: 1 })],
})
  );
  expect(view.onComplete).not.toHaveBeenCalledWith(expect.any(Array));
  expect(view.result.current.translatedSubtitles).toEqual([
    completed[0],
    expect.objectContaining({
      id: 'a-2',
      originalId: 'string:a-2',
      sourceOrder: 1,
      text: 'World',
      translationFailed: true,
      translationErrorCode: 'providerFailed',
    }),
  ]);
  expect(acknowledge).toHaveBeenCalledTimes(1);

  mocks.translate.mockImplementationOnce(async (input) => translationResult(input, 'R:'));
  let retryOutcome;
  await act(async () => {
    retryOutcome = await view.result.current.retryMainTranslation({ originalId: 'string:a-2' });
  });
  expect(retryOutcome).toMatchObject({ status: 'complete' });
  expect(mocks.hydratedRecord).toMatchObject({
    status: 'complete',
    failedChunks: [],
    baseSubtitles: [
      completed[0],
      expect.objectContaining({ originalId: 'string:a-2', text: 'R:World' }),
    ],
  });
  expect(view.result.current.translatedSubtitles).toEqual(mocks.hydratedRecord.baseSubtitles);
  expect(view.onComplete).toHaveBeenLastCalledWith(mocks.hydratedRecord.baseSubtitles);
  view.unmount();
});
