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
import { recoverNativeDownloaderAfterFailure } from './nativeDownloadPreflight';
import {
  isSubtitleProjectBindingReceipt,
  rollbackSubtitleProjectBinding,
} from './subtitleProjectBinding';
import {
  abortedFailure,
  candidateAssetId,
  fixedFailure,
  normalizeCallback,
  normalizeCookieSource,
  normalizePreferredLanguages,
  normalizeUrl,
  progressPercent,
  selectSubtitle,
  snapshotDownloadRequest,
  snapshotSignal,
} from './nativeUrlDownloadContract';
import {
  assertListenerLive,
  attachAbortBinding,
  detachAbortBinding,
  replayListenerCallback,
} from './nativeUrlDownloadSubscriber';
import { createCompletedAssetCache } from './nativeUrlDownloadCache';
import { createCompletedAssetReopener } from './nativeUrlDownloadReopen';
import { resolveProjectForCache } from './subtitleProjectStore';
import { generateUrlBasedCacheId } from '../services/subtitleCache';

const DEFAULT_MEDIA_SELECTION = Object.freeze({
  kind: 'video',
  quality: Object.freeze({ mode: 'best' }),
});
const MAX_EXECUTION_ATTEMPTS = 2;

// The operation identity: two requests share a download only when their URL, explicit browser
// source and preferred subtitle languages all match. The separator cannot occur in any of them.
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
  // Kept injectable for the legacy adapter contract tests. The production singleton below passes
  // no legacy activator, so shipping callers must provide the project-bound transaction callbacks.
  activateProject = null,
  recoverDownloader = recoverNativeDownloaderAfterFailure,
} = {}) => {
  const active = new Map();
  const completedAssets = createCompletedAssetCache();
  const reopenCompletedAsset = typeof activateProject === 'function'
    ? createCompletedAssetReopener({
      activateProject,
      forgetCompletedAsset: completedAssets.forget,
      openAsset,
      resolveCandidateProject,
    })
    : null;

  const settleListener = (operation, listener, outcome, value) => {
    if (listener.settled) return;
    listener.settled = true;
    listener.settlementError = outcome === 'reject' ? value : null;
    operation.listeners.delete(listener);
    detachAbortBinding(listener);
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
    {
      admitActivation,
      onStarted,
      onProgress,
      onSubtitle,
      publishActivation,
      rollbackActivation,
      signalBinding,
      validateOwnership,
    }
  ) => {
    let listener;
    const promise = new Promise((resolve, reject) => {
      listener = {
        aborted: false,
        admitActivation,
        handleAbort: null,
        onProgress,
        onStarted,
        onSubtitle,
        publishActivation,
        reject,
        resolve,
        rollbackActivation,
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
        // An already-aborted signal settles the subscriber synchronously during attachment.
        if (listener.settled) {
          detachAbortBinding(listener);
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

    const discardCandidateOnce = async (candidate) => {
      const assetId = candidateAssetId(candidate);
      if (operation.discardedCandidateIds.has(assetId)) return;
      try {
        const discarded = await Promise.resolve(discardCandidate(assetId));
        if (discarded !== true) throw fixedFailure('mediaCandidateDiscardFailed');
        operation.discardedCandidateIds.add(assetId);
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

    const transactionalOwner = () => (
      [...operation.listeners].find((listener) => (
        typeof listener.admitActivation === 'function'
        && typeof listener.publishActivation === 'function'
        && typeof listener.rollbackActivation === 'function'
        && typeof listener.validateOwnership === 'function'
      )) ?? null
    );

    const enqueueEvent = (task) => {
      const queued = operation.eventChain.then(task);
      operation.eventChain = queued.catch(() => undefined);
      return queued;
    };

    const claimCompletedCandidate = async (event, settle) => {
      const candidate = event.media;
      try {
        if (!await revalidateListeners(operation, { cancelIfEmpty: true })) {
          await discardCandidateOnce(candidate);
          return;
        }
        operation.subtitle = event.subtitle ?? null;
        if (operation.subtitle !== null
            && !await publishToLiveListeners(operation, 'onSubtitle', operation.subtitle)) {
          await discardCandidateOnce(candidate);
          return;
        }
        // Resolving creates the durable project on demand, so never resolve for an operation
        // which has already lost every subscriber. It is still detached: neither project
        // publication nor native media selection may happen until the caller's admission below.
        if (!await revalidateListeners(operation, { cancelIfEmpty: true })) {
          await discardCandidateOnce(candidate);
          return;
        }
        const resolved = await resolveCandidateProject(url);
        await assertOperationOwned();
        let media;
        const owner = transactionalOwner();
        if (owner !== null) {
          let binding = null;
          try {
            await assertListenerLive(owner);
            binding = await owner.admitActivation(Object.freeze({
              assetId: candidateAssetId(candidate),
              resolvedProject: resolved,
              url,
            }), { validateOwnership: assertOperationOwned });
            await assertOperationOwned();
            if (!isSubtitleProjectBindingReceipt(binding, {
              cacheId: resolved?.cacheId,
              projectId: resolved?.projectId,
            }) || !Number.isSafeInteger(binding.stateVersion) || binding.stateVersion < 0) {
              throw fixedFailure('mediaCandidateProjectFailed');
            }
            media = await claimCandidate(candidate, {
              expectedStateVersion: binding.stateVersion,
              projectId: binding.projectId,
            }, { validateOwnership: assertOperationOwned });
            await assertOperationOwned();
            await owner.publishActivation(media, binding, {
              validateOwnership: assertOperationOwned,
            });
            await assertOperationOwned();
          } catch (error) {
            if (binding !== null && rollbackSubtitleProjectBinding(binding)) {
              try {
                await owner.rollbackActivation({ validateOwnership: assertOperationOwned });
              } catch {
                throw fixedFailure('mediaActivationRollbackFailed');
              }
            }
            throw error;
          }
        } else {
          if (typeof activateProject !== 'function') {
            throw fixedFailure('mediaActivationAdmissionRequired');
          }
          // Test-only compatibility for the reviewed legacy adapter contract. The shipping
          // singleton has no activator and therefore cannot enter this branch.
          const activation = await activateProject(resolved, {
            validateOwnership: assertOperationOwned,
          });
          try {
            media = await claimCandidate(candidate, activation.claimOptions, {
              validateOwnership: assertOperationOwned,
            });
          } catch (error) {
            activation.release();
            throw error;
          }
        }
        settle({
          kind: 'completed',
          media,
          assetId: candidateAssetId(candidate),
          subtitle: operation.subtitle,
        });
      } catch (error) {
        try {
          await discardCandidateOnce(candidate);
          settle({
            kind: 'failed',
            error: error?.code === 'mediaActivationRollbackFailed'
              ? error
              : fixedFailure('mediaOpenFailed'),
          });
        } catch (discardError) {
          settle({ kind: 'failed', error: discardError });
        }
      }
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
          onCompleted: (event) => enqueueEvent(() => claimCompletedCandidate(event, settle)),
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
          if (reopenCompletedAsset !== null) {
            completedAssets.remember(key, outcome.assetId, outcome.subtitle);
          }
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
        admitActivation,
        publishActivation,
        rollbackActivation,
      } = requestSnapshot;
      const normalizedUrl = normalizeUrl(url);
      const callbacks = {
        admitActivation: normalizeCallback(admitActivation),
        onStarted: normalizeCallback(onStarted),
        onProgress: normalizeCallback(onProgress),
        onSubtitle: normalizeCallback(onSubtitle),
        publishActivation: normalizeCallback(publishActivation),
        rollbackActivation: normalizeCallback(rollbackActivation),
        signalBinding: snapshotSignal(signal),
        validateOwnership: normalizeCallback(validateOwnership),
      };
      const activationCallbacks = [
        callbacks.admitActivation,
        callbacks.publishActivation,
        callbacks.rollbackActivation,
      ];
      const suppliedActivationCallbacks = activationCallbacks.filter(
        (callback) => typeof callback === 'function'
      ).length;
      if ((suppliedActivationCallbacks !== 0
          && (suppliedActivationCallbacks !== activationCallbacks.length
            || typeof callbacks.validateOwnership !== 'function'))
          || (typeof activateProject !== 'function' && suppliedActivationCallbacks === 0)) {
        throw fixedFailure('invalidDownloadRequest');
      }
      const cookieSource = normalizeCookieSource(requestedCookieSource);
      const preferredLanguages = normalizePreferredLanguages(preferredSubtitleLanguages);
      const key = operationKey(normalizedUrl, cookieSource, preferredLanguages);

      const completed = reopenCompletedAsset === null ? undefined : completedAssets.read(key);
      if (completed && reopenCompletedAsset !== null) {
        const reopened = await reopenCompletedAsset(key, normalizedUrl, completed, callbacks);
        if (reopened !== null) return reopened.media;
      }

      const existing = active.get(key);
      const reused = existing?.accepting === true;
      const operation = reused
        ? existing
        : createOperation(key, normalizedUrl, cookieSource, preferredLanguages);
      const subscription = subscribe(operation, callbacks);
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
