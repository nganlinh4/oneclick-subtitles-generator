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
const MAX_EXECUTION_ATTEMPTS = 3;
const RETRYABLE_DOWNLOAD_CODES = new Set([
  'downloaderExecutionFailed',
  'downloaderFormatUnavailable',
  'downloaderNetworkFailed',
  'downloaderRateLimited',
]);
const RETRY_DELAYS_MS = Object.freeze([2_000, 8_000]);
const CANCELLATION_ACCEPTED_STATES = new Set(['cancelling', 'cancelled']);
const CANCELLATION_LOST_STATES = new Set(['succeeded', 'failed', 'interrupted']);
const defaultWaitForRetry = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

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
  waitForRetry = defaultWaitForRetry,
} = {}) => {
  const active = new Map();
  const activeJobs = new Map();
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
      return null;
    }
    operation.cancelRequested = true;
    operation.settleOrphan?.();
    if (operation.cancelInvoked) return operation.cancelPromise;
    operation.cancelInvoked = true;
    operation.accepting = false;
    if (active.get(operation.key) === operation) active.delete(operation.key);
    operation.cancelPromise = Promise.resolve(cancel(operation.jobId));
    // Abort-signal and ownership cancellations are intentionally fire-and-forget. Attach a
    // rejection observer here while preserving the original promise for the public Cancel button,
    // which must not claim success when the native command was rejected.
    operation.cancelPromise.catch(() => undefined);
    return operation.cancelPromise;
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
      cancelPromise: null,
      discardedCandidateIds: new Set(),
      enqueueEvent: null,
      eventChain: Promise.resolve(),
      jobId: null,
      key,
      listeners: new Set(),
      logicalCancelRequested: false,
      percent: null,
      promise: null,
      publicCancelPromise: null,
      registrationStarted: false,
      retryPending: false,
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
    operation.enqueueEvent = enqueueEvent;

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

    const runAttempt = async (attempt) => {
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
        if (terminal !== null) return false;
        if (outcome.kind === 'failed'
            && attempt < MAX_EXECUTION_ATTEMPTS
            && RETRYABLE_DOWNLOAD_CODES.has(outcome.error.code)) {
          // Publish the logical retry phase in the same serialized task as the native terminal.
          // A public Cancel queued immediately behind this event can therefore stop the adapter
          // operation without trying to cancel a Rust job which is already terminal.
          operation.retryPending = true;
        }
        terminal = outcome;
        resolveTerminal(outcome);
        return true;
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
      activeJobs.set(initial.id, operation);
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
          outcome = await runAttempt(attempt);
        } catch (error) {
          if (error?.name === 'AbortError'
              || error?.code === 'autoGenerationOwnershipLost'
              || error?.code === 'autoGenerationAborted') {
            throw error;
          }
          outcome = { kind: 'failed', error: fixedFailure(error?.code) };
        }
        if (operation.logicalCancelRequested) return null;
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
        const failureCode = outcome.error.code;
        if (!RETRYABLE_DOWNLOAD_CODES.has(failureCode)
            || attempt === MAX_EXECUTION_ATTEMPTS) {
          operation.retryPending = false;
          throw outcome.error;
        }
        operation.retryPending = true;

        // A generic extractor/process failure can mean the managed binary is stale, so verify the
        // live reviewed channel before retrying it. Typed CDN/network/rate-limit failures are not
        // updater failures and must not waste another release check.
        if (failureCode === 'downloaderExecutionFailed') {
          const recovery = await Promise.resolve(recoverDownloader())
            .catch(() => ({ checked: false, updated: false }));
          if (operation.logicalCancelRequested) return null;
          if (recovery?.checked !== true) {
            operation.retryPending = false;
            throw outcome.error;
          }
        }

        // Every native attempt is staged and cannot publish a partial asset. Wait before a fresh
        // inspection so source-side throttling has time to clear, then revalidate subscribers:
        // an abandoned request must not wake later and download into a different user intent.
        await Promise.resolve(waitForRetry(RETRY_DELAYS_MS[attempt - 1]));
        const retryAdmitted = await enqueueEvent(async () => {
          if (operation.logicalCancelRequested
              || !await revalidateListeners(operation, { cancelIfEmpty: true })) {
            return false;
          }
          if (operation.jobId !== null && activeJobs.get(operation.jobId) === operation) {
            activeJobs.delete(operation.jobId);
          }
          operation.jobId = null;
          operation.cancelInvoked = false;
          operation.cancelPromise = null;
          operation.cancelRequested = false;
          operation.registrationStarted = false;
          operation.retryPending = false;
          operation.percent = 0;
          return publishToLiveListeners(operation, 'onProgress', 0);
        });
        if (!retryAdmitted) return null;
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
          for (const [jobId, owner] of activeJobs) {
            if (owner === operation) activeJobs.delete(jobId);
          }
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

  /**
   * Cancel through the operation owner rather than bypassing it with the raw native command.
   *
   * Detaching every subscriber before the UI becomes retryable is the important invariant. A
   * second request for the same URL must create a new operation; it must never subscribe to A's
   * still-cancelling native job and inherit its terminal cancellation.
   */
  const cancelVideo = async (jobId) => {
    const operation = activeJobs.get(jobId);
    if (operation === undefined || operation.jobId !== jobId) return false;
    if (operation.publicCancelPromise !== null) return operation.publicCancelPromise;
    operation.accepting = false;
    if (active.get(operation.key) === operation) active.delete(operation.key);

    const restoreIfStillCurrent = () => {
      const slot = active.get(operation.key);
      const restorable = operation.listeners.size > 0
        && (slot === undefined || slot === operation);
      operation.accepting = restorable;
      if (restorable) active.set(operation.key, operation);
    };

    // Completion and cancellation are serialized through the same queue. Whichever event entered
    // first owns the terminal result: a delayed completion cannot publish behind a winning Cancel,
    // and Cancel cannot report success after an already-committed completion won the race.
    const queued = operation.enqueueEvent(async () => {
      if (operation.jobId !== jobId) return false;
      if (operation.retryPending) {
        // The Rust attempt already reached a retryable terminal state. Cancel the logical adapter
        // operation instead of issuing a meaningless second cancellation for that dead job.
        operation.logicalCancelRequested = true;
        operation.retryPending = false;
        if (activeJobs.get(jobId) === operation) activeJobs.delete(jobId);
        operation.jobId = null;
        for (const listener of [...operation.listeners]) {
          settleListener(operation, listener, 'resolve', null);
        }
        return true;
      }
      if (!operation.cancelInvoked) {
        operation.cancelInvoked = true;
        operation.cancelPromise = Promise.resolve(cancel(jobId));
        operation.cancelPromise.catch(() => undefined);
      }

      let snapshot;
      try {
        snapshot = await operation.cancelPromise;
      } catch (error) {
        operation.cancelInvoked = false;
        operation.cancelPromise = null;
        restoreIfStillCurrent();
        throw error;
      }
      if (snapshot === null || typeof snapshot !== 'object'
          || snapshot.id !== jobId
          || (!CANCELLATION_ACCEPTED_STATES.has(snapshot.state)
            && !CANCELLATION_LOST_STATES.has(snapshot.state))) {
        operation.cancelInvoked = false;
        operation.cancelPromise = null;
        restoreIfStillCurrent();
        throw fixedFailure('invalidDownloadResponse');
      }

      if (CANCELLATION_ACCEPTED_STATES.has(snapshot.state)) {
        operation.cancelRequested = true;
        const cancellationWon = operation.settleOrphan?.() === true;
        if (!cancellationWon) return false;
        for (const listener of [...operation.listeners]) {
          settleListener(operation, listener, 'resolve', null);
        }
        return true;
      }

      // A succeeded snapshot means native completion was committed before the cancellation command
      // reached Rust. Keep that result authoritative. Failed/interrupted snapshots enqueue their
      // own protocol terminal through downloadService and therefore stay detached here.
      if (snapshot.state === 'succeeded') restoreIfStillCurrent();
      return false;
    });
    operation.publicCancelPromise = queued.finally(() => {
      operation.publicCancelPromise = null;
    });
    operation.publicCancelPromise.catch(() => undefined);
    return operation.publicCancelPromise;
  };

  return Object.freeze({ cancelVideo, downloadVideo });
};

const nativeUrlDownloadAdapter = createNativeUrlDownloadAdapter();

export const downloadNativeVideo = nativeUrlDownloadAdapter.downloadVideo;
export const cancelNativeVideoDownload = nativeUrlDownloadAdapter.cancelVideo;
