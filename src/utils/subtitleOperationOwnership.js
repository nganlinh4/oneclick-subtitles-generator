import { getCurrentCacheId as getRulesCacheId } from './transcriptionRulesStore';
import { getCurrentCacheId as getSubtitlesCacheId } from './userSubtitlesStore';
import { resolveProjectForCache } from '../platform/subtitleProjectStore';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import {
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from '../platform/nativeMediaOwnership';

const CONTEXT_KIND = 'subtitle-operation-context';
const LEASE_KIND = 'subtitle-project-operation-lease';
const contexts = new WeakMap();
const activeOperations = new Map();
const projectOperationTails = new Map();
const leases = new WeakMap();

export class SubtitleOperationOwnershipError extends Error {
  constructor(code = 'subtitleOperationOwnershipLost') {
    const message = code === 'subtitleOperationAborted'
      ? 'The subtitle operation was stopped.'
      : code === 'subtitleOperationAlreadyActive'
        ? 'This subtitle segment is already being processed.'
        : 'The active subtitle project changed during the operation.';
    super(message);
    this.name = 'SubtitleOperationOwnershipError';
    this.code = code;
  }
}

const readStorage = (key) => {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

const requireText = (value) => (
  typeof value === 'string' && value.length > 0 && value.length <= 8_192
    ? value
    : null
);

const requireSegment = (value) => {
  const start = value?.start;
  const end = value?.end;
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start) {
    throw new TypeError('A valid subtitle operation segment is required');
  }
  return Object.freeze({ start, end });
};

const requireController = (value) => {
  if (!value || typeof value.abort !== 'function'
      || typeof value.signal?.aborted !== 'boolean'
      || typeof value.signal?.addEventListener !== 'function') {
    throw new TypeError('A valid subtitle operation AbortController is required');
  }
  return value;
};

const currentSourceCapture = (cacheId, projectId = null) => {
  if (isDesktopRuntime()) {
    const session = readNativeMediaSession();
    if (session === null
        || session.cacheId !== cacheId
        || (projectId !== null && session.projectId !== projectId)) {
      throw new SubtitleOperationOwnershipError();
    }
    return Object.freeze({
      sourceIdentity: `asset:${session.assetId}`,
      assetId: session.assetId,
      projectId: session.projectId,
    });
  }
  const url = requireText(readStorage('current_video_url'));
  const assetId = requireText(readStorage('current_file_cache_id'));
  if (url && assetId) {
    return Object.freeze({ sourceIdentity: `url:${url}`, assetId });
  }
  if (assetId) {
    return Object.freeze({ sourceIdentity: `asset:${assetId}`, assetId });
  }
  throw new SubtitleOperationOwnershipError();
};

const assertLiveIdentity = ({
  cacheId,
  projectId = null,
  sourceIdentity,
  assetId,
  signal,
}, { allowAborted = false } = {}) => {
  if (!allowAborted && signal.aborted) {
    throw new SubtitleOperationOwnershipError('subtitleOperationAborted');
  }
  if (getRulesCacheId() !== cacheId || getSubtitlesCacheId() !== cacheId) {
    throw new SubtitleOperationOwnershipError();
  }
  const current = currentSourceCapture(cacheId, projectId ?? null);
  if (current.sourceIdentity !== sourceIdentity || current.assetId !== assetId) {
    throw new SubtitleOperationOwnershipError();
  }
};

export const captureSubtitleOperationContext = async ({
  runId,
  segment,
  controller,
}) => {
  const normalizedRunId = requireText(runId);
  if (!normalizedRunId) throw new TypeError('A valid subtitle operation run ID is required');
  const normalizedSegment = requireSegment(segment);
  const ownedController = requireController(controller);
  const cacheId = requireText(getRulesCacheId());
  if (!cacheId || getSubtitlesCacheId() !== cacheId) {
    throw new SubtitleOperationOwnershipError();
  }
  const source = currentSourceCapture(cacheId);
  const { sourceIdentity, assetId } = source;
  const key = `${cacheId}\u0000${sourceIdentity}\u0000${normalizedSegment.start}\u0000${normalizedSegment.end}`;
  if (activeOperations.has(key)) {
    throw new SubtitleOperationOwnershipError('subtitleOperationAlreadyActive');
  }

  const token = Object.freeze({});
  activeOperations.set(key, token);
  const provisional = {
    cacheId,
    sourceIdentity,
    assetId,
    signal: ownedController.signal,
  };
  try {
    assertLiveIdentity(provisional);
    const project = isDesktopRuntime()
      ? await resolveOwnedNativeMediaProject({
        assetId: source.assetId,
        cacheId,
        projectId: source.projectId,
      })
      : await resolveProjectForCache(cacheId, { create: true });
    assertLiveIdentity(provisional);
    if (!requireText(project?.projectId)
        || (source.projectId !== undefined && source.projectId !== project.projectId)) {
      throw new SubtitleOperationOwnershipError();
    }
    const context = Object.freeze({
      kind: CONTEXT_KIND,
      runId: normalizedRunId,
      cacheId,
      projectId: project.projectId,
      sourceIdentity,
      assetId,
      segment: normalizedSegment,
      signal: ownedController.signal,
    });
    contexts.set(context, Object.freeze({ key, token }));
    return context;
  } catch (error) {
    if (activeOperations.get(key) === token) activeOperations.delete(key);
    throw error;
  }
};

export const assertSubtitleOperationCurrent = (context, options = {}) => {
  const ownership = context && typeof context === 'object' ? contexts.get(context) : null;
  if (context?.kind !== CONTEXT_KIND
      || !ownership
      || activeOperations.get(ownership.key) !== ownership.token) {
    throw new SubtitleOperationOwnershipError();
  }
  assertLiveIdentity(context, options);
  return context;
};

export const isSubtitleOperationCurrent = (context, options = {}) => {
  try {
    assertSubtitleOperationCurrent(context, options);
    return true;
  } catch {
    return false;
  }
};

export const assertSubtitleOperationDurable = async (context, options = {}) => {
  assertSubtitleOperationCurrent(context, options);
  if (isDesktopRuntime()) {
    const session = readNativeMediaSession();
    const project = session === null ? null : await resolveOwnedNativeMediaProject(session);
    assertSubtitleOperationCurrent(context, options);
    if (!project?.projectId || project.projectId !== context.projectId) {
      throw new SubtitleOperationOwnershipError();
    }
    return context;
  }
  const project = await resolveProjectForCache(context.cacheId, { create: false });
  assertSubtitleOperationCurrent(context, options);
  if (!project?.projectId || project.projectId !== context.projectId) {
    throw new SubtitleOperationOwnershipError();
  }
  return context;
};

export const finishSubtitleOperationContext = (context) => {
  const ownership = context && typeof context === 'object' ? contexts.get(context) : null;
  if (!ownership) return false;
  contexts.delete(context);
  if (activeOperations.get(ownership.key) === ownership.token) {
    activeOperations.delete(ownership.key);
    return true;
  }
  return false;
};

const waitForTurn = (promise, signal) => {
  if (signal.aborted) {
    return Promise.reject(new SubtitleOperationOwnershipError('subtitleOperationAborted'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      callback();
    };
    const handleAbort = () => finish(() => reject(
      new SubtitleOperationOwnershipError('subtitleOperationAborted')
    ));
    signal.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      () => finish(resolve),
      () => finish(resolve)
    );
  });
};

/**
 * Serialize retry transactions that target the same durable subtitle project.
 * Native work for different projects remains independent, while a second
 * segment in the same project cannot checkpoint or roll back over the first.
 */
export const acquireSubtitleProjectOperationLease = async (context) => {
  assertSubtitleOperationCurrent(context);
  const previous = projectOperationTails.get(context.projectId) ?? Promise.resolve();
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  projectOperationTails.set(context.projectId, tail);
  const cleanupTail = () => {
    if (projectOperationTails.get(context.projectId) === tail) {
      projectOperationTails.delete(context.projectId);
    }
  };
  void tail.then(cleanupTail, cleanupTail);

  try {
    await waitForTurn(previous, context.signal);
    assertSubtitleOperationCurrent(context);
  } catch (error) {
    releaseGate();
    throw error;
  }

  const lease = Object.freeze({
    kind: LEASE_KIND,
    runId: context.runId,
    projectId: context.projectId,
  });
  leases.set(lease, Object.freeze({ context, releaseGate }));
  return lease;
};

export const releaseSubtitleProjectOperationLease = (lease) => {
  const owned = lease && typeof lease === 'object' ? leases.get(lease) : null;
  if (!owned) return false;
  leases.delete(lease);
  owned.releaseGate();
  return true;
};

export const abortableSubtitleOperationDelay = (milliseconds, signal) => {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError('A valid subtitle retry delay is required');
  }
  const aborted = () => {
    const error = new Error('The subtitle operation was stopped.');
    error.name = 'AbortError';
    error.code = 'subtitleOperationAborted';
    return error;
  };
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', handleAbort);
      callback();
    };
    const handleAbort = () => finish(() => reject(aborted()));
    const timer = setTimeout(() => finish(resolve), milliseconds);
    signal?.addEventListener?.('abort', handleAbort, { once: true });
  });
};

export const isSubtitleOperationCancellation = (error, signal = null) => (
  signal?.aborted === true
  || error?.name === 'AbortError'
  || error?.code === 'subtitleOperationAborted'
);
