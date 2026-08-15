import { patchProjectAuxiliary, readProjectAuxiliary } from './projectAuxiliaryStore';
import { resolveProjectForCache } from './subtitleProjectStore';
import { cloneTranslationRecord, normalizeTranslationRecord } from '../utils/translationOwnership';

export class ProjectTranslationStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectTranslationStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

const validateIdentity = (cacheId, projectId = null) => {
  if (typeof cacheId !== 'string' || cacheId.length === 0 || cacheId.length > 8_192) {
    throw new ProjectTranslationStoreError('invalidCacheId', 'A bounded cache ID is required');
  }
  if (projectId !== null && (typeof projectId !== 'string' || projectId.length === 0)) {
    throw new ProjectTranslationStoreError(
      'projectScopeMismatch',
      'An exact translation project is required'
    );
  }
};

export const createProjectTranslationStore = ({
  readAuxiliary = readProjectAuxiliary,
  patchAuxiliary = patchProjectAuxiliary,
  resolveProject = resolveProjectForCache,
} = {}) => {
  const receiptMetadata = new WeakMap();
  const revisionMetadata = new WeakMap();

  const resolveExact = async (cacheId, { create = false, expectedProjectId = null } = {}) => {
    validateIdentity(cacheId, expectedProjectId);
    const resolved = await resolveProject(cacheId, { create });
    if (!resolved?.projectId
        || (expectedProjectId !== null && resolved.projectId !== expectedProjectId)) {
      throw new ProjectTranslationStoreError(
        'projectScopeMismatch',
        'The translation project alias changed'
      );
    }
    return Object.freeze({ cacheId, projectId: resolved.projectId });
  };

  const assertStillExact = async (identity) => {
    const resolved = await resolveExact(identity.cacheId, {
      create: false,
      expectedProjectId: identity.projectId,
    });
    if (resolved.projectId !== identity.projectId) {
      throw new ProjectTranslationStoreError(
        'projectScopeMismatch',
        'The translation project alias changed'
      );
    }
  };

  const read = async (cacheId, { expectedProjectId = null } = {}) => {
    const identity = await resolveExact(cacheId, {
      create: false,
      expectedProjectId,
    });
    const auxiliary = await readAuxiliary(cacheId, {
      expectedProjectId: identity.projectId,
    });
    await assertStillExact(identity);
    if (auxiliary?.translation == null) return null;
    return normalizeTranslationRecord(auxiliary.translation, { allowNull: false });
  };

  const makeReceipt = (identity, record, operation) => {
    const receipt = Object.freeze({
      kind: 'translation-persistence-receipt',
      projectId: identity.projectId,
      revision: record?.revision ?? null,
      sourceFingerprint: record?.sourceFingerprint ?? null,
      status: record?.status ?? 'cleared',
    });
    receiptMetadata.set(receipt, Object.freeze({
      cacheId: identity.cacheId,
      projectId: identity.projectId,
      record,
      operation,
    }));
    return receipt;
  };

  const assertReceipt = (receipt, expected = {}) => {
    const owned = receipt && typeof receipt === 'object'
      ? receiptMetadata.get(receipt)
      : null;
    if (!owned) {
      throw new ProjectTranslationStoreError(
        'invalidTranslationPersistenceReceipt',
        'A genuine translation persistence acknowledgement is required'
      );
    }
    for (const field of ['cacheId', 'projectId']) {
      if (expected[field] !== undefined && owned[field] !== expected[field]) {
        throw new ProjectTranslationStoreError(
          'invalidTranslationPersistenceReceipt',
          'The translation persistence acknowledgement has the wrong owner'
        );
      }
    }
    for (const field of ['revision', 'sourceFingerprint', 'status']) {
      if (expected[field] !== undefined && owned.record?.[field] !== expected[field]) {
        throw new ProjectTranslationStoreError(
          'invalidTranslationPersistenceReceipt',
          'The translation persistence acknowledgement has the wrong revision'
        );
      }
    }
    return owned;
  };

  const persist = async (
    cacheId,
    terminal,
    { expectedProjectId, expectedRevision = undefined } = {}
  ) => {
    if (typeof expectedProjectId !== 'string' || expectedProjectId.length === 0) {
      throw new ProjectTranslationStoreError(
        'projectScopeMismatch',
        'An explicit expected translation project is required for persistence'
      );
    }
    const identity = await resolveExact(cacheId, {
      // Translation writes are always scoped to a previously captured project. Creating while
      // checking an expected ID could manufacture an orphan before detecting a deleted alias.
      create: false,
      expectedProjectId,
    });
    let baselineRevision = expectedRevision;
    if (baselineRevision === undefined) {
      const current = await read(cacheId, { expectedProjectId: identity.projectId });
      baselineRevision = current?.revision ?? null;
    }
    if (baselineRevision !== null
        && (!Number.isSafeInteger(baselineRevision) || baselineRevision < 1)) {
      throw new ProjectTranslationStoreError(
        'translationRevisionConflict',
        'The expected translation revision is invalid'
      );
    }
    const record = normalizeTranslationRecord(terminal, {
      allowNull: false,
      revisionOverride: baselineRevision === null ? 1 : baselineRevision + 1,
    });
    const auxiliary = await patchAuxiliary(
      cacheId,
      { translation: cloneTranslationRecord(record) },
      {
        expectedProjectId: identity.projectId,
        expectedTranslationRevision: baselineRevision,
      }
    );
    await assertStillExact(identity);
    const acknowledged = normalizeTranslationRecord(auxiliary?.translation, { allowNull: false });
    if (JSON.stringify(acknowledged) !== JSON.stringify(record)) {
      throw new ProjectTranslationStoreError(
        'translationPersistenceMismatch',
        'The durable translation acknowledgement did not match the requested revision'
      );
    }
    return makeReceipt(identity, acknowledged, 'persist');
  };

  const captureRevision = async (cacheId, { expectedProjectId } = {}) => {
    if (typeof expectedProjectId !== 'string' || expectedProjectId.length === 0) {
      throw new ProjectTranslationStoreError(
        'projectScopeMismatch',
        'An explicit expected translation project is required for retry'
      );
    }
    const identity = await resolveExact(cacheId, {
      create: false,
      expectedProjectId,
    });
    const record = await read(cacheId, { expectedProjectId: identity.projectId });
    if (record === null) {
      throw new ProjectTranslationStoreError(
        'translationRevisionConflict',
        'There is no durable translation revision to retry'
      );
    }
    const token = Object.freeze({
      kind: 'translation-revision',
      cacheId,
      projectId: identity.projectId,
      revision: record.revision,
      sourceFingerprint: record.sourceFingerprint,
    });
    revisionMetadata.set(token, Object.freeze({ identity, record }));
    return token;
  };

  const commitRevision = async (
    token,
    terminal,
    { expectedCacheId, expectedProjectId } = {}
  ) => {
    const owned = token && typeof token === 'object' ? revisionMetadata.get(token) : null;
    if (!owned) {
      throw new ProjectTranslationStoreError(
        'invalidTranslationRevision',
        'A captured translation revision is required'
      );
    }
    if (typeof expectedCacheId !== 'string' || expectedCacheId.length === 0
        || typeof expectedProjectId !== 'string' || expectedProjectId.length === 0
        || owned.identity.cacheId !== expectedCacheId
        || owned.identity.projectId !== expectedProjectId) {
      throw new ProjectTranslationStoreError(
        'translationRevisionConflict',
        'The captured translation revision belongs to a different project'
      );
    }
    const normalized = normalizeTranslationRecord(terminal, {
      allowNull: false,
      revisionOverride: owned.record.revision + 1,
    });
    if (normalized.sourceFingerprint !== owned.record.sourceFingerprint) {
      throw new ProjectTranslationStoreError(
        'translationRevisionConflict',
        'A retry cannot change its source translation identity'
      );
    }
    return persist(owned.identity.cacheId, normalized, {
      expectedProjectId: owned.identity.projectId,
      expectedRevision: owned.record.revision,
    });
  };

  const clear = async (cacheId, { expectedProjectId } = {}) => {
    if (typeof expectedProjectId !== 'string' || expectedProjectId.length === 0) {
      throw new ProjectTranslationStoreError(
        'projectScopeMismatch',
        'An explicit expected translation project is required for clearing'
      );
    }
    const identity = await resolveExact(cacheId, {
      create: false,
      expectedProjectId,
    });
    const current = await read(cacheId, { expectedProjectId: identity.projectId });
    if (current === null) return makeReceipt(identity, null, 'clear');
    const auxiliary = await patchAuxiliary(
      cacheId,
      { translation: null },
      {
        expectedProjectId: identity.projectId,
        expectedTranslationRevision: current.revision,
      }
    );
    await assertStillExact(identity);
    if (auxiliary?.translation !== null) {
      throw new ProjectTranslationStoreError(
        'translationPersistenceMismatch',
        'The durable translation was not cleared'
      );
    }
    return makeReceipt(identity, null, 'clear');
  };

  return Object.freeze({
    resolveExact,
    assertStillExact,
    read,
    persist,
    captureRevision,
    commitRevision,
    clear,
    assertReceipt,
  });
};

const projectTranslationStore = createProjectTranslationStore();

export const resolveExactTranslationProject = projectTranslationStore.resolveExact;
export const assertExactTranslationProject = projectTranslationStore.assertStillExact;
export const readProjectTranslation = projectTranslationStore.read;
export const persistProjectTranslation = projectTranslationStore.persist;
export const captureProjectTranslationRevision = projectTranslationStore.captureRevision;
export const commitProjectTranslationRevision = projectTranslationStore.commitRevision;
export const clearProjectTranslation = projectTranslationStore.clear;
export const assertProjectTranslationReceipt = projectTranslationStore.assertReceipt;
