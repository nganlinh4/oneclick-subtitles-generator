import { nativeNarrationAdapter } from './nativeNarrationAdapter';
import { hydrateNativeNarrationResults } from './nativeNarrationCapabilities';
import {
  discardRecoveredNativeJob,
  ensureNativeJobRecoveryReady,
  forgetNativeJobId,
  listRecoveredNativeJobs,
  rememberNativeJobId,
} from './jobRecoveryCoordinator';

const RECONNECT_POLL_INTERVAL_MS = 500;
const RECONNECT_TIMEOUT_MS = 30 * 60 * 1_000;
const unrecoverableReconnectCodes = new Set([
  'invalidNarrationAdapterRequest',
  'invalidSpeechRequest',
  'jobNotFound',
]);
const terminalJobStates = new Set(['succeeded', 'failed', 'cancelled']);
const reconnectableJobStates = new Set(['queued', 'running', 'cancelling']);
const activeJobs = new Map();
const reconnectingJobs = new Map();
let startingJobs = 0;

const narrationRecoveryError = (code, message, retryable, cause) => {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = 'NativeNarrationRecoveryError';
  error.code = code;
  error.retryable = retryable;
  return error;
};

const safelyCall = (callback, ...args) => {
  if (typeof callback !== 'function') return;
  try {
    const returned = callback(...args);
    if (returned && typeof returned.catch === 'function') returned.catch(() => undefined);
  } catch {
    // UI callbacks do not own the native job lifecycle.
  }
};

export const runNativeNarrationJob = async (request, callbacks = {}, options) => {
  await ensureNativeJobRecoveryReady();
  if (listRecoveredNativeJobs('synthesizeNarration').length > 0) {
    throw narrationRecoveryError(
      'nativeNarrationRecoveryPending',
      'A recovered narration job must be resolved before starting another one',
      true,
    );
  }
  if (startingJobs > 0 || activeJobs.size > 0) {
    const error = new Error('A native narration job is already active');
    error.code = 'nativeNarrationBusy';
    throw error;
  }
  startingJobs += 1;
  let settle;
  let terminal = false;
  let jobId = null;
  const completed = new Promise((resolve) => {
    settle = resolve;
  });
  const finish = (outcome) => {
    if (terminal) return;
    terminal = true;
    if (jobId !== null) {
      activeJobs.delete(request.method);
      forgetNativeJobId(jobId);
    }
    settle(Object.freeze({ status: 'fulfilled', outcome }));
  };
  const fail = (error) => {
    if (terminal) return;
    terminal = true;
    if (jobId !== null) {
      activeJobs.delete(request.method);
      forgetNativeJobId(jobId);
    }
    settle(Object.freeze({ status: 'rejected', error }));
  };

  const awaitTerminal = async () => {
    const settlement = await completed;
    if (settlement.status === 'rejected') throw settlement.error;
    return settlement.outcome;
  };

  let started;
  try {
    started = await nativeNarrationAdapter.generate(request, {
    onEvent: callbacks.onEvent,
    onProgress: callbacks.onProgress,
    onResult: (result, index, total) => safelyCall(
      callbacks.onResult,
      hydrateNativeNarrationResults([result])[0],
      index,
      total,
    ),
    onComplete: (results) => {
      const hydrated = hydrateNativeNarrationResults(results);
      safelyCall(callbacks.onComplete, hydrated);
      finish(Object.freeze({ status: 'completed', results: hydrated }));
    },
    onCancelled: (results) => {
      const hydrated = hydrateNativeNarrationResults(results);
      safelyCall(callbacks.onCancelled, hydrated);
      finish(Object.freeze({ status: 'cancelled', results: hydrated }));
    },
    onError: (error) => {
      safelyCall(callbacks.onError, error);
      const failure = new Error('Native narration generation failed');
      failure.code = error.code;
      failure.results = hydrateNativeNarrationResults(error.results);
      fail(failure);
    },
    onProtocolError: (error) => {
      safelyCall(callbacks.onProtocolError, error);
      fail(error);
    },
    }, options);
  } catch (error) {
    if (terminal) return awaitTerminal();
    throw error;
  } finally {
    startingJobs -= 1;
  }

  jobId = started.job.id;
  if (!terminal) {
    activeJobs.set(request.method, jobId);
    rememberNativeJobId(jobId);
    safelyCall(callbacks.onStarted, Object.freeze({
      ...started,
      initialResults: hydrateNativeNarrationResults(started.initialResults),
    }));
  }
  const outcome = await awaitTerminal();
  return Object.freeze({ ...outcome, jobId });
};

export const cancelNativeNarrationJob = async (method) => {
  const jobId = activeJobs.get(method);
  if (!jobId) return false;
  await nativeNarrationAdapter.cancel(jobId);
  return true;
};

const reconnectRecoveredJob = async (
  { jobId, method, projectId, expectedProjectStateVersion, subtitles },
  { pollIntervalMs, timeoutMs },
) => {
  const existingJob = activeJobs.get(method);
  if (existingJob !== undefined && existingJob !== jobId) {
    throw narrationRecoveryError(
      'nativeNarrationRecoveryBusy',
      'Another narration job owns the recovery slot',
      true,
    );
  }
  if ([...activeJobs.values()].some((activeJobId) => activeJobId !== jobId)) {
    throw narrationRecoveryError(
      'nativeNarrationRecoveryBusy',
      'Another narration job owns the recovery slot',
      true,
    );
  }
  activeJobs.set(method, jobId);
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const restored = await nativeNarrationAdapter.restore({
        jobId,
        method,
        projectId,
        expectedProjectStateVersion,
        subtitles,
      });
      if (terminalJobStates.has(restored.job.state) || restored.job.state === 'interrupted') {
        discardRecoveredNativeJob(jobId);
        return Object.freeze({
          method,
          projectId,
          expectedProjectStateVersion,
          subtitles: Object.freeze(subtitles.map((subtitle) => Object.freeze({ ...subtitle }))),
          job: restored.job,
          results: hydrateNativeNarrationResults(restored.results),
        });
      }
      if (!reconnectableJobStates.has(restored.job.state)) {
        discardRecoveredNativeJob(jobId);
        throw narrationRecoveryError(
          'invalidNativeNarrationRecoveryState',
          'The recovered narration job has an invalid state',
          false,
        );
      }
      if (Date.now() >= deadline) {
        throw narrationRecoveryError(
          'nativeNarrationRecoveryTimedOut',
          'The recovered narration job is not terminal yet',
          true,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  } catch (error) {
    if (unrecoverableReconnectCodes.has(error?.code)) {
      discardRecoveredNativeJob(jobId);
      throw narrationRecoveryError(
        'invalidNativeNarrationRecovery',
        'The recovered narration job can no longer be restored',
        false,
        error,
      );
    }
    if (error?.name === 'NativeNarrationRecoveryError') throw error;
    throw narrationRecoveryError(
      'nativeNarrationRecoveryUnavailable',
      'The recovered narration job could not be read',
      true,
      error,
    );
  } finally {
    if (activeJobs.get(method) === jobId) activeJobs.delete(method);
  }
};

export const restorePersistedNativeNarration = async ({
  method,
  projectId,
  expectedProjectStateVersion,
  subtitles,
  pollIntervalMs = RECONNECT_POLL_INTERVAL_MS,
  timeoutMs = RECONNECT_TIMEOUT_MS,
} = {}) => {
  if (typeof method !== 'string'
      || typeof projectId !== 'string'
      || !Number.isSafeInteger(expectedProjectStateVersion)
      || expectedProjectStateVersion < 0
      || expectedProjectStateVersion > Number.MAX_SAFE_INTEGER
      || !Array.isArray(subtitles)
      || subtitles.length < 1
      || subtitles.length > 1_000
      || !Number.isSafeInteger(pollIntervalMs)
      || pollIntervalMs < 1
      || pollIntervalMs > 60_000
      || !Number.isSafeInteger(timeoutMs)
      || timeoutMs < pollIntervalMs
      || timeoutMs > RECONNECT_TIMEOUT_MS) {
    return null;
  }
  await ensureNativeJobRecoveryReady();
  for (const candidate of listRecoveredNativeJobs('synthesizeNarration')) {
    const jobId = candidate.job.id;
    const reconnecting = reconnectingJobs.get(jobId);
    if (reconnecting !== undefined) return reconnecting;
    const promise = reconnectRecoveredJob(
      { jobId, method, projectId, expectedProjectStateVersion, subtitles },
      { pollIntervalMs, timeoutMs },
    );
    reconnectingJobs.set(jobId, promise);
    try {
      const restored = await promise;
      if (restored !== null) return restored;
    } finally {
      if (reconnectingJobs.get(jobId) === promise) reconnectingJobs.delete(jobId);
    }
  }
  return null;
};
