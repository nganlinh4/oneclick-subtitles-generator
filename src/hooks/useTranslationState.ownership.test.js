import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { PartialTranslationError } from '../services/gemini/translationChunkProcessor';
import { createRequestController, removeRequestController } from '../services/gemini/requestManagement';
import { fingerprintTranslationSource } from '../utils/translationOwnership';
import { useTranslationState } from './useTranslationState';

const mocks = vi.hoisted(() => ({
  activeCacheId: 'cache-a',
  projects: new Map([['cache-a', 'project-a'], ['cache-b', 'project-b']]),
  cacheListener: null,
  brand: new WeakMap(),
  revision: 0,
  hydratedRecord: null,
  bulkFiles: [],
  checkpoint: vi.fn(),
  translate: vi.fn(),
  resolveIdentity: vi.fn(),
  assertIdentity: vi.fn(),
  read: vi.fn(),
  persist: vi.fn(),
  assertReceipt: vi.fn(),
  captureRevision: vi.fn(),
  commitRevision: vi.fn(),
  clear: vi.fn(),
  setBulkFiles: vi.fn(),
  setBulkTranslations: vi.fn(),
  setIsBulkTranslating: vi.fn(),
  setCurrentBulkFileIndex: vi.fn(),
  handleBulkTranslate: vi.fn(),
  t: (_key, fallback, values = {}) => String(fallback).replace(
    /{{(\w+)}}/g,
    (_match, key) => String(values[key] ?? '')
  ),
}));

const scopeError = () => Object.assign(new Error('project changed'), {
  name: 'AbortError',
  code: 'projectScopeMismatch',
});

const issueReceipt = (record) => {
  const receipt = Object.freeze({ kind: 'translation-persistence-receipt' });
  mocks.brand.set(receipt, { record });
  return receipt;
};

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: mocks.t,
  }),
}));

vi.mock('../services/geminiService', () => ({
  translateSubtitles: mocks.translate,
}));

vi.mock('../services/lifecycleOrchestrator', () => ({
  checkpointBeforeUpdate: mocks.checkpoint,
}));

vi.mock('../platform/translationPersistence', () => ({
  getActiveTranslationCacheId: () => mocks.activeCacheId,
  resolveTranslationIdentity: mocks.resolveIdentity,
  assertActiveTranslationIdentity: mocks.assertIdentity,
  readTranslationForIdentity: mocks.read,
  persistTranslationForIdentity: mocks.persist,
  assertTranslationPersistenceReceipt: mocks.assertReceipt,
  captureTranslationRevision: mocks.captureRevision,
  commitTranslationRevision: mocks.commitRevision,
  clearTranslationForIdentity: mocks.clear,
}));

vi.mock('../utils/userSubtitlesStore', () => ({
  subscribeCurrentCacheId: (listener) => {
    mocks.cacheListener = listener;
    return () => { if (mocks.cacheListener === listener) mocks.cacheListener = null; };
  },
  getCurrentCacheId: () => mocks.activeCacheId,
  getUserProvidedSubtitlesSync: () => '',
}));

vi.mock('../utils/transcriptionRulesStore', () => ({
  getTranscriptionRulesSync: () => null,
}));

vi.mock('./useTranslationBulk', () => ({
  useTranslationBulk: () => ({
    bulkFiles: mocks.bulkFiles,
    setBulkFiles: mocks.setBulkFiles,
    bulkTranslations: [],
    setBulkTranslations: mocks.setBulkTranslations,
    isBulkTranslating: false,
    setIsBulkTranslating: mocks.setIsBulkTranslating,
    currentBulkFileIndex: -1,
    setCurrentBulkFileIndex: mocks.setCurrentBulkFileIndex,
    handleBulkTranslate: mocks.handleBulkTranslate,
    handleBulkFileRemoval: vi.fn(),
    handleBulkFilesRemovalAll: vi.fn(),
  }),
}));

const sourceA = [
  { id: 'a-1', start: 0, end: 1, text: 'Hello' },
  { id: 'a-2', start: 1, end: 2, text: 'World' },
];
const sourceB = [
  { id: 'b-1', start: 0, end: 1, text: 'Other' },
];
const chain = [{ id: 1, type: 'language', value: 'English', isOriginal: false }];

const translatedRows = (input, prefix = 'T:') => input.map((row, index) => ({
  id: row.id ?? index + 1,
  start: row.start,
  end: row.end,
  text: `${prefix}${row.text}`,
  originalId: row.originalId,
  sourceOrder: row.sourceOrder,
  language: 'en',
}));

const translationResult = (input, prefix = 'T:', deliveries = []) => Object.freeze({
  status: 'complete',
  rows: translatedRows(input, prefix),
  deliveries,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

const completeRecord = (rows, revision = 1, sourceFingerprint = 'a'.repeat(64)) => ({
  schemaVersion: 1,
  revision,
  sourceFingerprint,
  sourceEntryCount: rows.length,
  languageChain: chain,
  model: 'gemini-test',
  status: 'complete',
  baseSubtitles: rows,
  failedChunks: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeCacheId = 'cache-a';
  mocks.projects = new Map([['cache-a', 'project-a'], ['cache-b', 'project-b']]);
  mocks.cacheListener = null;
  mocks.brand = new WeakMap();
  mocks.revision = 0;
  mocks.hydratedRecord = null;
  mocks.bulkFiles = [];
  mocks.resolveIdentity.mockImplementation(async (cacheId) => {
    const projectId = mocks.projects.get(cacheId);
    if (!projectId) throw scopeError();
    return Object.freeze({ cacheId, projectId });
  });
  mocks.assertIdentity.mockImplementation(async (identity) => {
    if (mocks.activeCacheId !== identity.cacheId
        || mocks.projects.get(identity.cacheId) !== identity.projectId) throw scopeError();
  });
  mocks.read.mockImplementation(async () => mocks.hydratedRecord);
  mocks.checkpoint.mockResolvedValue(undefined);
  mocks.translate.mockImplementation(async (input) => translationResult(input));
  mocks.persist.mockImplementation(async (_identity, terminal) => {
    const record = { ...terminal, revision: ++mocks.revision };
    mocks.hydratedRecord = record;
    return issueReceipt(record);
  });
  mocks.assertReceipt.mockImplementation((receipt) => {
    const owned = mocks.brand.get(receipt);
    if (!owned) {
      const error = new Error('cloned receipt');
      error.code = 'invalidTranslationPersistenceReceipt';
      throw error;
    }
    return owned;
  });
  mocks.captureRevision.mockImplementation(async () => ({
    revision: mocks.hydratedRecord.revision,
    sourceFingerprint: mocks.hydratedRecord.sourceFingerprint,
  }));
  mocks.commitRevision.mockImplementation(async (_identity, token, terminal) => {
    const record = { ...terminal, revision: token.revision + 1 };
    mocks.hydratedRecord = record;
    return issueReceipt(record);
  });
  mocks.clear.mockImplementation(async () => issueReceipt(null));
});

const mount = async (initialRows = sourceA) => {
  const onComplete = vi.fn();
  const view = renderHook(
    ({ rows }) => useTranslationState(rows, onComplete),
    { initialProps: { rows: initialRows } }
  );
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  await act(async () => { await Promise.resolve(); });
  onComplete.mockClear();
  mocks.read.mockClear();
  return { ...view, onComplete };
};

const start = (hook) => hook.current.handleTranslate(
  ['English'],
  ' ',
  false,
  { open: '', close: '' },
  chain
);

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
    false,
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
    false,
    expect.any(Object)
  );
  expect(mocks.persist).toHaveBeenCalledWith(
    expect.any(Object),
    expect.objectContaining({ languageChain: runnable })
  );
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
