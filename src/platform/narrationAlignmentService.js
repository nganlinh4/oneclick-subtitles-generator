import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';
import {
  normalizeSpeechArtifact,
  releaseSpeechPlayback,
  resolveSpeechArtifact,
} from './speechService';

export const MAX_ALIGNMENT_CLIPS = 1_000;
export const MAX_ALIGNMENT_DURATION_MICROS = 4 * 60 * 60 * 1_000_000;

const MAX_PENDING_EVENTS = 4_096;
const MAX_JOB_EVENTS = 20_000;
const MAX_WAIT_MS = 2 * 60 * 60 * 1_000;
const jobStates = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const phases = new Set(['planning', 'mixing', 'publishing']);
const phaseOrder = Object.freeze({ planning: 0, mixing: 1, publishing: 2 });
const failureCodes = new Set([
  'cancelled',
  'invalidRequest',
  'runtimeUnavailable',
  'timedOut',
  'mediaFailed',
  'artifactStorage',
]);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isPlainRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .every((descriptor) => descriptor.enumerable && 'value' in descriptor);
};

const hasExactKeys = (value, keys) => (
  isPlainRecord(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
);

const hasOnlyKeys = (value, keys) => (
  isPlainRecord(value) && Object.keys(value).every((key) => keys.has(key))
);

const uuidHasVersion = (value, expectedVersion) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expectedVersion;
  } catch {
    return false;
  }
};

export class NarrationAlignmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NarrationAlignmentError';
    this.code = code;
  }
}

const invalidRequest = () => new NarrationAlignmentError(
  'invalidAlignmentRequest',
  'The native narration alignment request is invalid'
);

const invalidResponse = () => new NarrationAlignmentError(
  'invalidAlignmentResponse',
  'The desktop host returned invalid narration alignment data'
);

const cancelled = () => new NarrationAlignmentError(
  'alignmentCancelled',
  'The narration alignment was cancelled'
);

const unavailable = () => new NarrationAlignmentError(
  'desktopAlignmentRequired',
  'Native narration alignment requires the desktop runtime'
);

const requireInteger = (value, minimum, maximum, response = false) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw response ? invalidResponse() : invalidRequest();
  }
  return value;
};

const requireUuid = (value, expectedVersion, response = false) => {
  if (!uuidHasVersion(value, expectedVersion)) {
    throw response ? invalidResponse() : invalidRequest();
  }
  return value;
};

const requireIdentifier = (value) => {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > 96
      || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw invalidRequest();
  }
  return value;
};

export const normalizeAlignmentRequest = (request) => {
  if (!hasExactKeys(request, ['clips'])
      || !Array.isArray(request.clips)
      || request.clips.length === 0
      || request.clips.length > MAX_ALIGNMENT_CLIPS) {
    throw invalidRequest();
  }
  const ids = new Set();
  const clips = request.clips.map((clip) => {
    if (!hasExactKeys(clip, ['id', 'artifactId', 'startMicros', 'cueEndMicros'])) {
      throw invalidRequest();
    }
    const id = requireIdentifier(clip.id);
    if (ids.has(id)) throw invalidRequest();
    ids.add(id);
    const startMicros = requireInteger(
      clip.startMicros,
      0,
      MAX_ALIGNMENT_DURATION_MICROS
    );
    const cueEndMicros = requireInteger(
      clip.cueEndMicros,
      startMicros,
      MAX_ALIGNMENT_DURATION_MICROS
    );
    return Object.freeze({
      id,
      artifactId: requireUuid(clip.artifactId, 7),
      startMicros,
      cueEndMicros,
    });
  });
  return Object.freeze({ clips: Object.freeze(clips) });
};

export const normalizeAlignmentJob = (job) => {
  if (!hasExactKeys(job, ['id', 'kind', 'state', 'progress', 'sequence'])
      || !hasExactKeys(job.progress, ['basisPoints'])
      || !uuidHasVersion(job.id, 7)
      || job.kind !== 'alignNarration'
      || !jobStates.has(job.state)) {
    throw invalidResponse();
  }
  const basisPoints = requireInteger(job.progress.basisPoints, 0, 10_000, true);
  const sequence = requireInteger(job.sequence, 0, Number.MAX_SAFE_INTEGER, true);
  if ((job.state === 'queued' && (basisPoints !== 0 || sequence !== 0))
      || (job.state === 'succeeded' && (basisPoints !== 10_000 || sequence < 2))
      || (!['queued', 'succeeded'].includes(job.state) && sequence < 1)) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: job.id,
    kind: 'alignNarration',
    state: job.state,
    progress: Object.freeze({ basisPoints }),
    sequence,
  });
};

export const normalizeAlignmentResult = (result) => {
  if (!hasExactKeys(result, [
    'artifact',
    'clipCount',
    'adjustedCount',
    'requestedDurationMicros',
    'naturalDurationMicros',
    'renderedDurationMicros',
    'maximumShiftMicros',
  ])) {
    throw invalidResponse();
  }
  const artifact = normalizeSpeechArtifact(result.artifact);
  const clipCount = requireInteger(result.clipCount, 1, MAX_ALIGNMENT_CLIPS, true);
  const adjustedCount = requireInteger(result.adjustedCount, 0, clipCount, true);
  const renderedDurationMicros = requireInteger(
    result.renderedDurationMicros,
    1,
    MAX_ALIGNMENT_DURATION_MICROS,
    true
  );
  const requestedDurationMicros = requireInteger(
    result.requestedDurationMicros,
    0,
    renderedDurationMicros,
    true
  );
  const naturalDurationMicros = requireInteger(
    result.naturalDurationMicros,
    1,
    renderedDurationMicros,
    true
  );
  const maximumShiftMicros = requireInteger(
    result.maximumShiftMicros,
    0,
    renderedDurationMicros,
    true
  );
  if (artifact.format !== 'm4a'
      || artifact.durationMicros !== renderedDurationMicros
      || artifact.sampleRateHz !== 48_000
      || artifact.channels !== 2) {
    throw invalidResponse();
  }
  return Object.freeze({
    artifact,
    clipCount,
    adjustedCount,
    requestedDurationMicros,
    naturalDurationMicros,
    renderedDurationMicros,
    maximumShiftMicros,
  });
};

const normalizeAlignmentEvent = (event) => {
  if (!isPlainRecord(event) || typeof event.event !== 'string') throw invalidResponse();
  if (event.event === 'progress') {
    if (!hasExactKeys(event, ['event', 'jobId', 'phase', 'fractionMillionths'])
        || !uuidHasVersion(event.jobId, 7)
        || !phases.has(event.phase)) {
      throw invalidResponse();
    }
    return Object.freeze({
      event: 'progress',
      jobId: event.jobId,
      phase: event.phase,
      fractionMillionths: requireInteger(event.fractionMillionths, 0, 950_000, true),
    });
  }
  if (event.event === 'completed') {
    if (!hasExactKeys(event, ['event', 'job', 'result'])) throw invalidResponse();
    const job = normalizeAlignmentJob(event.job);
    if (job.state !== 'succeeded') throw invalidResponse();
    return Object.freeze({ event: 'completed', job, result: normalizeAlignmentResult(event.result) });
  }
  if (event.event === 'cancelled') {
    if (!hasExactKeys(event, ['event', 'job'])) throw invalidResponse();
    const job = normalizeAlignmentJob(event.job);
    if (job.state !== 'cancelled') throw invalidResponse();
    return Object.freeze({ event: 'cancelled', job });
  }
  if (event.event === 'failed') {
    if (!hasExactKeys(event, ['event', 'job', 'code']) || !failureCodes.has(event.code)) {
      throw invalidResponse();
    }
    const job = event.job === null ? null : normalizeAlignmentJob(event.job);
    if (job !== null && !['failed', 'cancelling'].includes(job.state)) throw invalidResponse();
    return Object.freeze({ event: 'failed', job, code: event.code });
  }
  throw invalidResponse();
};

const handlerKeys = new Set([
  'onEvent',
  'onProgress',
  'onCompleted',
  'onCancelled',
  'onFailed',
  'onProtocolError',
  'onHandlerError',
  'onCancellationError',
]);
const optionKeys = new Set(['signal']);
const waitOptionKeys = new Set(['signal', 'pollIntervalMs', 'timeoutMs']);

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  if (!hasOnlyKeys(handlers, handlerKeys)) throw invalidRequest();
  for (const handler of Object.values(handlers)) {
    if (handler !== undefined && typeof handler !== 'function') throw invalidRequest();
  }
  return Object.freeze({ ...handlers });
};

const normalizeOptions = (options) => {
  if (options === undefined) return Object.freeze({ signal: null });
  if (!hasOnlyKeys(options, optionKeys)) throw invalidRequest();
  const signal = options.signal ?? null;
  if (signal !== null
      && (!isRecord(signal)
        || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function'
        || typeof signal.removeEventListener !== 'function')) {
    throw invalidRequest();
  }
  return Object.freeze({ signal });
};

export const createNativeNarrationAlignmentService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
  resolveArtifact = resolveSpeechArtifact,
  releasePlayback = releaseSpeechPlayback,
} = {}) => {
  const activeChannels = new Map();

  const requireNative = () => {
    if (!isNativeRuntime()) throw unavailable();
  };

  const cancelAlignmentJob = async (jobId) => {
    requireNative();
    const id = requireUuid(jobId, 7);
    const job = normalizeAlignmentJob(await invokeCommand('job_cancel', { id }));
    if (job.id !== id || ['queued', 'running'].includes(job.state)) throw invalidResponse();
    return job;
  };

  const startAlignmentJob = async (request, rawHandlers, rawOptions) => {
    requireNative();
    const normalized = normalizeAlignmentRequest(request);
    const handlers = normalizeHandlers(rawHandlers);
    const { signal } = normalizeOptions(rawOptions);
    if (signal?.aborted) throw cancelled();

    let channel;
    try {
      channel = new ChannelConstructor();
    } catch {
      throw invalidRequest();
    }
    if (!isRecord(channel)) throw invalidRequest();

    const pending = [];
    let initial = null;
    let terminal = false;
    let protocolError = null;
    let eventCount = 0;
    let cancellationIssued = false;
    let abortAttached = false;
    let lastFraction = -1;
    let lastPhase = -1;

    const safelyCall = (handler, argument) => {
      if (typeof handler !== 'function') return;
      const report = (error) => {
        if (typeof handlers.onHandlerError !== 'function') return;
        try {
          const result = handlers.onHandlerError(error);
          if (result && typeof result.catch === 'function') result.catch(() => undefined);
        } catch {
          // Diagnostic handlers never control the native channel.
        }
      };
      try {
        const result = handler(argument);
        if (result && typeof result.catch === 'function') result.catch(report);
      } catch (error) {
        report(error);
      }
    };

    function onAbort() {
      issueCancellation();
    }

    const release = () => {
      if (initial !== null) activeChannels.delete(initial.id);
      if (signal && abortAttached) {
        abortAttached = false;
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          // Foreign AbortSignal cleanup cannot invalidate completed work.
        }
      }
    };

    function issueCancellation() {
      if (cancellationIssued || terminal || initial === null) return;
      cancellationIssued = true;
      cancelAlignmentJob(initial.id).catch((error) => {
        safelyCall(handlers.onCancellationError, error);
      });
    }

    const failProtocol = (error = invalidResponse()) => {
      if (protocolError !== null || terminal) return;
      protocolError = error;
      pending.length = 0;
      safelyCall(handlers.onProtocolError, error);
      issueCancellation();
      release();
    };

    const dispatch = (event) => {
      if (terminal || protocolError !== null) return;
      if (eventCount >= MAX_JOB_EVENTS) {
        failProtocol();
        return;
      }
      eventCount += 1;
      const eventJobId = event.event === 'progress' ? event.jobId : event.job?.id;
      if (eventJobId !== null && eventJobId !== undefined && eventJobId !== initial.id) {
        failProtocol();
        return;
      }
      if (event.event === 'progress') {
        const order = phaseOrder[event.phase];
        if (order < lastPhase || event.fractionMillionths < lastFraction) {
          failProtocol();
          return;
        }
        lastPhase = order;
        lastFraction = event.fractionMillionths;
      } else {
        terminal = true;
        release();
      }
      safelyCall(handlers.onEvent, event);
      if (event.event === 'progress') safelyCall(handlers.onProgress, event);
      if (event.event === 'completed') safelyCall(handlers.onCompleted, event);
      if (event.event === 'cancelled') safelyCall(handlers.onCancelled, event);
      if (event.event === 'failed') safelyCall(handlers.onFailed, event);
    };

    if (signal) {
      try {
        signal.addEventListener('abort', onAbort, { once: true });
        abortAttached = true;
      } catch {
        throw invalidRequest();
      }
    }
    channel.onmessage = (rawEvent) => {
      if (terminal || protocolError !== null) return;
      let event;
      try {
        event = normalizeAlignmentEvent(rawEvent);
      } catch (error) {
        failProtocol(error);
        return;
      }
      if (initial === null) {
        if (pending.length >= MAX_PENDING_EVENTS) {
          failProtocol();
          return;
        }
        pending.push(event);
        return;
      }
      dispatch(event);
    };

    let job;
    try {
      job = normalizeAlignmentJob(await invokeCommand('speech_alignment_start', {
        request: normalized,
        onEvent: channel,
      }));
      initial = job;
      if (job.state !== 'running'
          || job.progress.basisPoints !== 0
          || job.sequence !== 1) {
        throw invalidResponse();
      }
    } catch (error) {
      pending.length = 0;
      release();
      throw error;
    }
    activeChannels.set(job.id, channel);
    for (const event of pending.splice(0)) {
      dispatch(event);
      if (protocolError !== null) break;
    }
    if (protocolError !== null) {
      issueCancellation();
      release();
      throw protocolError;
    }
    if (signal?.aborted) issueCancellation();
    if (terminal) release();
    return job;
  };

  const getAlignmentResult = async (jobId) => {
    requireNative();
    const id = requireUuid(jobId, 7);
    const value = await invokeCommand('speech_alignment_result', { jobId: id });
    if (!hasExactKeys(value, ['job', 'result'])) throw invalidResponse();
    const job = normalizeAlignmentJob(value.job);
    if (job.id !== id) throw invalidResponse();
    const result = value.result === null ? null : normalizeAlignmentResult(value.result);
    if (job.state === 'succeeded' && result === null) throw invalidResponse();
    return Object.freeze({ job, result });
  };

  const waitForAlignmentResult = async (jobId, options = {}) => {
    requireNative();
    if (!hasOnlyKeys(options, waitOptionKeys)) throw invalidRequest();
    const id = requireUuid(jobId, 7);
    const signal = options.signal ?? null;
    if (signal !== null
        && (!isRecord(signal)
          || typeof signal.aborted !== 'boolean'
          || typeof signal.addEventListener !== 'function'
          || typeof signal.removeEventListener !== 'function')) {
      throw invalidRequest();
    }
    const pollIntervalMs = requireInteger(options.pollIntervalMs ?? 250, 100, 5_000);
    const timeoutMs = requireInteger(options.timeoutMs ?? MAX_WAIT_MS, 1_000, MAX_WAIT_MS);
    const startedAt = Date.now();
    for (;;) {
      if (signal?.aborted) {
        await cancelAlignmentJob(id).catch(() => undefined);
        throw cancelled();
      }
      const current = await getAlignmentResult(id);
      if (current.result !== null) return current;
      if (['failed', 'cancelled', 'interrupted'].includes(current.job.state)) {
        throw new NarrationAlignmentError(
          'alignmentUnavailable',
          'The narration alignment did not produce a durable artifact'
        );
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new NarrationAlignmentError(
          'alignmentWaitTimedOut',
          'Timed out while reconnecting to narration alignment'
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };

  const resolveAlignmentArtifact = async (artifactId) => {
    requireNative();
    const id = requireUuid(artifactId, 7);
    const playable = await resolveArtifact(id);
    if (playable.artifact.artifactId !== id) throw invalidResponse();
    return playable;
  };

  const releaseAlignmentPlayback = async (playbackId) => {
    requireNative();
    return releasePlayback(requireUuid(playbackId, 4));
  };

  return Object.freeze({
    startAlignmentJob,
    cancelAlignmentJob,
    getAlignmentResult,
    waitForAlignmentResult,
    resolveAlignmentArtifact,
    releaseAlignmentPlayback,
  });
};

export const nativeNarrationAlignmentService = createNativeNarrationAlignmentService();
