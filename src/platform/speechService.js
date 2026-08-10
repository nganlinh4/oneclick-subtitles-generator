import { Channel } from '@tauri-apps/api/core';
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

export const SPEECH_BACKENDS = Object.freeze([
  'f5Tts',
  'chatterbox',
  'edgeTts',
  'gtts',
  'geminiTts',
]);

export const GEMINI_SPEECH_MODELS = Object.freeze([
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
]);

export const GEMINI_SPEECH_VOICES = Object.freeze([
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
]);

export const GTTS_DOMAINS = Object.freeze([
  'com', 'com.au', 'co.uk', 'us', 'ca', 'co.in', 'ie', 'co.za',
  'com.br', 'pt', 'es', 'com.mx', 'fr',
]);

export const CHATTERBOX_LANGUAGES = Object.freeze([
  'ar', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja',
  'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'tr', 'zh',
]);

export const SPEECH_PROGRESS_PHASES = Object.freeze([
  'startingWorker',
  'loadingModel',
  'synthesizing',
  'encoding',
  'publishing',
]);

export const MAX_SPEECH_SEGMENTS = 1_000;
export const MAX_SPEECH_BATCH_BYTES = 4 * 1024 * 1024;

const MAX_SEGMENT_TEXT_BYTES = 16 * 1024;
const MAX_SEGMENT_TEXT_CHARACTERS = 8_000;
const MAX_CHATTERBOX_CHARACTERS = 300;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 64 * 1024 * 1024;
const MAX_TIME_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_TIME_MICROS = MAX_TIME_MS * 1_000;
const MAX_VOICES = 2_048;
const MAX_PENDING_EVENTS = 4_096;
const MAX_JOB_EVENTS = 20_000;
const MAX_EXPORT_FILE_NAME_CHARACTERS = 128;

const backendSet = new Set(SPEECH_BACKENDS);
const geminiModelSet = new Set(GEMINI_SPEECH_MODELS);
const geminiVoiceSet = new Set(GEMINI_SPEECH_VOICES);
const gttsDomainSet = new Set(GTTS_DOMAINS);
const chatterboxLanguageSet = new Set(CHATTERBOX_LANGUAGES);
const phaseSet = new Set(SPEECH_PROGRESS_PHASES);
const jobStateSet = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
const failureCodeSet = new Set([
  'cancelled',
  'invalidRequest',
  'runtimeUnavailable',
  'modelUnavailable',
  'providerUnavailable',
  'providerRateLimited',
  'authenticationFailed',
  'referenceRejected',
  'synthesisFailed',
  'encodingFailed',
  'timedOut',
  'workerFailed',
  'artifactStorage',
]);
const resultStatusSet = new Set(['completed', 'failed']);
const formatSet = new Set(['wav', 'mp3', 'm4a']);
const genderSet = new Set(['female', 'male', 'neutral', 'unknown']);
const referenceBackendSet = new Set(['f5Tts', 'chatterbox']);

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

const hasExactKeys = (value, keys) => (
  isPlainDataRecord(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
);

const hasOnlyKeys = (value, keys) => (
  isPlainDataRecord(value) && Object.keys(value).every((key) => keys.has(key))
);

const utf8ByteLength = (value) => {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point <= 0x7f) bytes += 1;
    else if (point <= 0x7ff) bytes += 2;
    else if (point <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};

const characterCount = (value, maximum = Number.MAX_SAFE_INTEGER) => {
  let count = 0;
  for (const unused of value) {
    void unused;
    count += 1;
    if (count > maximum) return count;
  }
  return count;
};

const hasInvalidControls = (value, allowWhitespace = false) => {
  for (const character of value) {
    const point = character.codePointAt(0);
    if ((point < 32 || point === 127)
        && !(allowWhitespace && (character === '\n' || character === '\t'))) {
      return true;
    }
  }
  return false;
};

const uuidHasVersion = (value, expected) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expected;
  } catch {
    return false;
  }
};

export class SpeechServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SpeechServiceError';
    this.code = code;
  }
}

const invalidRequest = () => new SpeechServiceError(
  'invalidSpeechRequest',
  'The native speech request is invalid'
);

const invalidResponse = () => new SpeechServiceError(
  'invalidSpeechResponse',
  'The desktop host returned invalid speech data'
);

const desktopRequired = () => new SpeechServiceError(
  'desktopSpeechRequired',
  'Native speech requires the desktop runtime'
);

const cancelledRequest = () => new SpeechServiceError(
  'speechCancelled',
  'The native speech request was cancelled'
);

const requireInteger = (value, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidRequest();
  }
  return value;
};

const requireUuid = (value, version) => {
  if (!uuidHasVersion(value, version)) throw invalidRequest();
  return value;
};

const requireIdentifier = (value, maximum = 128) => {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > maximum
      || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw invalidRequest();
  }
  return value;
};

const requireLanguage = (value) => {
  if (typeof value !== 'string'
      || value.length < 2
      || value.length > 35
      || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value)) {
    throw invalidRequest();
  }
  return value;
};

const normalizeSpeechText = (value, maximumCharacters = MAX_SEGMENT_TEXT_CHARACTERS) => {
  if (typeof value !== 'string') throw invalidRequest();
  const normalized = value.trim();
  if (normalized.length === 0
      || utf8ByteLength(normalized) > MAX_SEGMENT_TEXT_BYTES
      || characterCount(normalized, maximumCharacters) > maximumCharacters
      || hasInvalidControls(normalized, true)) {
    throw invalidRequest();
  }
  return normalized;
};

const profileKeys = Object.freeze({
  f5Tts: new Set([
    'backend', 'referenceText', 'model', 'speechRateMilli', 'nfeSteps', 'swayMilli',
    'guidanceMilli', 'seed', 'removeSilence',
  ]),
  chatterbox: new Set(['backend', 'language', 'exaggerationMilli', 'cfgWeightMilli']),
  edgeTts: new Set(['backend', 'voice', 'ratePercent', 'volumePercent', 'pitchHz']),
  gtts: new Set(['backend', 'language', 'domain', 'slow']),
  geminiTts: new Set(['backend', 'credentialId', 'model', 'voice', 'language']),
});

export const normalizeSpeechProfile = (profile) => {
  if (!isPlainDataRecord(profile) || !backendSet.has(profile.backend)) throw invalidRequest();
  if (!hasOnlyKeys(profile, profileKeys[profile.backend])) throw invalidRequest();

  switch (profile.backend) {
    case 'f5Tts': {
      const referenceText = profile.referenceText === undefined || profile.referenceText === null
        ? null
        : normalizeSpeechText(profile.referenceText);
      const model = profile.model === undefined || profile.model === null
        ? null
        : profile.model;
      if (model !== null && model !== 'f5tts-v1-base' && model !== 'F5TTS_v1_Base') {
        throw invalidRequest();
      }
      const seed = profile.seed === undefined || profile.seed === null
        ? null
        : requireInteger(profile.seed, 0, Number.MAX_SAFE_INTEGER);
      const removeSilence = profile.removeSilence ?? true;
      if (typeof removeSilence !== 'boolean') throw invalidRequest();
      return Object.freeze({
        backend: 'f5Tts',
        referenceText,
        model,
        speechRateMilli: requireInteger(profile.speechRateMilli ?? 1_100, 500, 2_000),
        nfeSteps: (() => {
          const value = requireInteger(profile.nfeSteps ?? 32, 8, 64);
          if (![8, 16, 32, 64].includes(value)) throw invalidRequest();
          return value;
        })(),
        swayMilli: requireInteger(profile.swayMilli ?? -1_000, -1_100, 1_700),
        guidanceMilli: requireInteger(profile.guidanceMilli ?? 2_000, 1_000, 5_000),
        seed,
        removeSilence,
      });
    }
    case 'chatterbox': {
      const language = requireLanguage(profile.language ?? 'en').toLowerCase();
      if (!chatterboxLanguageSet.has(language)) throw invalidRequest();
      return Object.freeze({
        backend: 'chatterbox',
        language,
        exaggerationMilli: requireInteger(profile.exaggerationMilli ?? 1_000, 250, 2_000),
        cfgWeightMilli: requireInteger(profile.cfgWeightMilli ?? 500, 0, 1_000),
      });
    }
    case 'edgeTts':
      return Object.freeze({
        backend: 'edgeTts',
        voice: requireIdentifier(profile.voice),
        ratePercent: requireInteger(profile.ratePercent ?? 0, -100, 100),
        volumePercent: requireInteger(profile.volumePercent ?? 0, -100, 100),
        pitchHz: requireInteger(profile.pitchHz ?? 0, -100, 100),
      });
    case 'gtts': {
      const domain = profile.domain ?? 'com';
      const slow = profile.slow ?? false;
      if (!gttsDomainSet.has(domain) || typeof slow !== 'boolean') throw invalidRequest();
      return Object.freeze({
        backend: 'gtts',
        language: requireLanguage(profile.language),
        domain,
        slow,
      });
    }
    case 'geminiTts': {
      const model = profile.model ?? GEMINI_SPEECH_MODELS[0];
      const voice = profile.voice ?? 'Aoede';
      if (!geminiModelSet.has(model) || !geminiVoiceSet.has(voice)) throw invalidRequest();
      return Object.freeze({
        backend: 'geminiTts',
        credentialId: requireUuid(profile.credentialId, 7),
        model,
        voice,
        language: requireLanguage(profile.language ?? 'en-US'),
      });
    }
    default:
      throw invalidRequest();
  }
};

export const normalizeSpeechStartRequest = (request) => {
  const allowed = new Set(['segments', 'profile', 'referenceArtifactId']);
  if (!hasOnlyKeys(request, allowed) || !Array.isArray(request.segments)) throw invalidRequest();
  if (request.segments.length === 0 || request.segments.length > MAX_SPEECH_SEGMENTS) {
    throw invalidRequest();
  }
  const profile = normalizeSpeechProfile(request.profile);
  const maximumCharacters = profile.backend === 'chatterbox'
    ? MAX_CHATTERBOX_CHARACTERS
    : MAX_SEGMENT_TEXT_CHARACTERS;
  const seen = new Set();
  let totalBytes = 0;
  const segments = request.segments.map((segment) => {
    if (!hasExactKeys(segment, ['id', 'text'])) throw invalidRequest();
    const id = requireIdentifier(segment.id, 96);
    if (seen.has(id)) throw invalidRequest();
    seen.add(id);
    const text = normalizeSpeechText(segment.text, maximumCharacters);
    totalBytes += utf8ByteLength(text);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SPEECH_BATCH_BYTES) {
      throw invalidRequest();
    }
    return Object.freeze({ id, text });
  });
  const requiresReference = profile.backend === 'f5Tts' || profile.backend === 'chatterbox';
  const referenceArtifactId = request.referenceArtifactId === undefined
    || request.referenceArtifactId === null
    ? null
    : requireUuid(request.referenceArtifactId, 7);
  if (requiresReference !== (referenceArtifactId !== null)) throw invalidRequest();
  return Object.freeze({ segments: Object.freeze(segments), profile, referenceArtifactId });
};

const requireResponseInteger = (value, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidResponse();
  }
  return value;
};

const requireResponseIdentifier = (value, maximum = 128) => {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > maximum
      || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw invalidResponse();
  }
  return value;
};

const requireResponseLanguage = (value) => {
  if (typeof value !== 'string'
      || value.length < 2
      || value.length > 35
      || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value)) {
    throw invalidResponse();
  }
  return value;
};

const normalizeJobSnapshot = (snapshot) => {
  if (!hasExactKeys(snapshot, ['id', 'kind', 'state', 'progress', 'sequence'])
      || !hasExactKeys(snapshot.progress, ['basisPoints'])
      || !uuidHasVersion(snapshot.id, 7)
      || snapshot.kind !== 'synthesizeNarration'
      || !jobStateSet.has(snapshot.state)) {
    throw invalidResponse();
  }
  const basisPoints = requireResponseInteger(snapshot.progress.basisPoints, 0, 10_000);
  const sequence = requireResponseInteger(snapshot.sequence, 0, Number.MAX_SAFE_INTEGER);
  const validState = snapshot.state === 'queued'
    ? basisPoints === 0 && sequence === 0
    : snapshot.state === 'succeeded'
      ? basisPoints === 10_000 && sequence >= 2
      : sequence >= 1;
  if (!validState) throw invalidResponse();
  return Object.freeze({
    id: snapshot.id,
    kind: snapshot.kind,
    state: snapshot.state,
    progress: Object.freeze({ basisPoints }),
    sequence,
  });
};

const normalizeBackendStatus = (status) => {
  if (!hasExactKeys(status, [
    'backend',
    'installed',
    'ready',
    'warm',
    'requiresReference',
    'supportsVoiceInventory',
    'supportsVoiceConversion',
    'requiresCredential',
  ]) || !backendSet.has(status.backend)) {
    throw invalidResponse();
  }
  for (const key of [
    'installed',
    'ready',
    'warm',
    'requiresReference',
    'supportsVoiceInventory',
    'supportsVoiceConversion',
    'requiresCredential',
  ]) {
    if (typeof status[key] !== 'boolean') throw invalidResponse();
  }
  const expected = {
    requiresReference: status.backend === 'f5Tts' || status.backend === 'chatterbox',
    supportsVoiceInventory: ['edgeTts', 'gtts', 'geminiTts'].includes(status.backend),
    supportsVoiceConversion: status.backend === 'chatterbox',
    requiresCredential: status.backend === 'geminiTts',
  };
  if ((status.ready && !status.installed)
      || (status.warm && !status.ready)
      || Object.entries(expected).some(([key, value]) => status[key] !== value)) {
    throw invalidResponse();
  }
  return Object.freeze({ ...status });
};

export const normalizeSpeechStatus = (status) => {
  if (!hasExactKeys(status, ['backends', 'maxSegmentsPerJob', 'maxBatchTextBytes'])
      || !Array.isArray(status.backends)
      || status.backends.length !== SPEECH_BACKENDS.length
      || status.maxSegmentsPerJob !== MAX_SPEECH_SEGMENTS
      || status.maxBatchTextBytes !== MAX_SPEECH_BATCH_BYTES) {
    throw invalidResponse();
  }
  const byBackend = new Map();
  for (const rawBackend of status.backends) {
    const backend = normalizeBackendStatus(rawBackend);
    if (byBackend.has(backend.backend)) throw invalidResponse();
    byBackend.set(backend.backend, backend);
  }
  if (SPEECH_BACKENDS.some((backend) => !byBackend.has(backend))) throw invalidResponse();
  return Object.freeze({
    backends: Object.freeze(SPEECH_BACKENDS.map((backend) => byBackend.get(backend))),
    maxSegmentsPerJob: MAX_SPEECH_SEGMENTS,
    maxBatchTextBytes: MAX_SPEECH_BATCH_BYTES,
  });
};

const normalizeVoice = (voice) => {
  if (!hasExactKeys(voice, ['id', 'displayName', 'language', 'gender'])
      || !genderSet.has(voice.gender)
      || typeof voice.displayName !== 'string'
      || voice.displayName.trim().length === 0
      || voice.displayName.length > 256
      || hasInvalidControls(voice.displayName)) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: requireResponseIdentifier(voice.id),
    displayName: voice.displayName,
    language: requireResponseLanguage(voice.language),
    gender: voice.gender,
  });
};

export const normalizeSpeechProbe = (probe, expectedBackend) => {
  if (!hasExactKeys(probe, ['status', 'voices'])
      || !backendSet.has(expectedBackend)
      || !Array.isArray(probe.voices)
      || probe.voices.length > MAX_VOICES) {
    throw invalidResponse();
  }
  const status = normalizeBackendStatus(probe.status);
  if (status.backend !== expectedBackend || !status.ready) throw invalidResponse();
  const ids = new Set();
  const voices = probe.voices.map((rawVoice) => {
    const voice = normalizeVoice(rawVoice);
    if (ids.has(voice.id)) throw invalidResponse();
    ids.add(voice.id);
    return voice;
  });
  if (!status.supportsVoiceInventory && voices.length !== 0) throw invalidResponse();
  if (expectedBackend === 'geminiTts'
      && (voices.length !== GEMINI_SPEECH_VOICES.length
        || voices.some((voice) => !geminiVoiceSet.has(voice.id)))) {
    throw invalidResponse();
  }
  return Object.freeze({ status, voices: Object.freeze(voices) });
};

export const normalizeSpeechArtifact = (artifact) => {
  if (!hasExactKeys(artifact, [
    'artifactId', 'format', 'bytes', 'durationMicros', 'sampleRateHz', 'channels',
  ]) || !uuidHasVersion(artifact.artifactId, 7)
      || !formatSet.has(artifact.format)) {
    throw invalidResponse();
  }
  const bytes = requireResponseInteger(artifact.bytes, 1, MAX_ARTIFACT_BYTES);
  const durationMicros = artifact.durationMicros === null
    ? null
    : requireResponseInteger(artifact.durationMicros, 1, MAX_TIME_MICROS);
  const sampleRateHz = artifact.sampleRateHz === null
    ? null
    : requireResponseInteger(artifact.sampleRateHz, 8_000, 384_000);
  const channels = artifact.channels === null
    ? null
    : requireResponseInteger(artifact.channels, 1, 8);
  return Object.freeze({
    artifactId: artifact.artifactId,
    format: artifact.format,
    bytes,
    durationMicros,
    sampleRateHz,
    channels,
  });
};

const normalizePlayback = (playback, artifact) => {
  if (!hasExactKeys(playback, ['id', 'playbackUrl', 'mimeType', 'byteLength'])
      || !uuidHasVersion(playback.id, 4)
      || typeof playback.playbackUrl !== 'string'
      || typeof playback.mimeType !== 'string'
      || !/^audio\/[A-Za-z0-9!#$&^_.+-]{1,127}$/.test(playback.mimeType)
      || playback.byteLength !== artifact.bytes) {
    throw invalidResponse();
  }
  let parsed;
  try {
    parsed = new URL(playback.playbackUrl);
  } catch {
    throw invalidResponse();
  }
  const token = parsed.searchParams.getAll('token');
  if (parsed.protocol !== 'http:'
      || parsed.hostname !== '127.0.0.1'
      || !/^\d{1,5}$/.test(parsed.port)
      || Number(parsed.port) < 1
      || Number(parsed.port) > 65_535
      || parsed.pathname !== `/asset/${playback.id}`
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hash !== ''
      || [...parsed.searchParams.keys()].some((key) => key !== 'token')
      || token.length !== 1
      || !/^[a-f0-9]{64}$/.test(token[0])) {
    throw invalidResponse();
  }
  return Object.freeze({
    id: playback.id,
    playbackUrl: playback.playbackUrl,
    mimeType: playback.mimeType,
    byteLength: playback.byteLength,
  });
};

export const normalizePlayableArtifact = (value, maximumBytes = MAX_ARTIFACT_BYTES) => {
  if (!hasExactKeys(value, ['artifact', 'playback'])) throw invalidResponse();
  const artifact = normalizeSpeechArtifact(value.artifact);
  if (artifact.bytes > maximumBytes) throw invalidResponse();
  return Object.freeze({ artifact, playback: normalizePlayback(value.playback, artifact) });
};

const normalizeStoredResult = (result) => {
  if (!isPlainDataRecord(result) || !resultStatusSet.has(result.status)) throw invalidResponse();
  if (result.status === 'completed') {
    if (!hasExactKeys(result, ['status', 'segmentId', 'artifact'])) throw invalidResponse();
    return Object.freeze({
      status: 'completed',
      segmentId: requireResponseIdentifier(result.segmentId, 96),
      artifact: normalizeSpeechArtifact(result.artifact),
    });
  }
  if (!hasExactKeys(result, ['status', 'segmentId', 'code', 'retryable'])
      || !failureCodeSet.has(result.code)
      || typeof result.retryable !== 'boolean') {
    throw invalidResponse();
  }
  return Object.freeze({
    status: 'failed',
    segmentId: requireResponseIdentifier(result.segmentId, 96),
    code: result.code,
    retryable: result.retryable,
  });
};

const normalizeResultList = (results) => {
  if (!Array.isArray(results) || results.length > MAX_SPEECH_SEGMENTS) throw invalidResponse();
  const seen = new Set();
  return Object.freeze(results.map((rawResult) => {
    const result = normalizeStoredResult(rawResult);
    if (seen.has(result.segmentId)) throw invalidResponse();
    seen.add(result.segmentId);
    return result;
  }));
};

export const normalizeSpeechJobResults = (value) => {
  if (!hasExactKeys(value, ['job', 'backend', 'results']) || !backendSet.has(value.backend)) {
    throw invalidResponse();
  }
  return Object.freeze({
    job: normalizeJobSnapshot(value.job),
    backend: value.backend,
    results: normalizeResultList(value.results),
  });
};

const normalizeSpeechJobEvent = (rawEvent) => {
  if (!isPlainDataRecord(rawEvent) || typeof rawEvent.event !== 'string') throw invalidResponse();
  switch (rawEvent.event) {
    case 'progress': {
      if (!hasExactKeys(rawEvent, [
        'event', 'jobId', 'segmentId', 'index', 'total', 'phase', 'fractionMillionths',
      ]) || !uuidHasVersion(rawEvent.jobId, 7)
          || !phaseSet.has(rawEvent.phase)
          || (rawEvent.segmentId !== null
            && (() => {
              try {
                requireResponseIdentifier(rawEvent.segmentId, 96);
                return false;
              } catch {
                return true;
              }
            })())) {
        throw invalidResponse();
      }
      const total = requireResponseInteger(rawEvent.total, 1, MAX_SPEECH_SEGMENTS);
      const index = requireResponseInteger(rawEvent.index, 1, total);
      return Object.freeze({
        event: 'progress',
        jobId: rawEvent.jobId,
        segmentId: rawEvent.segmentId,
        index,
        total,
        phase: rawEvent.phase,
        fractionMillionths: requireResponseInteger(
          rawEvent.fractionMillionths,
          0,
          1_000_000
        ),
      });
    }
    case 'segmentCompleted':
    case 'segmentFailed': {
      if (!hasExactKeys(rawEvent, ['event', 'jobId', 'index', 'total', 'result'])
          || !uuidHasVersion(rawEvent.jobId, 7)) {
        throw invalidResponse();
      }
      const total = requireResponseInteger(rawEvent.total, 1, MAX_SPEECH_SEGMENTS);
      const index = requireResponseInteger(rawEvent.index, 1, total);
      const result = normalizeStoredResult(rawEvent.result);
      if ((rawEvent.event === 'segmentCompleted') !== (result.status === 'completed')) {
        throw invalidResponse();
      }
      return Object.freeze({ event: rawEvent.event, jobId: rawEvent.jobId, index, total, result });
    }
    case 'completed':
    case 'cancelled': {
      if (!hasExactKeys(rawEvent, ['event', 'job', 'results'])) throw invalidResponse();
      const job = normalizeJobSnapshot(rawEvent.job);
      if ((rawEvent.event === 'completed' && job.state !== 'succeeded')
          || (rawEvent.event === 'cancelled' && job.state !== 'cancelled')) {
        throw invalidResponse();
      }
      return Object.freeze({ event: rawEvent.event, job, results: normalizeResultList(rawEvent.results) });
    }
    case 'failed': {
      if (!hasExactKeys(rawEvent, ['event', 'job', 'results', 'code'])
          || !failureCodeSet.has(rawEvent.code)
          || (rawEvent.job !== null && !isPlainDataRecord(rawEvent.job))) {
        throw invalidResponse();
      }
      const job = rawEvent.job === null ? null : normalizeJobSnapshot(rawEvent.job);
      if (job !== null && job.state !== 'failed' && job.state !== 'cancelling') {
        throw invalidResponse();
      }
      return Object.freeze({
        event: 'failed',
        job,
        results: normalizeResultList(rawEvent.results),
        code: rawEvent.code,
      });
    }
    default:
      throw invalidResponse();
  }
};

const handlerKeys = new Set([
  'onEvent',
  'onProgress',
  'onSegmentCompleted',
  'onSegmentFailed',
  'onCompleted',
  'onCancelled',
  'onFailed',
  'onProtocolError',
  'onHandlerError',
  'onCancellationError',
]);
const startOptionKeys = new Set(['signal']);

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

const normalizeReferenceExtract = (request) => {
  if (!hasExactKeys(request, ['backend', 'startMs', 'endMs'])
      || !referenceBackendSet.has(request.backend)) {
    throw invalidRequest();
  }
  const startMs = requireInteger(request.startMs, 0, MAX_TIME_MS);
  const endMs = requireInteger(request.endMs, 1, MAX_TIME_MS);
  const maximum = request.backend === 'f5Tts' ? 12_000 : 60_000;
  if (endMs <= startMs || endMs - startMs > maximum) throw invalidRequest();
  return Object.freeze({ backend: request.backend, startMs, endMs });
};

const normalizeReferenceSelection = (request) => {
  if (!hasExactKeys(request, ['backend']) || !referenceBackendSet.has(request.backend)) {
    throw invalidRequest();
  }
  return Object.freeze({ backend: request.backend });
};

const normalizeReferenceImport = (request) => {
  if (!hasExactKeys(request, ['backend', 'assetId'])
      || !referenceBackendSet.has(request.backend)) {
    throw invalidRequest();
  }
  return Object.freeze({ backend: request.backend, assetId: requireUuid(request.assetId, 7) });
};

const normalizeArtifactEdit = (request) => {
  if (!hasExactKeys(request, [
    'artifactId', 'normalizedStart', 'normalizedEnd', 'speedFactor',
  ])) {
    throw invalidRequest();
  }
  const start = request.normalizedStart;
  const end = request.normalizedEnd;
  const speed = request.speedFactor;
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || start >= 1
      || typeof end !== 'number' || !Number.isFinite(end) || end <= start || end > 1
      || typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.25 || speed > 4) {
    throw invalidRequest();
  }
  const normalizedStartMillionths = Math.round(start * 1_000_000);
  const normalizedEndMillionths = Math.round(end * 1_000_000);
  const speedMilli = Math.round(speed * 1_000);
  if (normalizedStartMillionths >= normalizedEndMillionths
      || speedMilli < 250 || speedMilli > 4_000) {
    throw invalidRequest();
  }
  return Object.freeze({
    artifactId: requireUuid(request.artifactId, 7),
    normalizedStartMillionths,
    normalizedEndMillionths,
    speedMilli,
  });
};

const normalizeArtifactExport = (request) => {
  if (!hasExactKeys(request, ['entries', 'archiveName'])
      || !Array.isArray(request.entries)
      || request.entries.length === 0
      || request.entries.length > MAX_SPEECH_SEGMENTS) {
    throw invalidRequest();
  }
  const fileNames = new Set();
  const entries = request.entries.map((entry) => {
    if (!hasExactKeys(entry, ['artifactId', 'fileName'])
        || typeof entry.fileName !== 'string'
        || entry.fileName.length === 0
        || entry.fileName.length > MAX_EXPORT_FILE_NAME_CHARACTERS
        || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.(?:wav|mp3|m4a)$/.test(entry.fileName)
        || fileNames.has(entry.fileName)) {
      throw invalidRequest();
    }
    fileNames.add(entry.fileName);
    return Object.freeze({
      artifactId: requireUuid(entry.artifactId, 7),
      fileName: entry.fileName,
    });
  });
  const archiveName = request.archiveName;
  if ((entries.length > 1 && archiveName === null)
      || (archiveName !== null
        && (typeof archiveName !== 'string'
          || archiveName.length === 0
          || archiveName.length > MAX_EXPORT_FILE_NAME_CHARACTERS
          || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\.zip$/.test(archiveName)))) {
    throw invalidRequest();
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    archiveName,
  });
};

const normalizeVoiceConversionRequest = (request) => {
  if (!hasExactKeys(request, ['inputArtifactId', 'targetVoiceArtifactId'])) {
    throw invalidRequest();
  }
  return Object.freeze({
    inputArtifactId: requireUuid(request.inputArtifactId, 7),
    targetVoiceArtifactId: requireUuid(request.targetVoiceArtifactId, 7),
  });
};

/**
 * Strict native-only speech bridge. Requests contain only typed settings and opaque IDs. Native
 * paths, provider secrets, audio bytes, model arguments, and HTTP fallback URLs are deliberately
 * outside this API.
 */
export const createNativeSpeechService = ({
  invokeCommand = invokeDesktop,
  ChannelConstructor = Channel,
  isNativeRuntime = isDesktopRuntime,
} = {}) => {
  const activeChannels = new Map();

  const requireNativeRuntime = () => {
    if (!isNativeRuntime()) throw desktopRequired();
  };

  const cancelSpeechJob = async (jobId) => {
    requireNativeRuntime();
    const id = requireUuid(jobId, 7);
    const job = normalizeJobSnapshot(await invokeCommand('job_cancel', { id }));
    if (job.id !== id || job.state === 'queued' || job.state === 'running') {
      throw invalidResponse();
    }
    return job;
  };

  const startNativeJob = async ({
    command,
    request,
    expectedSegmentIds,
    handlers: rawHandlers,
    options: rawOptions,
  }) => {
    requireNativeRuntime();
    const handlers = normalizeHandlers(rawHandlers);
    const { signal } = normalizeStartOptions(rawOptions);
    if (signal?.aborted) throw cancelledRequest();

    const expectedIds = new Set(expectedSegmentIds);
    const pendingEvents = [];
    const terminalResults = new Map();
    const segmentEventIds = new Set();
    let initial = null;
    let terminal = false;
    let protocolError = null;
    let eventCount = 0;
    let abortRequested = false;
    let cancellationIssued = false;
    let abortListenerAttached = false;

    const safelyCall = (handler, argument) => {
      if (typeof handler !== 'function') return;
      const report = (error) => {
        if (typeof handlers.onHandlerError !== 'function') return;
        try {
          const result = handlers.onHandlerError(error);
          if (result && typeof result.catch === 'function') result.catch(() => undefined);
        } catch {
          // Diagnostic callbacks cannot break native channel processing.
        }
      };
      try {
        const result = handler(argument);
        if (result && typeof result.catch === 'function') result.catch(report);
      } catch (error) {
        report(error);
      }
    };

    const removeAbortListener = () => {
      if (!signal || !abortListenerAttached) return;
      abortListenerAttached = false;
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // Foreign AbortSignal implementations cannot compromise cleanup.
      }
    };

    const release = () => {
      if (initial !== null) activeChannels.delete(initial.id);
      removeAbortListener();
    };

    const issueCancellation = () => {
      if (cancellationIssued || initial === null || terminal) return;
      cancellationIssued = true;
      cancelSpeechJob(initial.id).catch((error) => {
        safelyCall(handlers.onCancellationError, error);
      });
    };

    const failProtocol = (error = invalidResponse()) => {
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

    const validateResultIdentity = (result) => {
      if (!expectedIds.has(result.segmentId)) throw invalidResponse();
    };

    const dispatch = (event) => {
      if (terminal || protocolError !== null) return;
      if (eventCount >= MAX_JOB_EVENTS) {
        failProtocol();
        return;
      }
      eventCount += 1;
      const eventJobId = event.event === 'progress'
        || event.event === 'segmentCompleted'
        || event.event === 'segmentFailed'
        ? event.jobId
        : event.job?.id;
      if (eventJobId !== undefined && eventJobId !== null && eventJobId !== initial.id) {
        failProtocol();
        return;
      }

      try {
        if (event.event === 'progress') {
          if (event.total !== expectedIds.size
              || (event.segmentId !== null && !expectedIds.has(event.segmentId))) {
            throw invalidResponse();
          }
        } else if (event.event === 'segmentCompleted' || event.event === 'segmentFailed') {
          validateResultIdentity(event.result);
          if (event.total !== expectedIds.size
              || segmentEventIds.has(event.result.segmentId)) {
            throw invalidResponse();
          }
          segmentEventIds.add(event.result.segmentId);
          terminalResults.set(event.result.segmentId, event.result);
        } else {
          const terminalIds = new Set();
          for (const result of event.results) {
            validateResultIdentity(result);
            terminalIds.add(result.segmentId);
            const streamed = terminalResults.get(result.segmentId);
            if (streamed !== undefined
                && JSON.stringify(streamed) !== JSON.stringify(result)) {
              throw invalidResponse();
            }
          }
          for (const segmentId of terminalResults.keys()) {
            if (!terminalIds.has(segmentId)) throw invalidResponse();
          }
          if (event.event === 'completed'
              && event.results.length !== expectedIds.size) {
            throw invalidResponse();
          }
        }
      } catch (error) {
        failProtocol(error);
        return;
      }

      if (event.event === 'completed'
          || event.event === 'cancelled'
          || event.event === 'failed') {
        terminal = true;
        release();
      }

      safelyCall(handlers.onEvent, event);
      if (event.event === 'progress') safelyCall(handlers.onProgress, event);
      if (event.event === 'segmentCompleted') safelyCall(handlers.onSegmentCompleted, event);
      if (event.event === 'segmentFailed') safelyCall(handlers.onSegmentFailed, event);
      if (event.event === 'completed') safelyCall(handlers.onCompleted, event);
      if (event.event === 'cancelled') safelyCall(handlers.onCancelled, event);
      if (event.event === 'failed') safelyCall(handlers.onFailed, event);
    };

    let channel;
    try {
      channel = new ChannelConstructor();
    } catch {
      throw invalidRequest();
    }
    if (!isRecord(channel)) throw invalidRequest();

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
        event = normalizeSpeechJobEvent(rawEvent);
      } catch (error) {
        failProtocol(error);
        return;
      }
      if (initial === null) {
        if (pendingEvents.length >= MAX_PENDING_EVENTS) {
          failProtocol();
          return;
        }
        pendingEvents.push(event);
        return;
      }
      dispatch(event);
    };

    let snapshot;
    try {
      snapshot = normalizeJobSnapshot(await invokeCommand(command, { request, onEvent: channel }));
      initial = snapshot;
      if (snapshot.state !== 'running'
          || snapshot.progress.basisPoints !== 0
          || snapshot.sequence !== 1) {
        failProtocol();
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

  const getSpeechStatus = async () => {
    requireNativeRuntime();
    return normalizeSpeechStatus(await invokeCommand('speech_status', {}));
  };

  const probeSpeechBackend = async (backend) => {
    requireNativeRuntime();
    if (!backendSet.has(backend)) throw invalidRequest();
    return normalizeSpeechProbe(await invokeCommand('speech_probe', { backend }), backend);
  };

  const stopSpeechRuntime = async (backend) => {
    requireNativeRuntime();
    if (!backendSet.has(backend)) throw invalidRequest();
    const value = await invokeCommand('speech_runtime_stop', { backend });
    if (value !== null && value !== undefined) throw invalidResponse();
  };

  const selectSpeechReference = async (request) => {
    requireNativeRuntime();
    const normalized = normalizeReferenceSelection(request);
    const value = await invokeCommand('speech_reference_select', { request: normalized });
    return value === null ? null : normalizePlayableArtifact(value, MAX_REFERENCE_BYTES);
  };

  const importSpeechReference = async (request) => {
    requireNativeRuntime();
    const normalized = normalizeReferenceImport(request);
    return normalizePlayableArtifact(
      await invokeCommand('speech_reference_import', { request: normalized }),
      MAX_REFERENCE_BYTES
    );
  };

  const extractSpeechReference = async (request) => {
    requireNativeRuntime();
    const normalized = normalizeReferenceExtract(request);
    return normalizePlayableArtifact(
      await invokeCommand('speech_reference_extract', { request: normalized }),
      MAX_REFERENCE_BYTES
    );
  };

  const startSpeechJob = async (request, handlers, options) => {
    const normalized = normalizeSpeechStartRequest(request);
    return startNativeJob({
      command: 'speech_start',
      request: normalized,
      expectedSegmentIds: normalized.segments.map(({ id }) => id),
      handlers,
      options,
    });
  };

  const startVoiceConversionJob = async (request, handlers, options) => {
    const normalized = normalizeVoiceConversionRequest(request);
    return startNativeJob({
      command: 'speech_voice_conversion_start',
      request: normalized,
      expectedSegmentIds: ['voice-conversion'],
      handlers,
      options,
    });
  };

  const getSpeechJobResults = async (jobId) => {
    requireNativeRuntime();
    const id = requireUuid(jobId, 7);
    const value = normalizeSpeechJobResults(
      await invokeCommand('speech_job_results', { jobId: id })
    );
    if (value.job.id !== id) throw invalidResponse();
    return value;
  };

  const resolveSpeechArtifact = async (artifactId) => {
    requireNativeRuntime();
    const id = requireUuid(artifactId, 7);
    const value = normalizePlayableArtifact(
      await invokeCommand('speech_artifact_resolve', { artifactId: id })
    );
    if (value.artifact.artifactId !== id) throw invalidResponse();
    return value;
  };

  const releaseSpeechPlayback = async (playbackId) => {
    requireNativeRuntime();
    const id = requireUuid(playbackId, 4);
    const released = await invokeCommand('speech_playback_release', { playbackId: id });
    if (typeof released !== 'boolean') throw invalidResponse();
    return released;
  };

  const editSpeechArtifact = async (request) => {
    requireNativeRuntime();
    const normalized = normalizeArtifactEdit(request);
    const artifact = normalizeSpeechArtifact(
      await invokeCommand('speech_artifact_edit', { request: normalized })
    );
    if (artifact.artifactId === normalized.artifactId) throw invalidResponse();
    return artifact;
  };

  const exportSpeechArtifacts = async (request) => {
    requireNativeRuntime();
    const saved = await invokeCommand('speech_artifact_export', {
      request: normalizeArtifactExport(request),
    });
    if (typeof saved !== 'boolean') throw invalidResponse();
    return saved;
  };

  return Object.freeze({
    getSpeechStatus,
    probeSpeechBackend,
    stopSpeechRuntime,
    selectSpeechReference,
    importSpeechReference,
    extractSpeechReference,
    startSpeechJob,
    startVoiceConversionJob,
    cancelSpeechJob,
    getSpeechJobResults,
    resolveSpeechArtifact,
    releaseSpeechPlayback,
    editSpeechArtifact,
    exportSpeechArtifacts,
  });
};

const speechService = createNativeSpeechService();

export const getSpeechStatus = speechService.getSpeechStatus;
export const probeSpeechBackend = speechService.probeSpeechBackend;
export const stopSpeechRuntime = speechService.stopSpeechRuntime;
export const selectSpeechReference = speechService.selectSpeechReference;
export const importSpeechReference = speechService.importSpeechReference;
export const extractSpeechReference = speechService.extractSpeechReference;
export const startSpeechJob = speechService.startSpeechJob;
export const startVoiceConversionJob = speechService.startVoiceConversionJob;
export const cancelSpeechJob = speechService.cancelSpeechJob;
export const getSpeechJobResults = speechService.getSpeechJobResults;
export const resolveSpeechArtifact = speechService.resolveSpeechArtifact;
export const releaseSpeechPlayback = speechService.releaseSpeechPlayback;
export const editSpeechArtifact = speechService.editSpeechArtifact;
export const exportSpeechArtifacts = speechService.exportSpeechArtifacts;
