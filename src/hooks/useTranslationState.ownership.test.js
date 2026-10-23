// Translation run ownership: canonical chains, the run lease, Stop, and project/source switches.
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createRequestController, removeRequestController } from '../services/gemini/requestManagement';
import { fingerprintTranslationSource } from '../utils/translationOwnership';
import { useTranslationState } from './useTranslationState';
import {
  completeRecord,
  deferred,
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

it('canonicalizes the blank editor target out of a format-only run and durable record', async () => {
  const view = await mount();
  const formatChain = [
    { id: 1, type: 'language', value: '', isOriginal: false },
    { id: 2, type: 'delimiter', value: 'FMT: ', style: { open: '', close: '' } },
    { id: 3, type: 'language', value: 'Original', isOriginal: true },
  ];

  let outcome;
  await act(async () => {
    outcome = await view.result.current.handleTranslate(
      [],
      '',
      false,
      null,
      formatChain
    );
  });
  expect(outcome).toMatchObject({ status: 'complete' });

  const runnable = [
    formatChain[1],
    formatChain[2],
  ];
  expect(mocks.translate).toHaveBeenCalledWith(
    expect.any(Array),
    [],
    expect.any(String),
    null,
    0,
    false,
    '',
    false,
    null,
    runnable,
    null,
    expect.any(Object)
  );
  expect(mocks.persist).toHaveBeenCalledWith(
    expect.any(Object),
    expect.objectContaining({ languageChain: runnable })
  );
  view.unmount();
});

it('canonicalizes blank editor targets out of a translated run and durable record', async () => {
  const view = await mount();
  const editorChain = [
    { id: 1, type: 'language', value: '', isOriginal: false },
    { id: 2, type: 'delimiter', value: ' ', style: { open: '', close: '' } },
    { id: 3, type: 'language', value: 'Vietnamese', isOriginal: false },
  ];

  let outcome;
  await act(async () => {
    outcome = await view.result.current.handleTranslate(
      ['Vietnamese'], ' ', false, null, editorChain
    );
  });
  expect(outcome).toMatchObject({ status: 'complete' });
  const runnable = [editorChain[2]];
  expect(mocks.translate).toHaveBeenCalledWith(
    expect.any(Array),
    'Vietnamese',
    'gemini-3.5-flash-lite',
    null,
    0,
    false,
    ' ',
    false,
    null,
    runnable,
    null,
    expect.any(Object)
  );
  expect(mocks.persist).toHaveBeenCalledWith(
    expect.any(Object),
    expect.objectContaining({ languageChain: runnable })
  );
  view.unmount();
});

it('publishes provider-validated rows before the complete translation settles', async () => {
  const view = await mount();
  const finish = deferred();
  mocks.translate.mockImplementationOnce(async (input, ...args) => {
    const ownership = args.at(-1);
    ownership.publishRows(translatedRows(input.slice(0, 1)));
    await finish.promise;
    return translationResult(input);
  });

  let pending;
  act(() => { pending = start(view.result); });
  await waitFor(() => {
    expect(view.result.current.translatedSubtitles).toEqual([
      expect.objectContaining({ originalId: 'string:a-1', text: 'T:Hello' }),
    ]);
  });
  await act(async () => {
    finish.resolve();
    await pending;
  });
  expect(view.result.current.translatedSubtitles).toHaveLength(2);
  view.unmount();
});

it('acquires a synchronous lease so same-tick double click starts one run', async () => {
  const view = await mount();
  const checkpoint = deferred();
  mocks.checkpoint.mockReturnValueOnce(checkpoint.promise);

  let first;
  let second;
  act(() => {
    first = start(view.result);
    second = start(view.result);
  });
  await expect(second).resolves.toEqual({ status: 'busy' });
  checkpoint.resolve();
  await expect(first).resolves.toMatchObject({ status: 'complete' });
  expect(mocks.checkpoint).toHaveBeenCalledTimes(1);
  expect(mocks.translate).toHaveBeenCalledTimes(1);
  expect(mocks.persist).toHaveBeenCalledTimes(1);
  view.unmount();
});

it('regains liveness after the StrictMode effect replay', async () => {
  const wrapper = ({ children }) => React.createElement(React.StrictMode, null, children);
  const onComplete = vi.fn();
  const view = renderHook(() => useTranslationState(sourceA, onComplete), { wrapper });
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());

  await expect(start(view.result)).resolves.toMatchObject({ status: 'complete' });
  expect(mocks.translate).toHaveBeenCalledTimes(1);
  expect(mocks.persist).toHaveBeenCalledTimes(1);
  view.unmount();
});

it('preserves owned bulk-only behavior without an active media or editor project', async () => {
  mocks.activeCacheId = null;
  mocks.bulkFiles = [{
    id: 'bulk-1',
    name: 'batch.srt',
    subtitles: [{ id: 1, start: 0, end: 1, text: 'Batch' }],
  }];
  mocks.handleBulkTranslate.mockResolvedValueOnce({ status: 'complete', results: [] });
  const onComplete = vi.fn();
  const view = renderHook(() => useTranslationState([], onComplete));

  await expect(start(view.result)).resolves.toEqual({ status: 'complete', scope: 'bulk' });
  expect(mocks.checkpoint).toHaveBeenCalledWith(expect.objectContaining({
    source: 'translation-start',
    signal: expect.any(AbortSignal),
  }));
  expect(mocks.handleBulkTranslate).toHaveBeenCalledTimes(1);
  expect(mocks.resolveIdentity).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalled();
  view.unmount();
});

it('cannot publish project A after switching to B during its checkpoint', async () => {
  const view = await mount();
  const checkpoint = deferred();
  mocks.checkpoint.mockReturnValueOnce(checkpoint.promise);
  const pending = start(view.result);
  await waitFor(() => expect(mocks.checkpoint).toHaveBeenCalledTimes(1));

  act(() => {
    mocks.activeCacheId = 'cache-b';
    mocks.cacheListener?.('cache-b', 'cache-a');
    view.rerender({ rows: sourceB });
  });
  checkpoint.resolve();

  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  expect(mocks.translate).not.toHaveBeenCalled();
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(view.onComplete).not.toHaveBeenCalledWith(expect.any(Array));
  expect(view.result.current.translatedSubtitles).toBeNull();
  view.unmount();
});

it.each(['resolved', 'rejected'])('loads the new project translation after the old request %s', async (outcome) => {
  const view = await mount();
  const provider = deferred();
  mocks.translate.mockReturnValueOnce(provider.promise);
  let pending;
  act(() => { pending = start(view.result); });
  await waitFor(() => expect(mocks.translate).toHaveBeenCalledTimes(1));
  const rowsB = translatedRows(sourceB.map((row, sourceOrder) => ({
    ...row,
    originalId: `string:${row.id}`,
    sourceOrder,
  })));
  mocks.hydratedRecord = completeRecord(rowsB, 1, await fingerprintTranslationSource(sourceB));

  act(() => {
    mocks.activeCacheId = 'cache-b';
    mocks.cacheListener?.('cache-b', 'cache-a');
    view.rerender({ rows: sourceB });
  });
  await act(async () => {
    if (outcome === 'resolved') provider.resolve(translationResult(mocks.translate.mock.calls[0][0]));
    else provider.reject(new Error('The cancelled provider closed its connection'));
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
  });

  await waitFor(() => expect(view.result.current.translatedSubtitles).toEqual(rowsB));
  expect(view.result.current.loadedFromCache).toBe(true);
  expect(mocks.persist).not.toHaveBeenCalled();
  view.unmount();
});

it('rejects a provider response after Stop even when the provider ignores abort', async () => {
  const view = await mount();
  const provider = deferred();
  mocks.translate.mockReturnValueOnce(provider.promise);
  const unrelated = createRequestController();
  const pending = start(view.result);
  await waitFor(() => expect(mocks.translate).toHaveBeenCalledTimes(1));

  act(() => view.result.current.handleCancelTranslation());
  provider.resolve(translationResult(mocks.translate.mock.calls[0][0]));
  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(unrelated.signal.aborted).toBe(false);
  removeRequestController(unrelated.requestId);
  view.unmount();
});

it.each([
  ['timing', sourceA.map((row, index) => (index === 0 ? { ...row, start: 0.01 } : row))],
  ['order', [sourceA[1], sourceA[0]]],
  ['id', sourceA.map((row, index) => (index === 0 ? { ...row, id: 'changed' } : row))],
  ['text', sourceA.map((row, index) => (index === 0 ? { ...row, text: 'Changed' } : row))],
])('rejects a provider response after a source %s-only change', async (_label, changed) => {
  const view = await mount();
  const provider = deferred();
  mocks.translate.mockReturnValueOnce(provider.promise);
  const pending = start(view.result);
  await waitFor(() => expect(mocks.translate).toHaveBeenCalledTimes(1));
  act(() => view.rerender({ rows: changed }));
  provider.resolve(translationResult(mocks.translate.mock.calls[0][0]));

  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(view.onComplete).not.toHaveBeenCalledWith(expect.any(Array));
  view.unmount();
});

it('rejects provider rows that lose the captured stable ID before persistence', async () => {
  const view = await mount();
  mocks.translate.mockImplementationOnce(async (input) => ({
    status: 'complete',
    rows: translatedRows(input).map(
      (row, index) => (index === 0 ? { ...row, originalId: 'string:wrong' } : row)
    ),
    deliveries: [],
  }));

  await expect(start(view.result)).resolves.toMatchObject({ status: 'failed' });
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(view.onComplete).not.toHaveBeenCalledWith(expect.any(Array));
  expect(view.result.current.translatedSubtitles).toBeNull();
  view.unmount();
});

it('detects an in-place source mutation even without a React rerender', async () => {
  const mutable = sourceA.map((row) => ({ ...row }));
  const view = await mount(mutable);
  const provider = deferred();
  mocks.translate.mockReturnValueOnce(provider.promise);
  const pending = start(view.result);
  await waitFor(() => expect(mocks.translate).toHaveBeenCalledTimes(1));
  mutable[0].end = 1.5;
  provider.resolve(translationResult(mocks.translate.mock.calls[0][0]));

  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(view.result.current.translatedSubtitles).toBeNull();
  view.unmount();
});

it('clears the owned projection when an in-place source mutation is detected', async () => {
  const mutable = sourceA.map((row) => ({ ...row }));
  const durableRows = translatedRows(mutable.map((row, sourceOrder) => ({
    ...row,
    originalId: `string:${row.id}`,
    sourceOrder,
  })));
  mocks.hydratedRecord = completeRecord(
    durableRows,
    1,
    await fingerprintTranslationSource(mutable)
  );
  const view = await mount(mutable);
  await waitFor(() => expect(view.result.current.translatedSubtitles).toEqual(durableRows));

  mutable[0].text = 'Changed without render';
  let outcome;
  await act(async () => {
    outcome = await view.result.current.retryMainTranslation({
      originalId: 'string:a-1',
    });
  });
  expect(outcome).toEqual({ status: 'cancelled' });

  await waitFor(() => expect(view.result.current.translatedSubtitles).toBeNull());
  expect(mocks.translate).not.toHaveBeenCalled();
  view.unmount();
});

it('rejects the same cache string after its project alias remaps during provider work', async () => {
  const view = await mount();
  const provider = deferred();
  mocks.translate.mockReturnValueOnce(provider.promise);
  const pending = start(view.result);
  await waitFor(() => expect(mocks.translate).toHaveBeenCalledTimes(1));
  mocks.projects.set('cache-a', 'project-remapped');
  provider.resolve(translationResult(mocks.translate.mock.calls[0][0]));

  await expect(pending).resolves.toEqual({ status: 'cancelled' });
  expect(mocks.persist).not.toHaveBeenCalled();
  view.unmount();
});
