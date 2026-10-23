// Shared mocks, rows and mount helper for the useTranslationState test files. It imports no
// product module, so vi.mock factories can load it without a cycle through the mocked modules.
import { expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

export const mocks = {
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
};

export const scopeError = () => Object.assign(new Error('project changed'), {
  name: 'AbortError',
  code: 'projectScopeMismatch',
});

export const issueReceipt = (record) => {
  const receipt = Object.freeze({ kind: 'translation-persistence-receipt' });
  mocks.brand.set(receipt, { record });
  return receipt;
};

export const reactI18nextMock = () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: mocks.t,
  }),
});

export const geminiServiceMock = () => ({
  translateSubtitles: mocks.translate,
});

export const lifecycleOrchestratorMock = () => ({
  checkpointBeforeUpdate: mocks.checkpoint,
});

export const translationPersistenceMock = () => ({
  getActiveTranslationCacheId: () => mocks.activeCacheId,
  resolveTranslationIdentity: mocks.resolveIdentity,
  assertActiveTranslationIdentity: mocks.assertIdentity,
  readTranslationForIdentity: mocks.read,
  persistTranslationForIdentity: mocks.persist,
  assertTranslationPersistenceReceipt: mocks.assertReceipt,
  captureTranslationRevision: mocks.captureRevision,
  commitTranslationRevision: mocks.commitRevision,
  clearTranslationForIdentity: mocks.clear,
});

export const userSubtitlesStoreMock = () => ({
  subscribeCurrentCacheId: (listener) => {
    mocks.cacheListener = listener;
    return () => { if (mocks.cacheListener === listener) mocks.cacheListener = null; };
  },
  getCurrentCacheId: () => mocks.activeCacheId,
  getUserProvidedSubtitlesSync: () => '',
});

export const transcriptionRulesStoreMock = () => ({
  getTranscriptionRulesSync: () => null,
});

export const translationBulkMock = () => ({
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
});

export const sourceA = [
  { id: 'a-1', start: 0, end: 1, text: 'Hello' },
  { id: 'a-2', start: 1, end: 2, text: 'World' },
];
export const sourceB = [
  { id: 'b-1', start: 0, end: 1, text: 'Other' },
];
export const chain = [{ id: 1, type: 'language', value: 'English', isOriginal: false }];

export const translatedRows = (input, prefix = 'T:') => input.map((row, index) => ({
  id: row.id ?? index + 1,
  start: row.start,
  end: row.end,
  text: `${prefix}${row.text}`,
  originalId: row.originalId,
  sourceOrder: row.sourceOrder,
  language: 'en',
}));

export const translationResult = (input, prefix = 'T:', deliveries = []) => Object.freeze({
  status: 'complete',
  rows: translatedRows(input, prefix),
  deliveries,
});

export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

export const completeRecord = (rows, revision = 1, sourceFingerprint = 'a'.repeat(64)) => ({
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

export const resetTranslationStateMocks = () => {
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
};

export const mountTranslationState = async (useTranslationState, initialRows = sourceA) => {
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

export const startTranslation = (hook) => hook.current.handleTranslate(
  ['English'],
  ' ',
  false,
  { open: '', close: '' },
  chain
);
