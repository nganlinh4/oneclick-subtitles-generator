// Translation hydration, retry by original ID, and Stop/unmount before provider registration.
import { act, renderHook, waitFor } from '@testing-library/react';
import { fingerprintTranslationSource } from '../utils/translationOwnership';
import { useTranslationState } from './useTranslationState';
import {
  completeRecord,
  deferred,
  issueReceipt,
  mocks,
  mountTranslationState,
  resetTranslationStateMocks,
  sourceA,
  sourceB,
  startTranslation,
  translatedRows,
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

it('drops a deferred A hydration after switching to B, then isolates exact restart hydration', async () => {
  const hydration = deferred();
  const rows = translatedRows([
    { id: 'a-1', originalId: 'string:a-1', sourceOrder: 0, start: 0, end: 1, text: 'Hello' },
    { id: 'a-2', originalId: 'string:a-2', sourceOrder: 1, start: 1, end: 2, text: 'World' },
  ]);
  mocks.read.mockReturnValueOnce(hydration.promise);
  const onComplete = vi.fn();
  const view = renderHook(
    ({ sourceRows }) => useTranslationState(sourceRows, onComplete),
    { initialProps: { sourceRows: sourceA } }
  );
  await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
  act(() => {
    mocks.activeCacheId = 'cache-b';
    mocks.cacheListener?.('cache-b', 'cache-a');
    view.rerender({ sourceRows: sourceB });
  });
  const fingerprint = await fingerprintTranslationSource(sourceA);
  hydration.resolve(completeRecord(rows, 1, fingerprint));
  await act(async () => { await Promise.resolve(); });
  expect(onComplete).not.toHaveBeenCalledWith(rows);
  expect(view.result.current.translatedSubtitles).toBeNull();
  view.unmount();

  mocks.activeCacheId = 'cache-a';
  mocks.hydratedRecord = completeRecord(rows, 1, fingerprint);
  mocks.read.mockImplementation(async () => mocks.hydratedRecord);
  const restarted = renderHook(() => useTranslationState(sourceA, onComplete));
  await waitFor(() => expect(onComplete).toHaveBeenCalledWith(expect.any(Array)));
  expect(restarted.result.current.translatedSubtitles).toEqual(rows);
  restarted.unmount();
});

it('retries by original ID and publishes only after revision commit', async () => {
  const sourceRows = [
    { id: 'a-1', originalId: 'string:a-1', sourceOrder: 0, start: 0, end: 1, text: 'T:Hello', language: 'en' },
    { id: 'a-2', originalId: 'string:a-2', sourceOrder: 1, start: 1, end: 2, text: 'T:World', language: 'en' },
  ];
  mocks.hydratedRecord = completeRecord(
    sourceRows,
    1,
    await fingerprintTranslationSource(sourceA)
  );
  const view = await mount();
  await waitFor(() => expect(view.result.current.translatedSubtitles).toEqual(sourceRows));
  view.onComplete.mockClear();
  mocks.translate.mockImplementationOnce(async (input) => translationResult(input, 'R:'));

  const outcome = await view.result.current.retryMainTranslation({
    originalId: 'string:a-2',
    startIndex: 0,
    endIndex: 0,
  });

  expect(outcome).toMatchObject({ status: 'complete' });
  expect(mocks.translate.mock.calls[0][0]).toHaveLength(1);
  expect(mocks.translate.mock.calls[0][0][0]).toMatchObject({ originalId: 'string:a-2' });
  expect(mocks.commitRevision).toHaveBeenCalledTimes(1);
  expect(view.onComplete).toHaveBeenCalledWith([
    expect.objectContaining({ originalId: 'string:a-1', text: 'T:Hello' }),
    expect.objectContaining({ originalId: 'string:a-2', text: 'R:World' }),
  ]);
  view.unmount();
});

it('drops a retry response after an A-to-B project switch', async () => {
  const sourceRows = [
    { id: 'a-1', originalId: 'string:a-1', sourceOrder: 0, start: 0, end: 1, text: 'T:Hello', language: 'en' },
    { id: 'a-2', originalId: 'string:a-2', sourceOrder: 1, start: 1, end: 2, text: 'T:World', language: 'en' },
  ];
  mocks.hydratedRecord = completeRecord(
    sourceRows,
    1,
    await fingerprintTranslationSource(sourceA)
  );
  const view = await mount();
  await waitFor(() => expect(view.result.current.translatedSubtitles).toEqual(sourceRows));
  const provider = deferred();
  mocks.translate.mockReturnValueOnce(provider.promise);
  const pending = view.result.current.retryMainTranslation({ originalId: 'string:a-2' });
  await waitFor(() => expect(mocks.translate).toHaveBeenCalledTimes(1));

  act(() => {
    mocks.activeCacheId = 'cache-b';
    mocks.cacheListener?.('cache-b', 'cache-a');
    view.rerender({ rows: sourceB });
  });
  provider.resolve(translationResult(mocks.translate.mock.calls[0][0], 'R:'));

  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  expect(mocks.commitRevision).not.toHaveBeenCalled();
  expect(view.result.current.translatedSubtitles).toBeNull();
  view.unmount();
});

it('unmount aborts before provider registration', async () => {
  const view = await mount();
  const checkpoint = deferred();
  mocks.checkpoint.mockReturnValueOnce(checkpoint.promise);
  const pending = start(view.result);
  await waitFor(() => expect(mocks.checkpoint).toHaveBeenCalledTimes(1));
  view.unmount();
  checkpoint.resolve();
  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  expect(mocks.translate).not.toHaveBeenCalled();
});

it('Stop aborts the checkpoint before provider registration', async () => {
  const view = await mount();
  const checkpoint = deferred();
  mocks.checkpoint.mockReturnValueOnce(checkpoint.promise);
  const pending = start(view.result);
  await waitFor(() => expect(mocks.checkpoint).toHaveBeenCalledTimes(1));

  act(() => view.result.current.handleCancelTranslation());
  checkpoint.resolve();
  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  expect(mocks.translate).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalled();
  view.unmount();
});

it('Stop after the provider response rejects a deferred persistence acknowledgement', async () => {
  const view = await mount();
  const save = deferred();
  mocks.persist.mockImplementationOnce(async (_identity, terminal) => {
    await save.promise;
    return issueReceipt({ ...terminal, revision: 1 });
  });
  const pending = start(view.result);
  await waitFor(() => expect(mocks.persist).toHaveBeenCalledTimes(1));

  act(() => view.result.current.handleCancelTranslation());
  save.resolve();
  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  expect(view.onComplete).not.toHaveBeenCalledWith(expect.any(Array));
  expect(view.result.current.translatedSubtitles).toBeNull();
  view.unmount();
});
