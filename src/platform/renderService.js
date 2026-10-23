// Public native render API: the app-wide render session plus the run/wait helpers built on it.
// The request, response, error and session layers live in the sibling render*.js modules; what the
// editor calls is re-exported here.
import { abortableDelay, createAbortMonitor, internalAbortMonitors } from './renderAbort';
import {
  NativeRenderError,
  cancelled,
  invalidRequest,
  invalidResponse,
  normalizeFailure,
} from './renderErrors';
import {
  ACTIVE_JOB_STATES,
  callSafely,
  createNativeRenderService,
} from './nativeRenderSession';
import { requireInteger, snapshotPlainRecord, uuidHasVersion } from './renderValidation';

export {
  buildNativeRenderRequest,
  ensureNativeRenderProject,
  resolveNativeRenderSource,
} from './renderRequest';
export { NativeRenderError, createNativeRenderService };

const MAX_POLL_MS = 24 * 60 * 60 * 1_000;

const nativeRenderService = createNativeRenderService();

export const getNativeRenderStatus = nativeRenderService.status;
export const getNativeRenderResult = nativeRenderService.getResult;
export const cancelNativeRender = nativeRenderService.cancel;
export const releaseNativeRenderPlayback = nativeRenderService.releasePlayback;

const runNativeRenderObserved = async (
  request,
  { signal, text, onStarted, onProgress },
  service,
  abortMonitor,
) => {
  const ownership = snapshotPlainRecord(request);
  if (ownership === null
      || !uuidHasVersion(ownership.sourceAssetId, 7)
      || !uuidHasVersion(ownership.projectId, 7)) {
    throw invalidRequest();
  }
  const expectedSourceAssetId = ownership.sourceAssetId;
  const expectedProjectId = ownership.projectId;
  if (abortMonitor?.isAborted()) throw cancelled();
  let terminalObserved = false;
  let terminalOutcome = null;
  let resolveTerminal;
  const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
  const settle = (outcome) => {
    if (terminalOutcome !== null) return;
    terminalObserved = true;
    terminalOutcome = outcome;
    resolveTerminal(outcome);
  };
  let initial;
  try {
    initial = await service.start(request, {
      onProgress,
      onCompleted: (event) => settle({ result: event }),
      onCancelled: () => settle({ error: cancelled() }),
      onFailed: async (event) => {
        terminalObserved = true;
        if (event.job?.state === 'succeeded') {
          if (abortMonitor?.isAborted()) {
            settle({ error: cancelled() });
            return;
          }
          try {
            const recovered = await service.getResult(event.job.id);
            if (recovered.result !== null) {
              if (abortMonitor?.isAborted()) {
                if (typeof service.releasePlayback === 'function') {
                  try {
                    await service.releasePlayback(recovered.result.playback.id);
                  } catch {
                    // Cancellation owns the result even if capability cleanup is already complete.
                  }
                }
                settle({ error: cancelled() });
                return;
              }
              if (recovered.result.sourceAssetId !== expectedSourceAssetId
                  || recovered.result.projectId !== expectedProjectId) {
                if (typeof service.releasePlayback === 'function') {
                  try {
                    await service.releasePlayback(recovered.result.playback.id);
                  } catch {
                    // The categorical protocol failure still owns this boundary.
                  }
                }
                settle({ error: invalidResponse() });
                return;
              }
              settle({
                result: Object.freeze({
                  event: 'completed',
                  job: recovered.job,
                  result: recovered.result,
                }),
              });
              return;
            }
          } catch {
            if (abortMonitor?.isAborted()) {
              settle({ error: cancelled() });
              return;
            }
            // Fall through to the categorical native failure.
          }
        }
        settle({ error: normalizeFailure(event.error) });
      },
      onProtocolError: (error) => settle({ error }),
    }, (() => {
      const startOptions = text === undefined ? { signal } : { signal, text };
      if (abortMonitor !== null) internalAbortMonitors.set(startOptions, abortMonitor);
      return startOptions;
    })());
  } catch (error) {
    if (!terminalObserved) throw normalizeFailure(error);
    const outcome = terminalOutcome ?? await terminal;
    if (outcome.error) throw outcome.error;
    return outcome.result;
  }
  if (!terminalObserved) callSafely(onStarted, initial);
  const outcome = await terminal;
  if (outcome.error) throw outcome.error;
  return outcome.result;
};

export const runNativeRender = async (
  request,
  rawOptions = {},
  service = nativeRenderService,
) => {
  const options = snapshotPlainRecord(rawOptions);
  const allowed = new Set(['signal', 'text', 'onStarted', 'onProgress']);
  if (options === null || Object.keys(options).some((key) => !allowed.has(key))) {
    throw invalidRequest();
  }
  const signal = options.signal ?? null;
  const text = options.text;
  const onStarted = options.onStarted;
  const onProgress = options.onProgress;
  if ((onStarted !== undefined && typeof onStarted !== 'function')
      || (onProgress !== undefined && typeof onProgress !== 'function')) {
    throw invalidRequest();
  }
  const abortMonitor = createAbortMonitor(signal);
  try {
    return await runNativeRenderObserved(
      request,
      { signal, text, onStarted, onProgress },
      service,
      abortMonitor,
    );
  } finally {
    abortMonitor?.dispose();
  }
};


const waitForNativeRenderObserved = async (jobId, {
  pollIntervalMs,
  timeoutMs,
  onUpdate,
}, service, abortMonitor) => {
  requireInteger(pollIntervalMs, 100, 10_000);
  requireInteger(timeoutMs, pollIntervalMs, MAX_POLL_MS);
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (abortMonitor?.isAborted()) throw cancelled();
    const response = await service.getResult(jobId);
    if (abortMonitor?.isAborted()) {
      const playbackId = response?.result?.playback?.id;
      if (uuidHasVersion(playbackId, 4) && typeof service.releasePlayback === 'function') {
        try {
          await service.releasePlayback(playbackId);
        } catch {
          // Cancellation remains authoritative even if capability cleanup is already complete.
        }
      }
      throw cancelled();
    }
    callSafely(onUpdate, response);
    if (!ACTIVE_JOB_STATES.has(response.job.state)) return response;
    await abortableDelay(pollIntervalMs, abortMonitor);
  }
  throw new NativeRenderError('renderTimeout', 'The native render status wait timed out');
};

export const waitForNativeRender = async (
  jobId,
  rawOptions = {},
  service = nativeRenderService,
) => {
  const options = snapshotPlainRecord(rawOptions);
  const allowed = new Set(['signal', 'pollIntervalMs', 'timeoutMs', 'onUpdate']);
  if (options === null || Object.keys(options).some((key) => !allowed.has(key))) {
    throw invalidRequest();
  }
  const signal = options.signal ?? null;
  const pollIntervalMs = options.pollIntervalMs === undefined ? 750 : options.pollIntervalMs;
  const timeoutMs = options.timeoutMs === undefined ? MAX_POLL_MS : options.timeoutMs;
  const onUpdate = options.onUpdate;
  if (onUpdate !== undefined && typeof onUpdate !== 'function') throw invalidRequest();
  const abortMonitor = createAbortMonitor(signal);
  try {
    return await waitForNativeRenderObserved(
      jobId,
      { pollIntervalMs, timeoutMs, onUpdate },
      service,
      abortMonitor,
    );
  } finally {
    abortMonitor?.dispose();
  }
};
