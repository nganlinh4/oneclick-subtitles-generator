import { createProjectTranslationStore } from './projectTranslationStore';

const PROJECT_A = '01890f39-7b62-7c4e-8c9a-000000000401';
const PROJECT_B = '01890f39-7b62-7c4e-8c9a-000000000402';
const FINGERPRINT = 'a'.repeat(64);

const terminal = (text = 'Translated') => ({
  sourceFingerprint: FINGERPRINT,
  sourceEntryCount: 1,
  languageChain: [{
    id: 'language-1',
    type: 'language',
    value: 'English',
    isOriginal: false,
  }],
  model: 'gemini-test',
  status: 'complete',
  baseSubtitles: [{
    id: 1,
    start: 0,
    end: 1,
    text,
    originalId: 'number:1',
    sourceOrder: 0,
  }],
  failedChunks: [],
});

const deferred = () => {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
};

const createHarness = () => {
  let projectId = PROJECT_A;
  let auxiliary = {
    schemaVersion: 1,
    userSubtitles: null,
    transcriptionRules: null,
    translation: null,
  };
  const resolveProject = vi.fn(async (cacheId) => (
    projectId === null ? null : { cacheId, projectId }
  ));
  const readAuxiliary = vi.fn(async () => auxiliary);
  const patchAuxiliary = vi.fn(async (_cacheId, changes, options) => {
    expect(options.expectedProjectId).toBe(projectId);
    const revision = auxiliary.translation?.revision ?? null;
    if (options.expectedTranslationRevision !== revision) {
      const error = new Error('revision conflict');
      error.code = 'translationRevisionConflict';
      throw error;
    }
    auxiliary = { ...auxiliary, ...changes };
    return auxiliary;
  });
  return {
    get auxiliary() { return auxiliary; },
    setProjectId(value) { projectId = value; },
    patchAuxiliary,
    resolveProject,
    store: createProjectTranslationStore({ readAuxiliary, patchAuxiliary, resolveProject }),
  };
};

it('persists an exact project revision and rejects cloned structural receipts', async () => {
  const harness = createHarness();
  const receipt = await harness.store.persist('cache-a', terminal(), {
    expectedProjectId: PROJECT_A,
  });

  expect(harness.auxiliary.translation).toMatchObject({ revision: 1, status: 'complete' });
  expect(harness.store.assertReceipt(receipt, {
    cacheId: 'cache-a',
    projectId: PROJECT_A,
    revision: 1,
    sourceFingerprint: FINGERPRINT,
    status: 'complete',
  }).record.baseSubtitles[0].text).toBe('Translated');
  expect(() => harness.store.assertReceipt({ ...receipt }, {
    projectId: PROJECT_A,
  })).toThrowError(expect.objectContaining({ code: 'invalidTranslationPersistenceReceipt' }));
});

it('serializes retry ownership with an unforgeable captured revision and CAS conflict', async () => {
  const harness = createHarness();
  await harness.store.persist('cache-a', terminal(), { expectedProjectId: PROJECT_A });
  const first = await harness.store.captureRevision('cache-a', { expectedProjectId: PROJECT_A });
  const second = await harness.store.captureRevision('cache-a', { expectedProjectId: PROJECT_A });

  const owner = { expectedCacheId: 'cache-a', expectedProjectId: PROJECT_A };
  await harness.store.commitRevision(first, terminal('First retry'), owner);
  await expect(harness.store.commitRevision(second, terminal('Stale retry'), owner))
    .rejects.toMatchObject({ code: 'translationRevisionConflict' });
  await expect(harness.store.commitRevision({ ...first }, terminal('Forged retry'), owner))
    .rejects.toMatchObject({ code: 'invalidTranslationRevision' });
});

it('rejects a genuine A revision presented through identity B before persistence', async () => {
  const harness = createHarness();
  await harness.store.persist('cache-a', terminal(), { expectedProjectId: PROJECT_A });
  const token = await harness.store.captureRevision('cache-a', {
    expectedProjectId: PROJECT_A,
  });
  harness.patchAuxiliary.mockClear();

  await expect(harness.store.commitRevision(token, terminal('Wrong owner'), {
    expectedCacheId: 'cache-b',
    expectedProjectId: PROJECT_B,
  })).rejects.toMatchObject({ code: 'translationRevisionConflict' });

  expect(harness.patchAuxiliary).not.toHaveBeenCalled();
  expect(harness.auxiliary.translation.baseSubtitles[0].text).toBe('Translated');
});

it('does not acknowledge a write if the same cache alias remaps during persistence', async () => {
  const harness = createHarness();
  const gate = deferred();
  harness.patchAuxiliary.mockImplementationOnce(async (_cacheId, changes, options) => {
    await gate.promise;
    return {
      schemaVersion: 1,
      userSubtitles: null,
      transcriptionRules: null,
      translation: { ...changes.translation },
      options,
    };
  });

  const pending = harness.store.persist('cache-a', terminal(), {
    expectedProjectId: PROJECT_A,
  });
  await vi.waitFor(() => expect(harness.patchAuxiliary).toHaveBeenCalledTimes(1));
  harness.setProjectId(PROJECT_B);
  gate.resolve();

  await expect(pending).rejects.toMatchObject({ code: 'projectScopeMismatch' });
});

it('does not create or write when an expected project alias was deleted', async () => {
  const harness = createHarness();
  harness.setProjectId(null);

  await expect(harness.store.persist('cache-a', terminal(), {
    expectedProjectId: PROJECT_A,
  })).rejects.toMatchObject({ code: 'projectScopeMismatch' });

  expect(harness.resolveProject).toHaveBeenCalledWith('cache-a', { create: false });
  expect(harness.resolveProject).not.toHaveBeenCalledWith('cache-a', { create: true });
  expect(harness.patchAuxiliary).not.toHaveBeenCalled();
});

it('waits for the native persistence acknowledgement and rejects hostile nested data first', async () => {
  const harness = createHarness();
  const gate = deferred();
  harness.patchAuxiliary.mockImplementationOnce(async (_cacheId, changes) => {
    await gate.promise;
    return { ...harness.auxiliary, translation: changes.translation };
  });
  let settled = false;
  const pending = harness.store.persist('cache-a', terminal(), {
    expectedProjectId: PROJECT_A,
  }).then((receipt) => {
    settled = true;
    return receipt;
  });
  await vi.waitFor(() => expect(harness.patchAuxiliary).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  gate.resolve();
  await expect(pending).resolves.toMatchObject({ revision: 1 });

  const accessor = terminal();
  Object.defineProperty(accessor.baseSubtitles[0], 'text', {
    enumerable: true,
    get() { throw new Error('getter executed'); },
  });
  await expect(harness.store.persist('cache-a', accessor, {
    expectedProjectId: PROJECT_A,
  })).rejects.toMatchObject({ code: 'invalidTranslationData' });

  const topLevelAccessor = terminal();
  Object.defineProperty(topLevelAccessor, 'model', {
    enumerable: true,
    get() { throw new Error('top-level getter executed'); },
  });
  await expect(harness.store.persist('cache-a', topLevelAccessor, {
    expectedProjectId: PROJECT_A,
  })).rejects.toMatchObject({ code: 'invalidTranslationData' });
});
