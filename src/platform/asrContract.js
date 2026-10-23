// Local-ASR bridge contract: engine catalog, request normalization, and strict validation of the
// host's status replies, job snapshots and channel events.
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { hasOnlyKeys, isPlainDataRecord, isRecord, utf8ByteLength } from './plainDataRecord';

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
const ASR_STRATEGIES = Object.freeze(['sentence', 'word', 'character']);
const ASR_PROGRESS_PHASES = Object.freeze([
  'preparingAudio',
  'modelLoading',
  'transcribing',
  'finalizing',
]);

export const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
const MAX_LABEL_CHARACTERS = 256;
const MAX_ERROR_MESSAGE_CHARACTERS = 4_096;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENT_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_SEGMENTS = 250_000;
export const MAX_PENDING_EVENTS = 4_096;
export const MAX_JOB_EVENTS = 250_000;

const engineById = new Map(ASR_ENGINE_CATALOG.map((engine) => [engine.id, engine]));
const engineIds = new Set(ASR_ENGINE_IDS);
const strategies = new Set(ASR_STRATEGIES);
export const progressPhaseRank = new Map(ASR_PROGRESS_PHASES.map((phase, index) => [phase, index]));
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

export const invalidRequest = () => new AsrServiceError(
  'invalidAsrRequest',
  'The native ASR request is invalid'
);

export const invalidResponse = () => new AsrServiceError(
  'invalidAsrResponse',
  'The desktop host returned invalid ASR data'
);

export const desktopRequired = () => new AsrServiceError(
  'desktopAsrRequired',
  'Local ASR requires the desktop runtime'
);

export const cancelledRequest = () => new AsrServiceError(
  'asrCancelled',
  'The native ASR request was cancelled'
);

export const requireUuidV7 = (value) => {
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

export const normalizeJobSnapshot = (snapshot) => {
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
      if (job.state !== 'succeeded' || !isUuidV7(value.deliveryId)) throw invalidResponse();
      const transcription = normalizeTranscription(value.transcription);
      const timelineOffsetMs = requireResponseMilliseconds(value.timelineOffsetMs);
      if (timelineOffsetMs > Number.MAX_SAFE_INTEGER - transcription.durationMs) {
        throw invalidResponse();
      }
      return Object.freeze({
        event: 'completed',
        job,
        deliveryId: value.deliveryId,
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
        || typeof engine.warm !== 'boolean'
        || typeof engine.starting !== 'boolean') {
      throw invalidResponse();
    }

    const metadata = engineById.get(engine.id);
    if (engine.runtime !== metadata.runtime
        || engine.supportsForcedLanguage !== metadata.supportsForcedLanguage
        || engine.requiresAligner !== metadata.requiresAligner
        || (engine.ready && !engine.installed)
        || (engine.warm && !engine.ready)
        || (engine.starting && (!engine.ready || engine.warm))
        || (!status.workerAvailable && (engine.ready || engine.warm || engine.starting))) {
      throw invalidResponse();
    }

    byId.set(engine.id, Object.freeze({
      ...metadata,
      label: engine.label,
      installed: engine.installed,
      ready: engine.ready,
      warm: engine.warm,
      starting: engine.starting,
    }));
  });

  return Object.freeze({
    workerAvailable: status.workerAvailable,
    engines: Object.freeze(ASR_ENGINE_IDS.map((id) => byId.get(id))),
  });
};

export const normalizeHandlers = (handlers) => {
  if (handlers === undefined) return Object.freeze({});
  if (!hasOnlyKeys(handlers, handlerKeys)) throw invalidRequest();
  for (const handler of Object.values(handlers)) {
    if (handler !== undefined && typeof handler !== 'function') throw invalidRequest();
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(handlers).filter(([, handler]) => handler !== undefined)
  ));
};

export const normalizeStartOptions = (options) => {
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

