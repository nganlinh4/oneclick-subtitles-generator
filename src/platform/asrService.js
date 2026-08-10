import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

export const ASR_ENGINE_CATALOG = Object.freeze([
  Object.freeze({
    id: 'parakeet',
    runtime: 'onnx',
    supportsForcedLanguage: false,
    requiresAligner: false,
  }),
  Object.freeze({
    id: 'faster-whisper-turbo',
    runtime: 'c_translate2',
    supportsForcedLanguage: true,
    requiresAligner: false,
  }),
  Object.freeze({
    id: 'faster-whisper-large-v3',
    runtime: 'c_translate2',
    supportsForcedLanguage: true,
    requiresAligner: false,
  }),
  Object.freeze({
    id: 'qwen3-asr-1.7b',
    runtime: 'py_torch',
    supportsForcedLanguage: true,
    requiresAligner: true,
  }),
  Object.freeze({
    id: 'qwen3-asr-0.6b',
    runtime: 'py_torch',
    supportsForcedLanguage: true,
    requiresAligner: true,
  }),
]);

export const ASR_ENGINE_IDS = Object.freeze(ASR_ENGINE_CATALOG.map(({ id }) => id));
export const ASR_STRATEGIES = Object.freeze(['sentence', 'word', 'character']);
export const ASR_PROGRESS_PHASES = Object.freeze([
  'preparingAudio',
  'modelLoading',
  'transcribing',
  'finalizing',
]);

const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_LABEL_CHARACTERS = 256;
const MAX_ERROR_MESSAGE_CHARACTERS = 4_096;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENT_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_SEGMENTS = 250_000;
const MAX_PENDING_EVENTS = 4_096;
const MAX_JOB_EVENTS = 250_000;

const engineById = new Map(ASR_ENGINE_CATALOG.map((engine) => [engine.id, engine]));
const engineIds = new Set(ASR_ENGINE_IDS);
const strategies = new Set(ASR_STRATEGIES);
const progressPhaseRank = new Map(ASR_PROGRESS_PHASES.map((phase, index) => [phase, index]));
const backends = new Set(['cuda', 'direct_ml', 'core_ml', 'metal', 'cpu']);
const jobStates = new Set([
  'queued',
  'running',
  'cancelling',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);
const requestKeys = new Set([
  'engine',
  'strategy',
  'maxCharacters',
  'maxWords',
  'pauseThresholdMs',
  'language',
  'range',
]);
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
const startOptionKeys = new Set(['signal']);
const qwenLanguages = new Set(['zh', 'en', 'fr', 'de', 'it', 'ja', 'ko', 'pt', 'ru', 'es']);

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

const isPlainDataRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .every((descriptor) => descriptor.enumerable && 'value' in descriptor);
};

const hasOnlyKeys = (value, allowed) => (
  isPlainDataRecord(value) && Object.keys(value).every((key) => allowed.has(key))
);

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

const characterCountWithin = (value, maximum) => {
  let count = 0;
  for (const unused of value) {
    void unused;
    count += 1;
    if (count > maximum) return false;
  }
  return true;
};

const containsDisallowedControl = (value) => {
  for (const character of value) {
    if (character < ' '
        && character !== '\n'
        && character !== '\r'
        && character !== '\t') {
      return true;
    }
  }
  return false;
};

const containsAnyControl = (value) => {
  for (const character of value) {
    if (character < ' ' || character === '\u007f') return true;
  }
  return false;
};

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

export class AsrServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AsrServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new AsrServiceError(
  'invalidAsrRequest',
  'The native ASR request is invalid'
);

const invalidResponse = () => new AsrServiceError(
  'invalidAsrResponse',
  'The desktop host returned invalid ASR data'
);

const desktopRequired = () => new AsrServiceError(
  'desktopAsrRequired',
  'Local ASR requires the desktop runtime'
);

const cancelledRequest = () => new AsrServiceError(
  'asrCancelled',
  'The native ASR request was cancelled'
);

const requireUuidV7 = (value) => {
  if (!isUuidV7(value)) throw invalidRequest();
  return value;
};

const requireInteger = (value, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidRequest();
  }
  return value;
};

const secondsToMilliseconds = (seconds) => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    throw invalidRequest();
  }
  const milliseconds = Math.round(seconds * 1_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw invalidRequest();
  return milliseconds;
};

const normalizeRange = (range) => {
  if (!isPlainDataRecord(range)) throw invalidRequest();
  const keys = Object.keys(range);
  const legacySeconds = keys.length === 2 && keys.includes('start') && keys.includes('end');
  const namedSeconds = keys.length === 2
    && keys.includes('startSeconds')
    && keys.includes('endSeconds');
  if (!legacySeconds && !namedSeconds) throw invalidRequest();

  const startMs = secondsToMilliseconds(
    legacySeconds ? range.start : range.startSeconds
  );
  const endMs = secondsToMilliseconds(
    legacySeconds ? range.end : range.endSeconds
  );
  if (endMs <= startMs || endMs - startMs > MAX_DURATION_MS) throw invalidRequest();
  return Object.freeze({ startMs, endMs });
};

const normalizeLanguage = (language, engine) => {
  if (language === undefined || language === null) return undefined;
  if (typeof language !== 'string') throw invalidRequest();
  const normalized = language.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(normalized)) throw invalidRequest();

  const metadata = engineById.get(engine);
  if (!metadata.supportsForcedLanguage) throw invalidRequest();
  if (metadata.requiresAligner && !qwenLanguages.has(normalized)) throw invalidRequest();
  return normalized;
};

export const normalizeAsrStartRequest = (request) => {
  if (!hasOnlyKeys(request, requestKeys)) throw invalidRequest();

  const engine = request.engine === 'nvidia-parakeet' ? 'parakeet' : request.engine;
  if (!engineIds.has(engine)) throw invalidRequest();

  const strategyInput = request.strategy ?? 'sentence';
  const strategy = strategyInput === 'char' ? 'character' : strategyInput;
  if (!strategies.has(strategy)) throw invalidRequest();

  const maxCharacters = request.maxCharacters === undefined
    ? 60
    : requireInteger(request.maxCharacters, 5, 200);
  let maxWords = request.maxWords;
  if (maxWords === undefined) maxWords = 7;
  else if (maxWords === -1) maxWords = null;
  else if (maxWords !== null) maxWords = requireInteger(maxWords, 1, 50);
  const pauseThresholdMs = request.pauseThresholdMs === undefined
    ? 800
    : requireInteger(request.pauseThresholdMs, 100, 5_000);
  const language = normalizeLanguage(request.language, engine);

  const normalized = {
    engine,
    strategy,
    maxCharacters,
    maxWords,
    pauseThresholdMs,
  };
  if (language !== undefined) normalized.language = language;
  if (request.range !== undefined && request.range !== null) {
    normalized.range = normalizeRange(request.range);
  }
  return Object.freeze(normalized);
};

const normalizeJobSnapshot = (snapshot) => {
  if (!isPlainDataRecord(snapshot)
      || !isPlainDataRecord(snapshot.progress)
      || !isUuidV7(snapshot.id)
      || snapshot.kind !== 'transcribe'
      || !jobStates.has(snapshot.state)) {
    throw invalidResponse();
  }
  const basisPoints = snapshot.progress.basisPoints;
  if (!Number.isSafeInteger(basisPoints)
      || basisPoints < 0
      || basisPoints > 10_000
      || !Number.isSafeInteger(snapshot.sequence)
      || snapshot.sequence < 0) {
    throw invalidResponse();
  }

  const stateInvariantHolds = snapshot.state === 'queued'
    ? basisPoints === 0 && snapshot.sequence === 0
    : snapshot.state === 'succeeded'
      ? basisPoints === 10_000 && snapshot.sequence >= 2
      : snapshot.sequence >= 1;
  if (!stateInvariantHolds) throw invalidResponse();

  return Object.freeze({
    id: snapshot.id,
    kind: 'transcribe',
    state: snapshot.state,
    progress: Object.freeze({ basisPoints }),
    sequence: snapshot.sequence,
  });
};

const normalizeCommandError = (error) => {
  if (!isPlainDataRecord(error)
      || typeof error.code !== 'string'
      || !/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(error.code)
      || typeof error.message !== 'string'
      || !characterCountWithin(error.message, MAX_ERROR_MESSAGE_CHARACTERS)) {
    throw invalidResponse();
  }
  return Object.freeze({ code: error.code, message: error.message });
};

const requireResponseMilliseconds = (value, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw invalidResponse();
  return value;
};

const requireResponseText = (value, maximumBytes, { nonBlank = false } = {}) => {
  if (typeof value !== 'string'
      || (nonBlank && value.trim().length === 0)
      || utf8ByteLength(value) > maximumBytes) {
    throw invalidResponse();
  }
  return value;
};

const normalizeTranscription = (transcription) => {
  if (!isPlainDataRecord(transcription)
      || !engineIds.has(transcription.engine)
      || !backends.has(transcription.backend)) {
    throw invalidResponse();
  }

  const text = requireResponseText(transcription.text, MAX_TRANSCRIPT_BYTES);
  if (containsDisallowedControl(text)) throw invalidResponse();

  const durationMs = requireResponseMilliseconds(transcription.durationMs, MAX_DURATION_MS);
  if (durationMs === 0 || !Array.isArray(transcription.segments)
      || transcription.segments.length > MAX_SEGMENTS) {
    throw invalidResponse();
  }

  let segmentTextBytes = 0;
  let previousStartMs = 0;
  const segments = transcription.segments.map((segment) => {
    if (!isPlainDataRecord(segment)) throw invalidResponse();
    const startMs = requireResponseMilliseconds(segment.startMs, durationMs);
    const endMs = requireResponseMilliseconds(segment.endMs, durationMs);
    const segmentText = requireResponseText(
      segment.text,
      MAX_SEGMENT_TEXT_BYTES,
      { nonBlank: true }
    );
    segmentTextBytes += utf8ByteLength(segmentText);
    if (segmentTextBytes > MAX_SEGMENT_TEXT_BYTES
        || startMs < previousStartMs
        || endMs <= startMs
        || containsAnyControl(segmentText)) {
      throw invalidResponse();
    }
    previousStartMs = startMs;
    return Object.freeze({ startMs, endMs, text: segmentText });
  });

  const language = transcription.language;
  if (language !== null && language !== undefined
      && (typeof language !== 'string' || !/^[a-z]{2}$/.test(language))) {
    throw invalidResponse();
  }

  return Object.freeze({
    engine: transcription.engine,
    text,
    segments: Object.freeze(segments),
    durationMs,
    language: language ?? null,
    backend: transcription.backend,
  });
};

export const normalizeAsrJobEvent = (value) => {
  if (!isPlainDataRecord(value) || typeof value.event !== 'string') throw invalidResponse();

  switch (value.event) {
    case 'progress': {
      const rank = progressPhaseRank.get(value.phase);
      if (!isUuidV7(value.jobId) || rank === undefined) throw invalidResponse();
      const fraction = value.fraction;
      if (fraction !== null
          && (typeof fraction !== 'number'
            || !Number.isFinite(fraction)
            || fraction < 0
            || fraction > 1)) {
        throw invalidResponse();
      }
      return Object.freeze({
        event: 'progress',
        jobId: value.jobId,
        phase: value.phase,
        fraction,
      });
    }
    case 'completed': {
      const job = normalizeJobSnapshot(value.job);
      if (job.state !== 'succeeded') throw invalidResponse();
      const transcription = normalizeTranscription(value.transcription);
      const timelineOffsetMs = requireResponseMilliseconds(value.timelineOffsetMs);
      if (timelineOffsetMs > Number.MAX_SAFE_INTEGER - transcription.durationMs) {
        throw invalidResponse();
      }
      return Object.freeze({
        event: 'completed',
        job,
        transcription,
        timelineOffsetMs,
      });
    }
    case 'cancelled': {
      const job = normalizeJobSnapshot(value.job);
      if (job.state !== 'cancelled') throw invalidResponse();
      return Object.freeze({ event: 'cancelled', job });
    }
    case 'failed': {
      if (!Object.prototype.hasOwnProperty.call(value, 'job')) throw invalidResponse();
      const job = value.job == null ? null : normalizeJobSnapshot(value.job);
      if (job !== null
          && (job.state === 'queued'
            || job.state === 'succeeded'
            || job.state === 'cancelled')) {
        throw invalidResponse();
      }
      return Object.freeze({
        event: 'failed',
        job,
        error: normalizeCommandError(value.error),
      });
    }
    default:
      throw invalidResponse();
  }
};

export const normalizeAsrStatus = (status) => {
  if (!isPlainDataRecord(status)
      || typeof status.workerAvailable !== 'boolean'
      || !Array.isArray(status.engines)
      || status.engines.length !== ASR_ENGINE_CATALOG.length) {
    throw invalidResponse();
  }

  const byId = new Map();
  status.engines.forEach((engine) => {
    if (!isPlainDataRecord(engine)
        || !engineIds.has(engine.id)
        || byId.has(engine.id)
        || typeof engine.label !== 'string'
        || engine.label.trim().length === 0
        || !characterCountWithin(engine.label, MAX_LABEL_CHARACTERS)
        || containsAnyControl(engine.label)
        || typeof engine.installed !== 'boolean'
        || typeof engine.ready !== 'boolean'
        || typeof engine.warm !== 'boolean') {
      throw invalidResponse();
    }

    const metadata = engineById.get(engine.id);
    if (engine.runtime !== metadata.runtime
        || engine.supportsForcedLanguage !== metadata.supportsForcedLanguage
        || engine.requiresAligner !== metadata.requiresAligner
        || (engine.ready && !engine.installed)
        || (engine.warm && !engine.ready)
        || (!status.workerAvailable && (engine.ready || engine.warm))) {
      throw invalidResponse();
    }

    byId.set(engine.id, Object.freeze({
      ...metadata,
      label: engine.label,
      installed: engine.installed,
      ready: engine.ready,
      warm: engine.warm,
    }));
  });

  return Object.freeze({
    workerAvailable: status.workerAvailable,
    engines: Object.freeze(ASR_ENGINE_IDS.map((id) => byId.get(id))),
  });
};

const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  if (!hasOnlyKeys(handlers, handlerKeys)) throw invalidRequest();
  for (const handler of Object.values(handlers)) {
    if (handler !== undefined && typeof handler !== 'function') throw invalidRequest();
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(handlers).filter(([, handler]) => handler !== undefined)
  ));
};

const normalizeStartOptions = (options) => {
  if (options === undefined) return Object.freeze({ signal: null });
  if (!hasOnlyKeys(options, startOptionKeys)) throw invalidRequest();
  const signal = options.signal;
  if (signal === undefined || signal === null) return Object.freeze({ signal: null });
  if (!isRecord(signal)
      || typeof signal.aborted !== 'boolean'
      || typeof signal.addEventListener !== 'function'
      || typeof signal.removeEventListener !== 'function') {
    throw invalidRequest();
  }
  return Object.freeze({ signal });
};

/**
 * Native-only local-ASR bridge. Media is selected by the privileged desktop session; this module
 * never accepts a file path or raw media payload and has no HTTP or browser-storage fallback.
 */
export const createNativeAsrService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const requireNativeRuntime = () => {
    if (!isNativeRuntime()) throw desktopRequired();
  };

  const getAsrStatus = async () => {
    requireNativeRuntime();
    return normalizeAsrStatus(await invokeCommand('asr_status', {}));
  };

  const cancelAsrJob = async (jobId) => {
    requireNativeRuntime();
    const id = requireUuidV7(jobId);
    const snapshot = normalizeJobSnapshot(await invokeCommand('job_cancel', { id }));
    if (snapshot.id !== id
        || (snapshot.state !== 'cancelling' && snapshot.state !== 'cancelled')) {
      throw invalidResponse();
    }
    return snapshot;
  };

  const startAsrJob = async (request, rawHandlers, rawOptions) => {
    requireNativeRuntime();
    const normalizedRequest = normalizeAsrStartRequest(request);
    const handlers = normalizeHandlers(rawHandlers);
    const { signal } = normalizeStartOptions(rawOptions);
    if (signal?.aborted) throw cancelledRequest();
    const pendingEvents = [];
    let initial = null;
    let terminal = false;
    let protocolError = null;
    let eventCount = 0;
    let lastPhaseRank = -1;
    let lastFraction = null;
    let abortRequested = signal?.aborted ?? false;
    let abortCancellationIssued = false;
    let abortListenerAttached = false;

    const safelyCall = (handler, argument) => {
      if (typeof handler !== 'function') return;
      const reportHandlerError = (error) => {
        if (typeof handlers.onHandlerError !== 'function') return;
        try {
          const diagnosticResult = handlers.onHandlerError(error);
          if (diagnosticResult && typeof diagnosticResult.catch === 'function') {
            diagnosticResult.catch(() => undefined);
          }
        } catch {
          // Diagnostic callbacks cannot be allowed to break Tauri's Channel callback.
        }
      };
      try {
        const result = handler(argument);
        if (result && typeof result.catch === 'function') result.catch(reportHandlerError);
      } catch (error) {
        reportHandlerError(error);
      }
    };

    const removeAbortListener = () => {
      if (!signal || !abortListenerAttached) return;
      abortListenerAttached = false;
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // A foreign AbortSignal implementation cannot compromise job event cleanup.
      }
    };

    const release = () => {
      if (initial !== null) activeChannels.delete(initial.id);
      removeAbortListener();
    };

    const issueCancellation = () => {
      if (abortCancellationIssued || initial === null || terminal) return;
      abortCancellationIssued = true;
      cancelAsrJob(initial.id)
        .then((snapshot) => {
          if (snapshot.state === 'cancelled') {
            terminal = true;
            release();
          }
        })
        .catch((error) => {
          safelyCall(handlers.onCancellationError, error);
        });
    };

    const protocolFailure = (error = invalidResponse()) => {
      if (protocolError !== null || terminal) return;
      protocolError = error;
      pendingEvents.length = 0;
      safelyCall(handlers.onProtocolError, error);
      issueCancellation();
      release();
    };

    function onAbort() {
      abortRequested = true;
      issueCancellation();
    }

    const dispatch = (event) => {
      if (terminal || protocolError !== null) return;
      if (eventCount >= MAX_JOB_EVENTS) {
        protocolFailure();
        return;
      }
      eventCount += 1;

      const eventJobId = event.event === 'progress' ? event.jobId : event.job?.id;
      if (eventJobId !== undefined && eventJobId !== null && eventJobId !== initial.id) {
        protocolFailure();
        return;
      }
      if (event.event !== 'progress'
          && event.job !== null
          && event.job.sequence < initial.sequence) {
        protocolFailure();
        return;
      }

      if (event.event === 'progress') {
        const phaseRank = progressPhaseRank.get(event.phase);
        if (phaseRank < lastPhaseRank
            || (phaseRank === lastPhaseRank
              && event.fraction !== null
              && lastFraction !== null
              && event.fraction < lastFraction)) {
          protocolFailure();
          return;
        }
        if (phaseRank !== lastPhaseRank) lastFraction = null;
        lastPhaseRank = phaseRank;
        if (event.fraction !== null) lastFraction = event.fraction;
      } else if (event.event === 'completed') {
        const expectedOffset = normalizedRequest.range?.startMs ?? 0;
        if (event.transcription.engine !== normalizedRequest.engine
            || event.timelineOffsetMs !== expectedOffset) {
          protocolFailure();
          return;
        }
      }

      if (event.event === 'completed'
          || event.event === 'cancelled'
          || event.event === 'failed') {
        terminal = true;
        release();
      }

      safelyCall(handlers.onEvent, event);
      if (event.event === 'progress') safelyCall(handlers.onProgress, event);
      if (event.event === 'completed') safelyCall(handlers.onCompleted, event);
      if (event.event === 'cancelled') safelyCall(handlers.onCancelled, event);
      if (event.event === 'failed') safelyCall(handlers.onFailed, event);
    };

    const channel = new ChannelConstructor();

    if (signal) {
      try {
        signal.addEventListener('abort', onAbort, { once: true });
        abortListenerAttached = true;
      } catch {
        throw invalidRequest();
      }
    }

    channel.onmessage = (rawEvent) => {
      if (terminal || protocolError !== null) return;
      let event;
      try {
        event = normalizeAsrJobEvent(rawEvent);
      } catch (error) {
        protocolFailure(error);
        return;
      }

      if (initial === null) {
        if (pendingEvents.length >= MAX_PENDING_EVENTS) {
          protocolFailure();
          return;
        }
        pendingEvents.push(event);
        return;
      }
      dispatch(event);
    };

    let snapshot;
    try {
      snapshot = normalizeJobSnapshot(await invokeCommand('asr_start', {
        request: normalizedRequest,
        onEvent: channel,
      }));
      initial = snapshot;
      if (snapshot.state !== 'running'
          || snapshot.progress.basisPoints !== 0
          || snapshot.sequence !== 1) {
        protocolFailure();
        throw protocolError;
      }
    } catch (error) {
      pendingEvents.length = 0;
      removeAbortListener();
      throw error;
    }

    if (protocolError !== null) {
      issueCancellation();
      release();
      throw protocolError;
    }
    activeChannels.set(snapshot.id, channel);
    for (const event of pendingEvents.splice(0)) {
      dispatch(event);
      if (protocolError !== null) break;
    }
    if (protocolError !== null) {
      issueCancellation();
      release();
      throw protocolError;
    }
    if (terminal) release();
    else if (abortRequested || signal?.aborted) issueCancellation();
    return snapshot;
  };

  return Object.freeze({ getAsrStatus, startAsrJob, cancelAsrJob });
};

const asrService = createNativeAsrService();

export const getAsrStatus = asrService.getAsrStatus;
export const startAsrJob = asrService.startAsrJob;
export const cancelAsrJob = asrService.cancelAsrJob;
