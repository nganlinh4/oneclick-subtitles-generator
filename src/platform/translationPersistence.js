import { isDesktopRuntime } from './runtimeEnvironment';
import {
  assertProjectTranslationReceipt,
  captureProjectTranslationRevision,
  clearProjectTranslation,
  commitProjectTranslationRevision,
  persistProjectTranslation,
  readProjectTranslation,
  resolveExactTranslationProject,
} from './projectTranslationStore';
import { getCurrentCacheId } from '../utils/userSubtitlesStore';
import { getCurrentMediaId } from '../utils/mediaId';
import { cloneTranslationRecord, normalizeTranslationRecord } from '../utils/translationOwnership';

export const BROWSER_TRANSLATION_CACHE_KEY = 'translated_subtitles_cache';

const browserReceipts = new WeakMap();
const browserRevisions = new WeakMap();

export class TranslationPersistenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TranslationPersistenceError';
    this.code = code;
  }
}

const browserProjectId = (cacheId) => `browser:${cacheId}`;

export const getActiveTranslationCacheId = () => {
  try {
    if (isDesktopRuntime()) return getCurrentCacheId();
    return getCurrentCacheId() || getCurrentMediaId();
  } catch {
    return null;
  }
};

const assertCacheId = (cacheId) => {
  if (typeof cacheId !== 'string' || cacheId.length === 0 || cacheId.length > 8_192) {
    throw new TranslationPersistenceError(
      'translationProjectUnavailable',
      'No exact subtitle project is active for translation'
    );
  }
};

export const resolveTranslationIdentity = async (
  cacheId = getActiveTranslationCacheId(),
  { create = false, expectedProjectId = null } = {}
) => {
  assertCacheId(cacheId);
  if (isDesktopRuntime()) {
    return resolveExactTranslationProject(cacheId, { create, expectedProjectId });
  }
  const projectId = browserProjectId(cacheId);
  if (expectedProjectId !== null && projectId !== expectedProjectId) {
    throw new TranslationPersistenceError(
      'projectScopeMismatch',
      'The browser translation project changed'
    );
  }
  return Object.freeze({ cacheId, projectId });
};

export const assertActiveTranslationIdentity = async (identity) => {
  if (!identity || getActiveTranslationCacheId() !== identity.cacheId) {
    throw new TranslationPersistenceError(
      'projectScopeMismatch',
      'The active translation project changed'
    );
  }
  await resolveTranslationIdentity(identity.cacheId, {
    create: false,
    expectedProjectId: identity.projectId,
  });
};

const readBrowserEnvelope = () => {
  const serialized = localStorage.getItem(BROWSER_TRANSLATION_CACHE_KEY);
  if (typeof serialized !== 'string' || serialized.length === 0
      || serialized.length > 1024 * 1024) return null;
  try {
    const parsed = JSON.parse(serialized);
    if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype
        || typeof parsed.cacheId !== 'string') return null;
    return {
      cacheId: parsed.cacheId,
      translation: normalizeTranslationRecord(parsed.translation, { allowNull: false }),
    };
  } catch {
    return null;
  }
};

export const readTranslationForIdentity = async (identity) => {
  await assertActiveTranslationIdentity(identity);
  if (isDesktopRuntime()) {
    const record = await readProjectTranslation(identity.cacheId, {
      expectedProjectId: identity.projectId,
    });
    await assertActiveTranslationIdentity(identity);
    return record;
  }
  const envelope = readBrowserEnvelope();
  await assertActiveTranslationIdentity(identity);
  return envelope?.cacheId === identity.cacheId ? envelope.translation : null;
};

const makeBrowserReceipt = (identity, record, operation) => {
  const receipt = Object.freeze({
    kind: 'translation-persistence-receipt',
    projectId: identity.projectId,
    revision: record?.revision ?? null,
    sourceFingerprint: record?.sourceFingerprint ?? null,
    status: record?.status ?? 'cleared',
  });
  browserReceipts.set(receipt, Object.freeze({ identity, record, operation }));
  return receipt;
};

export const persistTranslationForIdentity = async (
  identity,
  terminal,
  { expectedRevision = undefined } = {}
) => {
  await assertActiveTranslationIdentity(identity);
  if (isDesktopRuntime()) {
    const receipt = await persistProjectTranslation(identity.cacheId, terminal, {
      expectedProjectId: identity.projectId,
      expectedRevision,
    });
    await assertActiveTranslationIdentity(identity);
    return receipt;
  }
  const current = readBrowserEnvelope();
  const currentRevision = current?.cacheId === identity.cacheId
    ? current.translation.revision
    : null;
  const baseline = expectedRevision === undefined ? currentRevision : expectedRevision;
  if (baseline !== currentRevision) {
    throw new TranslationPersistenceError(
      'translationRevisionConflict',
      'The browser translation changed before it could be saved'
    );
  }
  const record = normalizeTranslationRecord(terminal, {
    allowNull: false,
    revisionOverride: baseline === null ? 1 : baseline + 1,
  });
  localStorage.setItem(BROWSER_TRANSLATION_CACHE_KEY, JSON.stringify({
    cacheId: identity.cacheId,
    translation: cloneTranslationRecord(record),
  }));
  await assertActiveTranslationIdentity(identity);
  const acknowledged = readBrowserEnvelope();
  if (acknowledged?.cacheId !== identity.cacheId
      || JSON.stringify(acknowledged.translation) !== JSON.stringify(record)) {
    throw new TranslationPersistenceError(
      'translationPersistenceMismatch',
      'The browser translation acknowledgement did not match'
    );
  }
  return makeBrowserReceipt(identity, acknowledged.translation, 'persist');
};

export const assertTranslationPersistenceReceipt = (receipt, identity, expected = {}) => {
  if (identity.projectId.startsWith('browser:')) {
    const owned = receipt && typeof receipt === 'object' ? browserReceipts.get(receipt) : null;
    if (!owned || owned.identity.cacheId !== identity.cacheId
        || owned.identity.projectId !== identity.projectId) {
      throw new TranslationPersistenceError(
        'invalidTranslationPersistenceReceipt',
        'A genuine browser translation acknowledgement is required'
      );
    }
    for (const field of ['revision', 'sourceFingerprint', 'status']) {
      if (expected[field] !== undefined && owned.record?.[field] !== expected[field]) {
        throw new TranslationPersistenceError(
          'invalidTranslationPersistenceReceipt',
          'The browser translation acknowledgement has the wrong revision'
        );
      }
    }
    return owned;
  }
  return assertProjectTranslationReceipt(receipt, {
    cacheId: identity.cacheId,
    projectId: identity.projectId,
    ...expected,
  });
};

export const captureTranslationRevision = async (identity) => {
  await assertActiveTranslationIdentity(identity);
  if (isDesktopRuntime()) {
    return captureProjectTranslationRevision(identity.cacheId, {
      expectedProjectId: identity.projectId,
    });
  }
  const record = await readTranslationForIdentity(identity);
  if (record === null) {
    throw new TranslationPersistenceError(
      'translationRevisionConflict',
      'There is no browser translation revision to retry'
    );
  }
  const token = Object.freeze({
    kind: 'translation-revision',
    cacheId: identity.cacheId,
    projectId: identity.projectId,
    revision: record.revision,
    sourceFingerprint: record.sourceFingerprint,
  });
  browserRevisions.set(token, Object.freeze({ identity, record }));
  return token;
};

export const commitTranslationRevision = async (identity, token, terminal) => {
  await assertActiveTranslationIdentity(identity);
  if (isDesktopRuntime()) {
    const receipt = await commitProjectTranslationRevision(token, terminal, {
      expectedCacheId: identity.cacheId,
      expectedProjectId: identity.projectId,
    });
    await assertActiveTranslationIdentity(identity);
    return receipt;
  }
  const owned = token && typeof token === 'object' ? browserRevisions.get(token) : null;
  if (!owned || owned.identity.cacheId !== identity.cacheId
      || owned.identity.projectId !== identity.projectId) {
    throw new TranslationPersistenceError(
      'invalidTranslationRevision',
      'A captured browser translation revision is required'
    );
  }
  const normalizedTerminal = normalizeTranslationRecord(terminal, {
    allowNull: false,
    revisionOverride: owned.record.revision + 1,
  });
  if (normalizedTerminal.sourceFingerprint !== owned.record.sourceFingerprint) {
    throw new TranslationPersistenceError(
      'translationRevisionConflict',
      'A retry cannot change its source identity'
    );
  }
  return persistTranslationForIdentity(identity, normalizedTerminal, {
    expectedRevision: owned.record.revision,
  });
};

export const clearTranslationForIdentity = async (identity) => {
  await assertActiveTranslationIdentity(identity);
  if (isDesktopRuntime()) {
    const receipt = await clearProjectTranslation(identity.cacheId, {
      expectedProjectId: identity.projectId,
    });
    await assertActiveTranslationIdentity(identity);
    return receipt;
  }
  const current = readBrowserEnvelope();
  if (current?.cacheId === identity.cacheId) localStorage.removeItem(BROWSER_TRANSLATION_CACHE_KEY);
  await assertActiveTranslationIdentity(identity);
  return makeBrowserReceipt(identity, null, 'clear');
};
