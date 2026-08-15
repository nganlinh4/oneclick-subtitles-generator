import {
  cancelDownload,
  inspectDownloadUrl,
  startDownload,
} from './downloadService';
import {
  claimMediaCandidate,
  discardMediaCandidate,
  openMediaAsset,
} from './mediaService';
import { activateResolvedMediaProject } from './mediaProjectActivation';
import { recoverNativeDownloaderAfterFailure } from './nativeDownloadPreflight';
import { DOWNLOAD_COOKIE_SOURCES } from './downloadCookiePreference';
import { resolveProjectForCache } from './subtitleProjectStore';
import { generateUrlBasedCacheId } from '../services/subtitleCache';

const DEFAULT_MEDIA_SELECTION = Object.freeze({
  kind: 'video',
  quality: Object.freeze({ mode: 'best' }),
});
const MAX_PREFERRED_SUBTITLE_LANGUAGES = 32;
const MAX_URL_CHARACTERS = 8_192;
const MAX_EXECUTION_ATTEMPTS = 2;
const MAX_COMPLETED_ASSETS = 32;
const MAX_COMPLETED_ASSET_BYTES = 16 * 1024 * 1024;
const cookieSources = new Set(DOWNLOAD_COOKIE_SOURCES);
const requestKeys = Object.freeze([
  'url',
  'cookieSource',
  'onStarted',
  'onProgress',
  'onSubtitle',
  'preferredSubtitleLanguages',
  'signal',
  'validateOwnership',
]);

const utf8ByteLength = (value) => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};

const subtitleByteLength = (subtitle) => {
  if (subtitle === null) return 0;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(subtitle);
    return ['filename', 'language', 'content'].reduce((total, key) => {
      const descriptor = descriptors[key];
      return total + (descriptor && Object.hasOwn(descriptor, 'value')
        && typeof descriptor.value === 'string'
        ? utf8ByteLength(descriptor.value)
        : 0);
    }, 0);
  } catch {
    return MAX_COMPLETED_ASSET_BYTES + 1;
  }
};

const progressPercent = (event) => {
  const basisPoints = event.job.progress.basisPoints;
  const percent = Math.round(basisPoints / 100);
  return Math.max(0, Math.min(100, percent));
};

const fixedFailure = (code = 'nativeDownloadFailed') => {
  const error = new Error('The native media download could not be completed');
  error.name = 'NativeUrlDownloadError';
  error.code = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(code)
    ? code
    : 'nativeDownloadFailed';
  return error;
};

const abortedFailure = () => {
  const error = new Error('The native media download was cancelled');
  error.name = 'AbortError';
  error.code = 'nativeDownloadAborted';
  return error;
};

const checkListenerState = (listener) => {
  if (listener.settled) {
    throw listener.settlementError ?? abortedFailure();
  }
  if (listener.aborted) throw abortedFailure();
};

const assertListenerLive = async (listener) => {
  checkListenerState(listener);
  if (typeof listener.validateOwnership === 'function') {
    await Promise.resolve(listener.validateOwnership());
  }
  checkListenerState(listener);
};

const replayListenerCallback = async (listener, callbackName, value) => {
  await assertListenerLive(listener);
  const callback = listener[callbackName];
  if (typeof callback === 'function') {
    try {
      await Promise.resolve(callback(value));
    } catch {
      throw fixedFailure('downloadCallbackFailed');
    }
  }
  await assertListenerLive(listener);
};

const normalizePreferredLanguages = (languages) => {
  if (languages === undefined) return Object.freeze([]);
  let values;
  try {
    if (!Array.isArray(languages)) throw fixedFailure('invalidDownloadRequest');
    const descriptors = Object.getOwnPropertyDescriptors(languages);
    const length = descriptors.length;
    if (!length || !Object.hasOwn(length, 'value')
        || !Number.isSafeInteger(length.value)
        || length.value < 0 || length.value > MAX_PREFERRED_SUBTITLE_LANGUAGES
        || Reflect.ownKeys(descriptors).length !== length.value + 1) {
      throw fixedFailure('invalidDownloadRequest');
    }
    values = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw fixedFailure('invalidDownloadRequest');
      }
      values.push(descriptor.value);
    }
  } catch {
    throw fixedFailure('invalidDownloadRequest');
  }
  const normalized = values.map((language) => {
    if (typeof language !== 'string' || !/^[A-Za-z0-9._-]{1,35}$/.test(language)) {
      throw fixedFailure('invalidDownloadRequest');
    }
    return language.toLowerCase();
  });
  return Object.freeze([...new Set(normalized)]);
};

const snapshotDownloadRequest = (request) => {
  try {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      throw fixedFailure('invalidDownloadRequest');
    }
    const prototype = Object.getPrototypeOf(request);
    if (prototype !== Object.prototype && prototype !== null) {
      throw fixedFailure('invalidDownloadRequest');
    }
    const descriptors = Object.getOwnPropertyDescriptors(request);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string' || !requestKeys.includes(key))
        || !Object.hasOwn(descriptors, 'url')
        || !Object.hasOwn(descriptors, 'cookieSource')) {
      throw fixedFailure('invalidDownloadRequest');
    }
    const snapshot = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw fixedFailure('invalidDownloadRequest');
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw fixedFailure('invalidDownloadRequest');
  }
};

const normalizeUrl = (url) => {
  if (typeof url !== 'string'
      || url.length === 0
      || url.length > MAX_URL_CHARACTERS
      || url.includes('\\')
      || Array.from(url).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint <= 31 || codePoint === 127;
      })) {
    throw fixedFailure('invalidDownloadRequest');
  }
  return url;
};

const snapshotSignal = (signal) => {
  if (signal === undefined) return null;
  try {
    if (signal === null || (typeof signal !== 'object' && typeof signal !== 'function')) {
      throw fixedFailure('invalidDownloadRequest');
    }
    const add = Reflect.get(signal, 'addEventListener');
    const remove = Reflect.get(signal, 'removeEventListener');
    if (typeof add !== 'function' || typeof remove !== 'function') {
      throw fixedFailure('invalidDownloadRequest');
    }
    return Object.freeze({ add, remove, target: signal });
  } catch {
    throw fixedFailure('invalidDownloadRequest');
  }
};

const normalizeCallback = (callback) => {
  if (callback !== undefined && typeof callback !== 'function') {
    throw fixedFailure('invalidDownloadRequest');
  }
  return callback;
};

const normalizeCookieSource = (cookieSource) => {
  if (typeof cookieSource !== 'string' || !cookieSources.has(cookieSource)) {
    throw fixedFailure('invalidDownloadRequest');
  }
  return cookieSource;
};

const selectSubtitle = (inventory, preferredLanguages) => {
  if (preferredLanguages.length === 0 || !Array.isArray(inventory?.subtitles)) return null;
  for (const preferred of preferredLanguages) {
    const preferredBase = preferred.split('-')[0];
    const candidates = inventory.subtitles.filter(({ language }) => {
      const normalized = language.toLowerCase();
      return normalized === preferred
        || normalized.split('-')[0] === preferredBase;
    });
    candidates.sort((left, right) => {
      if (left.source === right.source) return 0;
      return left.source === 'manual' ? -1 : 1;
    });
    if (candidates[0]) {
      return Object.freeze({
        language: candidates[0].language,
        source: candidates[0].source,
      });
    }
  }
  return null;
};

const operationKey = (url, cookieSource, preferredLanguages) => (
  `${cookieSource}\u0000${preferredLanguages.join(',')}\u0000${url}`
);

const resolveCandidateProjectForUrl = async (url) => {
  const cacheId = await generateUrlBasedCacheId(url);
  if (typeof cacheId !== 'string' || cacheId.length === 0) {
    throw fixedFailure('mediaCandidateProjectFailed');
  }
  return resolveProjectForCache(cacheId, { create: true });
};

export const createNativeUrlDownloadAdapter = ({
  inspect = inspectDownloadUrl,
  start = startDownload,
  cancel = cancelDownload,
  openAsset = openMediaAsset,
  claimCandidate = claimMediaCandidate,
  discardCandidate = discardMediaCandidate,
  resolveCandidateProject = resolveCandidateProjectForUrl,
  activateProject = activateResolvedMediaProject,
  recoverDownloader = recoverNativeDownloaderAfterFailure,
} = {}) => {
  const active = new Map();
  const completedAssets = new Map();
  let completedAssetBytes = 0;

  const deleteCompletedAsset = (key) => {
    const completed = completedAssets.get(key);
    if (completed === undefined) return;
    completedAssets.delete(key);
    completedAssetBytes -= completed.cacheBytes;
  };

  const rememberCompletedAsset = (key, assetId, subtitle) => {
    deleteCompletedAsset(key);
    const cacheBytes = utf8ByteLength(key)
      + utf8ByteLength(assetId)
      + subtitleByteLength(subtitle);
    if (cacheBytes > MAX_COMPLETED_ASSET_BYTES) return;
    completedAssets.set(key, Object.freeze({ assetId, subtitle, cacheBytes }));
    completedAssetBytes += cacheBytes;
    while (completedAssets.size > MAX_COMPLETED_ASSETS
        || completedAssetBytes > MAX_COMPLETED_ASSET_BYTES) {
      const oldestKey = completedAssets.keys().next().value;
      deleteCompletedAsset(oldestKey);
    }
  };

  const readCompletedAsset = (key) => {
    const completed = completedAssets.get(key);
    if (completed === undefined) return undefined;
    completedAssets.delete(key);
    completedAssets.set(key, completed);
    return completed;
  };

  const attachAbortBinding = (listener, signalBinding, onAbort) => {
    if (signalBinding === null) return;
    try {
      signalBinding.add.call(signalBinding.target, 'abort', onAbort, { once: true });
      listener.signalAttached = true;
      const isAborted = Reflect.get(signalBinding.target, 'aborted');
      if (typeof isAborted !== 'boolean') throw fixedFailure('invalidDownloadRequest');
      if (isAborted) onAbort();
    } catch {
      if (listener.signalAttached) listener.signalAttached = false;
      try {
        signalBinding.remove.call(signalBinding.target, 'abort', onAbort);
      } catch {
        // Registration rollback remains authoritative.
      }
      throw fixedFailure('invalidDownloadRequest');
    }
  };

  /**
   * Reopen an asset this adapter already downloaded for the same request key. Returns the frozen
   * native media, or null when the cached capability is gone and the caller must download again.
   */
  const reopenCompletedAsset = async (key, url, completed, {
    onStarted,
    onProgress,
    onSubtitle,
    signalBinding,
    validateOwnership,
  }) => {
    const listener = {
      aborted: false,
      handleAbort: null,
      onProgress,
      onStarted,
      onSubtitle,
      settlementError: null,
      settled: false,
      signalAttached: false,
      signalBinding,
      validateOwnership,
    };
    let resolveAbort;
    const aborted = new Promise((resolve) => { resolveAbort = resolve; });
    listener.handleAbort = () => {
      listener.aborted = true;
      resolveAbort(null);
    };
    attachAbortBinding(listener, signalBinding, listener.handleAbort);

    let media;
    let opened = false;
    let activation = null;
    try {
      try {
        await assertListenerLive(listener);
        // The cached asset is owned by the project this URL resolves to, and the native open
        // requires that project to be active. A publication failure says nothing about the
        // capability itself, so it must not evict a download this adapter already paid for.
        activation = await activateProject(await resolveCandidateProject(url), {
          validateOwnership: () => assertListenerLive(listener),
        });
      } catch {
        // activateProject withdraws its own publication before it rejects, so only the
        // subscriber's own abort/ownership loss may replace this fixed failure.
        await assertListenerLive(listener);
        throw fixedFailure('mediaCandidateProjectFailed');
      }
      try {
        const opening = Promise.resolve().then(() => openAsset(completed.assetId));
        if (signalBinding === null) media = await opening;
        else {
          const race = await Promise.race([
            opening.then((value) => Object.freeze({ value })),
            aborted,
          ]);
          if (race === null) throw abortedFailure();
          media = race.value;
        }
        opened = true;
      } catch {
        activation.release();
        activation = null;
        // Subscriber cancellation/ownership loss during the native open is
        // local to that subscriber. Only a genuine open failure invalidates the
        // shared completed-asset capability.
        await assertListenerLive(listener);
        deleteCompletedAsset(key);
      }
      if (!opened) return null;
      try {
        await replayListenerCallback(listener, 'onProgress', 100);
        if (completed.subtitle !== null) {
          await replayListenerCallback(listener, 'onSubtitle', completed.subtitle);
        }
        await assertListenerLive(listener);
      } catch (error) {
        activation.release();
        throw error;
      }
      return Object.freeze({ media });
    } finally {
      if (listener.signalAttached) {
        listener.signalAttached = false;
        try {
          signalBinding.remove.call(signalBinding.target, 'abort', listener.handleAbort);
        } catch {
          // Cleanup failure cannot replace the cached-open outcome.
        }
      }
    }
  };

  const settleListener = (operation, listener, outcome, value) => {
    if (listener.settled) return;
    listener.settled = true;
    listener.settlementError = outcome === 'reject' ? value : null;
    operation.listeners.delete(listener);
    if (listener.signalAttached) {
      listener.signalAttached = false;
      try {
        listener.signalBinding.remove.call(
          listener.signalBinding.target,
          'abort',
          listener.handleAbort
        );
      } catch {
        // Cleanup failure cannot prevent exact promise settlement.
      }
    }
    if (outcome === 'resolve') listener.resolve(value);
    else listener.reject(value);
  };

  const settleAll = async (operation, outcome, value) => {
    for (const listener of [...operation.listeners]) {
      try {
        await assertListenerLive(listener);
        settleListener(operation, listener, outcome, value);
      } catch (error) {
        settleListener(operation, listener, 'reject', error);
      }
    }
  };

  const requestOperationCancel = (operation) => {
    if (operation.jobId === null) {
      // Inspection has no native job to cancel. If registration itself is in flight, remember the
      // request until the ID arrives; a new live subscriber may still join and clear it first.
      operation.cancelRequested = operation.registrationStarted;
      return;
    }
    operation.cancelRequested = true;
    operation.settleOrphan?.();
    if (operation.cancelInvoked) return;
    operation.cancelInvoked = true;
    operation.accepting = false;
    if (active.get(operation.key) === operation) active.delete(operation.key);
    void cancel(operation.jobId).catch(() => undefined);
  };

  const subscribe = (
    operation,
    { onStarted, onProgress, onSubtitle, signalBinding, validateOwnership }
  ) => {
    let listener;
    const promise = new Promise((resolve, reject) => {
      listener = {
        aborted: false,
        handleAbort: null,
        onProgress,
        onStarted,
        onSubtitle,
        reject,
        resolve,
        settlementError: null,
        settled: false,
        signalAttached: false,
        signalBinding,
        validateOwnership,
      };
      listener.handleAbort = () => {
        listener.aborted = true;
        settleListener(operation, listener, 'reject', abortedFailure());
        if (operation.listeners.size === 0) {
          requestOperationCancel(operation);
        }
      };
      operation.listeners.add(listener);
      if (operation.jobId === null && operation.registrationStarted) {
        operation.cancelRequested = false;
      }
      if (signalBinding !== null) {
        try {
          attachAbortBinding(listener, signalBinding, listener.handleAbort);
        } catch (error) {
          settleListener(operation, listener, 'reject', error);
          return;
        }
        if (listener.settled) {
          if (listener.signalAttached) {
            listener.signalAttached = false;
            try {
              signalBinding.remove.call(signalBinding.target, 'abort', listener.handleAbort);
            } catch {
              // Settlement is already authoritative.
            }
          }
          return;
        }
      }
      Promise.resolve().then(async () => {
        if (operation.jobId !== null) {
          await replayListenerCallback(listener, 'onStarted', operation.jobId);
        }
        if (operation.percent !== null) {
          await replayListenerCallback(listener, 'onProgress', operation.percent);
        }
        if (operation.subtitle !== null) {
          await replayListenerCallback(listener, 'onSubtitle', operation.subtitle);
        }
      }).catch((error) => {
        settleListener(operation, listener, 'reject', error);
        if (operation.listeners.size === 0) requestOperationCancel(operation);
      });
      });
    promise.catch(() => undefined);
    return Object.freeze({
      listener,
      promise,
      registered: !listener.settled,
    });
  };

  const revalidateListeners = async (operation, { cancelIfEmpty = false } = {}) => {
    for (const listener of [...operation.listeners]) {
      try {
        await assertListenerLive(listener);
      } catch (error) {
        settleListener(operation, listener, 'reject', error);
      }
    }
    if (cancelIfEmpty && operation.listeners.size === 0) requestOperationCancel(operation);
    return operation.listeners.size > 0;
  };

  const publishToLiveListeners = async (operation, callbackName, value) => {
    if (!await revalidateListeners(operation, { cancelIfEmpty: true })) return false;
    for (const listener of [...operation.listeners]) {
      try {
        await replayListenerCallback(listener, callbackName, value);
      } catch (error) {
        settleListener(operation, listener, 'reject', error);
      }
    }
    if (operation.listeners.size === 0) {
      requestOperationCancel(operation);
      return false;
    }
    return true;
  };

  const createOperation = (key, url, cookieSource, preferredLanguages) => {
    const operation = {
      accepting: true,
      cancelInvoked: false,
      discardedCandidateIds: new Set(),
      eventChain: Promise.resolve(),
      jobId: null,
      key,
      listeners: new Set(),
      percent: null,
      promise: null,
      registrationStarted: false,
      subtitle: null,
      cancelRequested: false,
      settleOrphan: null,
    };

    const candidateAssetId = (candidate) => {
      try {
        const candidateDescriptors = Object.getOwnPropertyDescriptors(candidate);
        const asset = candidateDescriptors.asset;
        if (!asset || !Object.hasOwn(asset, 'value')
            || asset.value === null || typeof asset.value !== 'object') {
          throw fixedFailure('invalidDownloadResponse');
        }
        const assetDescriptors = Object.getOwnPropertyDescriptors(asset.value);
        const id = assetDescriptors.id;
        if (!id || !Object.hasOwn(id, 'value') || typeof id.value !== 'string') {
          throw fixedFailure('invalidDownloadResponse');
        }
        return id.value;
      } catch {
        throw fixedFailure('invalidDownloadResponse');
      }
    };

    const discardCandidateOnce = async (candidate) => {
      const assetId = candidateAssetId(candidate);
      if (operation.discardedCandidateIds.has(assetId)) return;
      operation.discardedCandidateIds.add(assetId);
      try {
        await Promise.resolve(discardCandidate(assetId));
      } catch {
        throw fixedFailure('mediaCandidateDiscardFailed');
      }
    };

    // Ownership hook for steps which must fail closed rather than return a boolean. Losing
    // subscribers are settled with their own abort/ownership error before this throws.
    const assertOperationOwned = async () => {
      if (!await revalidateListeners(operation, { cancelIfEmpty: true })) {
        throw fixedFailure('mediaCandidateOwnershipLost');
      }
    };

    const enqueueEvent = (task) => {
      const queued = operation.eventChain.then(task);
      operation.eventChain = queued.catch(() => undefined);
      return queued;
    };

    const runAttempt = async () => {
      if (!await revalidateListeners(operation, { cancelIfEmpty: true })) {
        return { kind: 'orphaned' };
      }
      const inspection = await inspect({ url, cookieSource });
      if (!await revalidateListeners(operation, { cancelIfEmpty: true })) {
        return { kind: 'orphaned' };
      }
      const subtitle = selectSubtitle(inspection.inventory, preferredLanguages);
      let resolveTerminal;
      let terminal = null;
      const terminalPromise = new Promise((resolve) => { resolveTerminal = resolve; });
      const settle = (outcome) => {
        if (terminal !== null) return;
        terminal = outcome;
        resolveTerminal(outcome);
      };
      operation.settleOrphan = () => settle({ kind: 'orphaned' });

      let initial;
      // Inspection is asynchronous. Prune aborted or stale subscribers independently immediately
      // before native registration; a bad automatic run must not poison a live manual subscriber.
      if (!await revalidateListeners(operation, { cancelIfEmpty: true })) {
        operation.settleOrphan = null;
        return { kind: 'orphaned' };
      }
      try {
        operation.registrationStarted = true;
        initial = await start({
          inventoryId: inspection.capability.id,
          media: DEFAULT_MEDIA_SELECTION,
          subtitle,
        }, {
          onProgress: (event) => enqueueEvent(async () => {
            const next = progressPercent(event);
            operation.percent = operation.percent === null
              ? next
              : Math.max(operation.percent, next);
            await publishToLiveListeners(operation, 'onProgress', operation.percent);
          }),
          onCompleted: (event) => enqueueEvent(async () => {
            const candidate = event.media;
            try {
              if (!await revalidateListeners(operation, { cancelIfEmpty: true })) {
                await discardCandidateOnce(candidate);
                return;
              }
              operation.subtitle = event.subtitle ?? null;
              if (operation.subtitle !== null
                  && !await publishToLiveListeners(
                    operation,
                    'onSubtitle',
                    operation.subtitle
                  )) {
                await discardCandidateOnce(candidate);
                return;
              }
              // Resolving creates the durable project on demand, so never resolve for an
              // operation which has already lost every subscriber.
              if (!await revalidateListeners(operation, { cancelIfEmpty: true })) {
                await discardCandidateOnce(candidate);
                return;
              }
              // projectService storage operations stay detached. Publish the exact resolved
              // project here, revalidating ownership around the publication, because the claim
              // below requires that project to be active before and after every native step.
              const activation = await activateProject(
                await resolveCandidateProject(url),
                { validateOwnership: assertOperationOwned }
              );
              let media;
              try {
                media = await claimCandidate(candidate, activation.claimOptions);
              } catch (error) {
                activation.release();
                throw error;
              }
              settle({
                kind: 'completed',
                media,
                assetId: candidateAssetId(candidate),
                subtitle: operation.subtitle,
              });
            } catch {
              try {
                await discardCandidateOnce(candidate);
                settle({ kind: 'failed', error: fixedFailure('mediaOpenFailed') });
              } catch (discardError) {
                settle({ kind: 'failed', error: discardError });
              }
            }
          }),
          onCancelled: () => enqueueEvent(async () => {
            if (!await revalidateListeners(operation, { cancelIfEmpty: true })) return;
            settle({ kind: 'cancelled' });
          }),
          onFailed: (event) => enqueueEvent(async () => {
            if (!await revalidateListeners(operation, { cancelIfEmpty: true })) return;
            settle({
              kind: 'failed',
              error: fixedFailure(event.error.code),
            });
          }),
          onProtocolError: () => enqueueEvent(async () => {
            if (!await revalidateListeners(operation, { cancelIfEmpty: true })) return;
            settle({
              kind: 'protocolError',
              error: fixedFailure('invalidDownloadResponse'),
            });
          }),
        });
      } catch (error) {
        operation.registrationStarted = false;
        throw fixedFailure(error?.code);
      }

      operation.jobId = initial.id;
      operation.registrationStarted = false;
      await publishToLiveListeners(operation, 'onStarted', initial.id);
      if (operation.cancelRequested || operation.listeners.size === 0) {
        requestOperationCancel(operation);
        operation.settleOrphan = null;
        return { kind: 'orphaned' };
      }

      const outcome = await terminalPromise;
      operation.settleOrphan = null;
      return outcome;
    };

    const runOperation = async () => {
      for (let attempt = 1; attempt <= MAX_EXECUTION_ATTEMPTS; attempt += 1) {
        let outcome;
        try {
          outcome = await runAttempt();
        } catch (error) {
          if (error?.name === 'AbortError'
              || error?.code === 'autoGenerationOwnershipLost'
              || error?.code === 'autoGenerationAborted') {
            throw error;
          }
          outcome = { kind: 'failed', error: fixedFailure(error?.code) };
        }
        if (outcome.kind === 'orphaned') return null;
        if (outcome.kind === 'completed') {
          if (!await revalidateListeners(operation, { cancelIfEmpty: true })) return null;
          rememberCompletedAsset(key, outcome.assetId, outcome.subtitle);
          return outcome.media;
        }
        if (outcome.kind === 'cancelled') return null;
        if (outcome.kind === 'protocolError') throw outcome.error;
        if (outcome.error.code !== 'downloaderExecutionFailed'
            || attempt === MAX_EXECUTION_ATTEMPTS) {
          throw outcome.error;
        }

        // A failed native attempt is staged in a temporary directory and cannot publish a
        // partial asset. Re-resolve the managed downloader, inspect again to obtain a fresh
        // capability, and retry the complete operation once. This covers transient extractor,
        // CDN, and process failures without ever duplicating a successful download.
        const recovery = await Promise.resolve(recoverDownloader())
          .catch(() => ({ updated: false }));
        if (recovery?.updated !== true) throw outcome.error;
        operation.jobId = null;
        operation.cancelInvoked = false;
        operation.cancelRequested = false;
        operation.registrationStarted = false;
        operation.percent = 0;
        await publishToLiveListeners(operation, 'onProgress', 0);
      }
      throw fixedFailure('nativeDownloadFailed');
    };

    operation.start = () => {
      if (operation.promise !== null) return;
      // Defer one microtask so every synchronous caller can subscribe before inspection begins.
      operation.promise = Promise.resolve()
        .then(runOperation)
        .then(
          (value) => settleAll(operation, 'resolve', value),
          (error) => settleAll(operation, 'reject', error)
        )
        .finally(() => {
          operation.accepting = false;
          if (active.get(key) === operation) active.delete(key);
        });
    };

    return operation;
  };

  const downloadVideo = (request) => {
    const execution = (async () => {
    const requestSnapshot = snapshotDownloadRequest(request);
    const {
      url,
      cookieSource: requestedCookieSource,
      onStarted,
      onProgress,
      onSubtitle,
      preferredSubtitleLanguages,
      signal,
      validateOwnership,
    } = requestSnapshot;
    const normalizedUrl = normalizeUrl(url);
    const normalizedOnStarted = normalizeCallback(onStarted);
    const normalizedOnProgress = normalizeCallback(onProgress);
    const normalizedOnSubtitle = normalizeCallback(onSubtitle);
    const normalizedOwnership = normalizeCallback(validateOwnership);
    const signalBinding = snapshotSignal(signal);
    const cookieSource = normalizeCookieSource(requestedCookieSource);
    const preferredLanguages = normalizePreferredLanguages(preferredSubtitleLanguages);
    const key = operationKey(normalizedUrl, cookieSource, preferredLanguages);
    const completed = readCompletedAsset(key);
    if (completed) {
      const reopened = await reopenCompletedAsset(key, normalizedUrl, completed, {
        onStarted: normalizedOnStarted,
        onProgress: normalizedOnProgress,
        onSubtitle: normalizedOnSubtitle,
        signalBinding,
        validateOwnership: normalizedOwnership,
      });
      if (reopened !== null) return reopened.media;
    }

    const existing = active.get(key);
    const reused = existing?.accepting === true;
    const operation = reused
      ? existing
      : createOperation(key, normalizedUrl, cookieSource, preferredLanguages);
    const subscription = subscribe(operation, {
      onStarted: normalizedOnStarted,
      onProgress: normalizedOnProgress,
      onSubtitle: normalizedOnSubtitle,
      signalBinding,
      validateOwnership: normalizedOwnership,
    });
    if (subscription.registered && !reused) active.set(key, operation);
    if (subscription.registered) {
      try {
        await assertListenerLive(subscription.listener);
      } catch (error) {
        settleListener(operation, subscription.listener, 'reject', error);
      }
    }
    if (!subscription.registered || subscription.listener.settled) {
      if (!reused && operation.listeners.size === 0 && active.get(key) === operation) {
        active.delete(key);
      }
      return subscription.promise;
    }
    operation.start();
      return subscription.promise;
    })();
    execution.catch(() => undefined);
    return execution;
  };

  return Object.freeze({ downloadVideo });
};

const nativeUrlDownloadAdapter = createNativeUrlDownloadAdapter();

export const downloadNativeVideo = nativeUrlDownloadAdapter.downloadVideo;
