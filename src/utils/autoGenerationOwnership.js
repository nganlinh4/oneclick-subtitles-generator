import { getCurrentCacheId as getRulesCacheId } from './transcriptionRulesStore';
import {
  getCurrentCacheId as getSubtitlesCacheId,
  subscribeCurrentCacheId,
} from './userSubtitlesStore';
import { resolveProjectForCache } from '../platform/subtitleProjectStore';
import { isDurableSubtitleCheckpointReceipt } from '../services/subtitleCache';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import {
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from '../platform/nativeMediaOwnership';

const AUTO_REQUEST_KIND = 'auto-generation-request';
const PREPARED_MEDIA_KIND = 'auto-prepared-media';
const AUTO_CONTEXT_KIND = 'auto-generation-context';
const COMPLETION_KIND = 'auto-generation-completion';
const autoGenerationCompletions = new WeakSet();
const preparedCacheCandidates = new WeakMap();
const contextCacheCandidates = new WeakMap();

export class AutoGenerationOwnershipError extends Error {
  constructor(code = 'autoGenerationOwnershipLost') {
    super(code === 'autoGenerationAborted'
      ? 'Automatic subtitle generation was stopped.'
      : 'The active media changed during automatic subtitle generation.');
    this.name = 'AutoGenerationOwnershipError';
    this.code = code;
  }
}

const requireText = (value, field) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8_192) {
    throw new TypeError(`A valid automatic-generation ${field} is required`);
  }
  return value;
};

const requireSignal = (value) => {
  if (!value || typeof value !== 'object'
      || typeof value.aborted !== 'boolean'
      || typeof value.addEventListener !== 'function') {
    throw new TypeError('A valid automatic-generation AbortSignal is required');
  }
  return value;
};

export const createAutoGenerationRequest = ({ runId, signal }) => Object.freeze({
  kind: AUTO_REQUEST_KIND,
  runId: requireText(runId, 'run ID'),
  signal: requireSignal(signal),
});

export const isAutoGenerationRequest = (value) => (
  value?.kind === AUTO_REQUEST_KIND
  && typeof value.runId === 'string'
  && typeof value.signal?.aborted === 'boolean'
);

export const sourceIdentityForUrl = (url) => `url:${requireText(url, 'source URL')}`;
export const sourceIdentityForAsset = (assetId) => `asset:${requireText(assetId, 'asset ID')}`;

export const createPreparedAutoMedia = ({
  request,
  media,
  cacheId,
  projectId,
  sourceIdentity,
  cachedSubtitles = null,
}) => {
  if (!isAutoGenerationRequest(request) || !media || typeof media !== 'object') {
    throw new TypeError('A live automatic-generation request and prepared media are required');
  }
  const assetId = typeof media.assetId === 'string' && media.assetId.length > 0
    ? requireText(media.assetId, 'native asset ID')
    : null;
  if (cachedSubtitles !== null && !Array.isArray(cachedSubtitles)) {
    throw new TypeError('An automatic-generation cache candidate must be subtitle rows or null');
  }
  const immutableRows = Array.isArray(cachedSubtitles) && cachedSubtitles.length > 0
    ? Object.freeze(cachedSubtitles.map((row) => Object.freeze({ ...row })))
    : null;
  const prepared = Object.freeze({
    kind: PREPARED_MEDIA_KIND,
    runId: request.runId,
    signal: request.signal,
    media,
    cacheId: requireText(cacheId, 'cache ID'),
    projectId: requireText(projectId, 'project ID'),
    sourceIdentity: requireText(sourceIdentity, 'source identity'),
    assetId,
  });
  preparedCacheCandidates.set(prepared, Object.freeze({
    cacheHit: immutableRows !== null,
    subtitles: immutableRows,
  }));
  return prepared;
};

export const isPreparedAutoMedia = (value) => (
  value?.kind === PREPARED_MEDIA_KIND
  && value.media != null
  && typeof value.signal?.aborted === 'boolean'
);

export const createAutoGenerationContext = (prepared) => {
  if (!isPreparedAutoMedia(prepared)) {
    throw new TypeError('Authoritative prepared media is required for automatic generation');
  }
  const candidate = preparedCacheCandidates.get(prepared);
  if (!candidate) {
    throw new AutoGenerationOwnershipError();
  }
  const context = Object.freeze({
    kind: AUTO_CONTEXT_KIND,
    runId: requireText(prepared.runId, 'run ID'),
    media: prepared.media,
    projectId: requireText(prepared.projectId, 'project ID'),
    cacheId: requireText(prepared.cacheId, 'cache ID'),
    sourceIdentity: requireText(prepared.sourceIdentity, 'source identity'),
    assetId: prepared.assetId === null ? null : requireText(prepared.assetId, 'native asset ID'),
    signal: requireSignal(prepared.signal),
  });
  contextCacheCandidates.set(context, candidate);
  return context;
};

/**
 * Return the immutable cache candidate captured during exact-project media
 * preparation. A structurally similar object cannot inject cached rows because
 * only contexts issued above exist in this private WeakMap.
 */
export const getAutoGenerationCacheCandidate = (context) => {
  const candidate = context && typeof context === 'object'
    ? contextCacheCandidates.get(context)
    : null;
  if (!candidate) throw new AutoGenerationOwnershipError();
  return candidate;
};

export const captureActiveMediaRunContext = async ({ runId, media, signal }) => {
  const request = createAutoGenerationRequest({ runId, signal });
  assertAutoGenerationRequestActive(request);
  const cacheId = getRulesCacheId();
  if (!cacheId || getSubtitlesCacheId() !== cacheId) {
    throw new AutoGenerationOwnershipError();
  }
  const desktop = isDesktopRuntime();
  const capturedSession = desktop ? readNativeMediaSession() : null;
  if (desktop && (capturedSession === null
      || capturedSession.cacheId !== cacheId
      || capturedSession.assetId !== media?.assetId)) {
    throw new AutoGenerationOwnershipError();
  }
  const project = desktop
    ? await resolveOwnedNativeMediaProject(capturedSession)
    : await resolveProjectForCache(cacheId, { create: true });
  if (!project?.projectId) throw new AutoGenerationOwnershipError();
  assertAutoGenerationRequestActive(request);
  if (getRulesCacheId() !== cacheId || getSubtitlesCacheId() !== cacheId) {
    throw new AutoGenerationOwnershipError();
  }
  let sourceIdentity;
  if (desktop) {
    const session = readNativeMediaSession();
    if (session === null
        || session.cacheId !== cacheId
        || session.projectId !== project.projectId
        || session.assetId !== capturedSession.assetId) {
      throw new AutoGenerationOwnershipError();
    }
    sourceIdentity = sourceIdentityForAsset(session.assetId);
  } else {
    const currentUrl = readStorage('current_video_url');
    sourceIdentity = currentUrl
      ? sourceIdentityForUrl(currentUrl)
      : sourceIdentityForAsset(readStorage('current_file_cache_id'));
  }
  return createAutoGenerationContext(createPreparedAutoMedia({
    request,
    media,
    cacheId,
    projectId: project.projectId,
    sourceIdentity,
  }));
};

export const isAutoGenerationContext = (value) => (
  value?.kind === AUTO_CONTEXT_KIND
  && typeof value.runId === 'string'
  && typeof value.cacheId === 'string'
  && typeof value.projectId === 'string'
  && (value.assetId === null || typeof value.assetId === 'string')
  && value.media != null
  && value.signal != null
);

const readStorage = (key) => {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
};

export const assertAutoGenerationRequestActive = (request) => {
  if (!request || request.signal?.aborted) {
    throw new AutoGenerationOwnershipError('autoGenerationAborted');
  }
};

export const assertAutoGenerationContextCurrent = (context) => {
  if (!isAutoGenerationContext(context)) {
    throw new AutoGenerationOwnershipError();
  }
  if (context.signal.aborted) {
    throw new AutoGenerationOwnershipError('autoGenerationAborted');
  }
  if (getRulesCacheId() !== context.cacheId || getSubtitlesCacheId() !== context.cacheId) {
    throw new AutoGenerationOwnershipError();
  }

  if (isDesktopRuntime()) {
    const session = readNativeMediaSession();
    if (context.assetId === null
        || session === null
        || session.assetId !== context.assetId
        || session.cacheId !== context.cacheId
        || session.projectId !== context.projectId) {
      throw new AutoGenerationOwnershipError();
    }
    return context;
  }

  const currentUrl = readStorage('current_video_url');
  if (context.sourceIdentity.startsWith('url:')) {
    if (`url:${currentUrl ?? ''}` !== context.sourceIdentity) {
      throw new AutoGenerationOwnershipError();
    }
  } else if (context.sourceIdentity.startsWith('asset:')) {
    if (currentUrl !== null
        || `asset:${readStorage('current_file_cache_id') ?? ''}` !== context.sourceIdentity) {
      throw new AutoGenerationOwnershipError();
    }
  } else {
    throw new AutoGenerationOwnershipError();
  }

  if (context.assetId !== null
      && readStorage('current_file_cache_id') !== context.assetId) {
    throw new AutoGenerationOwnershipError();
  }
  return context;
};

/**
 * Re-resolve the captured alias and prove it still identifies the same durable
 * project. Use this directly next to native registration and durable writes;
 * the synchronous check alone cannot observe an alias remap.
 */
export const assertAutoGenerationContextDurable = async (context) => {
  assertAutoGenerationContextCurrent(context);
  if (isDesktopRuntime()) {
    const session = readNativeMediaSession();
    const project = session === null ? null : await resolveOwnedNativeMediaProject(session);
    assertAutoGenerationContextCurrent(context);
    if (!project?.projectId || project.projectId !== context.projectId) {
      throw new AutoGenerationOwnershipError();
    }
    return context;
  }
  const project = await resolveProjectForCache(context.cacheId, { create: false });
  assertAutoGenerationContextCurrent(context);
  if (!project?.projectId || project.projectId !== context.projectId) {
    throw new AutoGenerationOwnershipError();
  }
  return context;
};

/**
 * Keep the owning AbortController informed while native work is in flight.
 * Cache changes are synchronous subscriptions; source-only changes are also
 * checked on storage notifications and a short-lived active-run watchdog.
 */
export const subscribeAutoGenerationOwnership = (
  context,
  onLost,
  { pollIntervalMs = 50 } = {}
) => {
  if (!isAutoGenerationContext(context) || typeof onLost !== 'function'
      || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 1_000) {
    throw new TypeError('A valid automatic-generation ownership subscription is required');
  }
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    unsubscribeCache();
    globalThis.removeEventListener?.('storage', check);
    context.signal.removeEventListener('abort', stop);
  };
  const lose = (error) => {
    if (stopped) return;
    stop();
    try { onLost(error); } catch { /* an owner callback cannot revive a stale run */ }
  };
  const check = () => {
    if (stopped) return;
    try {
      assertAutoGenerationContextCurrent(context);
    } catch (error) {
      lose(error);
    }
  };
  const unsubscribeCache = subscribeCurrentCacheId(check);
  const timer = setInterval(check, pollIntervalMs);
  globalThis.addEventListener?.('storage', check);
  context.signal.addEventListener('abort', stop, { once: true });
  check();
  return stop;
};

export const createAutoGenerationCompletion = ({
  context,
  terminal,
  checkpoint,
}) => {
  assertAutoGenerationContextCurrent(context);
  if (terminal !== 'subtitles' && terminal !== 'no-speech') {
    throw new TypeError('A reviewed automatic-generation terminal state is required');
  }
  if (!isDurableSubtitleCheckpointReceipt(checkpoint, context)) {
    throw new AutoGenerationOwnershipError();
  }
  const { subtitleCount, projectId, cacheId } = checkpoint;
  if (!Number.isSafeInteger(subtitleCount) || subtitleCount < 0
      || (terminal === 'subtitles' && subtitleCount === 0)
      || (terminal === 'no-speech' && subtitleCount !== 0)
      || projectId !== context.projectId
      || cacheId !== context.cacheId) {
    throw new AutoGenerationOwnershipError();
  }
  const completion = Object.freeze({
    kind: COMPLETION_KIND,
    runId: context.runId,
    terminal,
    subtitleCount,
    projectId,
    cacheId,
  });
  autoGenerationCompletions.add(completion);
  return completion;
};

export const isAutoGenerationCompletion = (value, context) => (
  value !== null
  && typeof value === 'object'
  && autoGenerationCompletions.has(value)
  && value.kind === COMPLETION_KIND
  && isAutoGenerationContext(context)
  && value.runId === context.runId
  && value.projectId === context.projectId
  && value.cacheId === context.cacheId
  && (
    (value.terminal === 'subtitles' && Number.isSafeInteger(value.subtitleCount) && value.subtitleCount > 0)
    || (value.terminal === 'no-speech' && value.subtitleCount === 0)
  )
);

export const isAutoGenerationCancellation = (error, signal = null) => (
  signal?.aborted === true
  || error?.code === 'autoGenerationAborted'
  || error?.code === 'autoGenerationOwnershipLost'
  || error?.name === 'AbortError'
);
