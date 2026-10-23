// Translation persistence for the active subtitle project: every read and write goes through the
// exact native project, re-checking that the project is still active around each operation.
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

class TranslationPersistenceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TranslationPersistenceError';
    this.code = code;
  }
}

export const getActiveTranslationCacheId = () => {
  try {
    return getCurrentCacheId();
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
  return resolveExactTranslationProject(cacheId, { create, expectedProjectId });
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

export const readTranslationForIdentity = async (identity) => {
  await assertActiveTranslationIdentity(identity);
  const record = await readProjectTranslation(identity.cacheId, {
    expectedProjectId: identity.projectId,
  });
  await assertActiveTranslationIdentity(identity);
  return record;
};

export const persistTranslationForIdentity = async (
  identity,
  terminal,
  { expectedRevision = undefined } = {}
) => {
  await assertActiveTranslationIdentity(identity);
  const receipt = await persistProjectTranslation(identity.cacheId, terminal, {
    expectedProjectId: identity.projectId,
    expectedRevision,
  });
  await assertActiveTranslationIdentity(identity);
  return receipt;
};

export const assertTranslationPersistenceReceipt = (receipt, identity, expected = {}) => (
  assertProjectTranslationReceipt(receipt, {
    cacheId: identity.cacheId,
    projectId: identity.projectId,
    ...expected,
  })
);

export const captureTranslationRevision = async (identity) => {
  await assertActiveTranslationIdentity(identity);
  return captureProjectTranslationRevision(identity.cacheId, {
    expectedProjectId: identity.projectId,
  });
};

export const commitTranslationRevision = async (identity, token, terminal) => {
  await assertActiveTranslationIdentity(identity);
  const receipt = await commitProjectTranslationRevision(token, terminal, {
    expectedCacheId: identity.cacheId,
    expectedProjectId: identity.projectId,
  });
  await assertActiveTranslationIdentity(identity);
  return receipt;
};

export const clearTranslationForIdentity = async (identity) => {
  await assertActiveTranslationIdentity(identity);
  const receipt = await clearProjectTranslation(identity.cacheId, {
    expectedProjectId: identity.projectId,
  });
  await assertActiveTranslationIdentity(identity);
  return receipt;
};
