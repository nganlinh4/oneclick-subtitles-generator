import { resolveProjectForCache } from './subtitleProjectStore';
import { activateResolvedMediaProject } from './mediaProjectActivation';
import {
  bindTranscriptionRulesProject,
  isTranscriptionRulesProjectBindingReceipt,
  rollbackTranscriptionRulesProjectBinding,
  setCurrentCacheId as setRulesCacheId,
} from '../utils/transcriptionRulesStore';
import {
  bindUserSubtitlesProject,
  getCurrentCacheId as getSubtitlesCacheId,
  isUserSubtitlesProjectBindingReceipt,
  refreshCurrentSubtitleProject,
  rollbackUserSubtitlesProjectBinding,
  setCurrentCacheId as setSubtitlesCacheId,
} from '../utils/userSubtitlesStore';
import {
  activateProjectSnapshot,
  deactivateProject,
  getActiveProjectSnapshot,
} from './projectService';

const RECEIPT_KIND = 'subtitle-project-binding';
const receipts = new WeakMap();
let latestIntent = 0;

export class SubtitleProjectBindingError extends Error {
  constructor(message = 'The media could not be bound to its subtitle project.') {
    super(message);
    this.name = 'SubtitleProjectBindingError';
    this.code = 'subtitleProjectBindingFailed';
  }
}

const requireCacheId = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
    throw new SubtitleProjectBindingError();
  }
  return value;
};

const rollback = (outcomes) => {
  let restored = 0;
  for (const outcome of outcomes) {
    if (outcome.status !== 'fulfilled') continue;
    if (rollbackTranscriptionRulesProjectBinding(outcome.value)
        || rollbackUserSubtitlesProjectBinding(outcome.value)) {
      restored += 1;
    }
  }
  return restored === outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
};

/**
 * Make one cache alias authoritative for both auxiliary stores.
 *
 * The returned receipt means both stores either hydrated from, or persisted their staged value to,
 * the same exact durable project. Callers must await it before publishing media or a success state.
 */
export const activateSubtitleProjectBinding = async (cacheId, {
  expectedProjectId = null,
  create = true,
} = {}) => {
  const normalizedCacheId = requireCacheId(cacheId);
  latestIntent += 1;
  const intent = latestIntent;
  const previousCacheId = getSubtitlesCacheId();
  const previousActiveSnapshot = getActiveProjectSnapshot();
  const resolved = await resolveProjectForCache(normalizedCacheId, { create });
  if (intent !== latestIntent || !resolved?.projectId
      || (expectedProjectId !== null && resolved.projectId !== expectedProjectId)) {
    throw new SubtitleProjectBindingError();
  }
  const projectId = resolved.projectId;
  let activation;
  try {
    activation = await activateResolvedMediaProject(resolved, {
      validateOwnership: () => {
        if (intent !== latestIntent) throw new SubtitleProjectBindingError();
      },
    });
  } catch (error) {
    if (error instanceof SubtitleProjectBindingError) throw error;
    throw new SubtitleProjectBindingError();
  }
  let outcomes = [];
  try {
    outcomes = await Promise.allSettled([
      bindTranscriptionRulesProject(normalizedCacheId, { expectedProjectId: projectId }),
      bindUserSubtitlesProject(normalizedCacheId, { expectedProjectId: projectId }),
    ]);
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed) throw failed.reason;
    if (intent !== latestIntent) throw new SubtitleProjectBindingError();
    const [rules, subtitles] = outcomes.map((outcome) => outcome.value);
    if (!isTranscriptionRulesProjectBindingReceipt(rules, {
      cacheId: normalizedCacheId,
      projectId,
    }) || !isUserSubtitlesProjectBindingReceipt(subtitles, {
      cacheId: normalizedCacheId,
      projectId,
    })) {
      throw new SubtitleProjectBindingError();
    }
    const current = await resolveProjectForCache(normalizedCacheId, { create: false });
    if (intent !== latestIntent || current?.projectId !== projectId) {
      throw new SubtitleProjectBindingError();
    }
    // Re-downloading the same URL keeps the alias but advances its media revision. Identity
    // subscribers stay quiet by design, so explicitly tell the editor to re-read the snapshot.
    if (previousCacheId === normalizedCacheId) refreshCurrentSubtitleProject(normalizedCacheId);
    const receipt = Object.freeze({
      kind: RECEIPT_KIND,
      cacheId: normalizedCacheId,
      projectId,
      stateVersion: current.snapshot?.stateVersion ?? null,
    });
    receipts.set(receipt, Object.freeze({
      activation,
      intent,
      outcomes: Object.freeze([...outcomes]),
      previousActiveSnapshot,
    }));
    return receipt;
  } catch (error) {
    rollback(outcomes);
    try {
      const released = activation.release();
      if (released && intent === latestIntent && previousActiveSnapshot !== null) {
        activateProjectSnapshot(previousActiveSnapshot);
      }
    } catch {
      // A release failure cannot make this binding valid. A concurrent publication is safer than
      // forcing the older snapshot over it.
    }
    throw error;
  }
};

export const isSubtitleProjectBindingReceipt = (value, {
  cacheId,
  projectId = null,
} = {}) => (
  value?.kind === RECEIPT_KIND
  && receipts.has(value)
  && value.cacheId === cacheId
  && (projectId === null || value.projectId === projectId)
);

/**
 * Withdraw a still-current activation transaction which failed after the two auxiliary stores
 * were bound. This is deliberately receipt-owned: an older media operation cannot roll back a
 * newer binding, and a project revision advanced by the failed operation cannot defeat restoring
 * the previously active project identity.
 */
export const rollbackSubtitleProjectBinding = (receipt) => {
  const owned = receipt && typeof receipt === 'object' ? receipts.get(receipt) : null;
  if (!owned || receipt.kind !== RECEIPT_KIND) return false;
  receipts.delete(receipt);
  if (owned.intent !== latestIntent) return false;

  // Claim the publication channel before notifying either store. A synchronous subscriber may
  // start another activation; that newer intent must win and must not be overwritten below.
  latestIntent += 1;
  const rollbackIntent = latestIntent;
  if (!rollback(owned.outcomes) || latestIntent !== rollbackIntent) return false;

  const active = getActiveProjectSnapshot();
  if (active?.metadata?.id !== receipt.projectId) return true;
  try {
    if (owned.previousActiveSnapshot === null) {
      deactivateProject({ expectedProjectId: receipt.projectId });
    } else if (owned.previousActiveSnapshot.metadata?.id !== receipt.projectId) {
      activateProjectSnapshot(owned.previousActiveSnapshot);
    }
  } catch {
    // The in-memory stores were already restored. A concurrent project publication is safer than
    // forcing an older snapshot over it; the caller will refuse the failed media transaction.
  }
  return true;
};

export const clearSubtitleProjectBinding = () => {
  latestIntent += 1;
  setRulesCacheId(null);
  setSubtitlesCacheId(null);
};
