// Legacy-shape narration inputs mapped onto the native speech contract: method aliases, settings to
// typed profiles, subtitle mappings, and native results back to the hooks' result records.
import {
  CHATTERBOX_LANGUAGES,
  GEMINI_SPEECH_MODELS,
  GEMINI_SPEECH_VOICES,
  GTTS_DOMAINS,
  normalizeSpeechProfile,
  SpeechServiceError,
} from './speechService';
import { isPlainDataRecord } from './plainDataRecord';
import { hasInvalidControls } from './speechContract';
import { validate as validateUuid, version as uuidVersion } from 'uuid';
import { createNativeNarrationToken } from './nativeNarrationCapabilities';

const methodAliases = new Map([
  ['f5tts', 'f5Tts'],
  ['f5-tts', 'f5Tts'],
  ['f5Tts', 'f5Tts'],
  ['chatterbox', 'chatterbox'],
  ['edge-tts', 'edgeTts'],
  ['edgeTts', 'edgeTts'],
  ['gtts', 'gtts'],
  ['gemini', 'geminiTts'],
  ['gemini-tts', 'geminiTts'],
  ['geminiTts', 'geminiTts'],
]);

export const legacyMethod = Object.freeze({
  f5Tts: 'f5tts',
  chatterbox: 'chatterbox',
  edgeTts: 'edge-tts',
  gtts: 'gtts',
  geminiTts: 'gemini',
});

const settingKeys = Object.freeze({
  f5Tts: new Set([
    'referenceText', 'model', 'modelId', 'speechRateMilli', 'speechRate', 'nfeSteps',
    'nfeStep', 'swayMilli', 'swayCoef', 'guidanceMilli', 'guidance', 'cfgStrength',
    'seed', 'useRandomSeed', 'removeSilence', 'batchSize', 'skipClearOutput', 'language',
  ]),
  chatterbox: new Set([
    'language', 'lang', 'exaggerationMilli', 'exaggeration', 'cfgWeightMilli', 'cfgWeight',
  ]),
  edgeTts: new Set([
    'voice', 'ratePercent', 'rate', 'volumePercent', 'volume', 'pitchHz', 'pitch',
  ]),
  gtts: new Set(['language', 'lang', 'domain', 'tld', 'slow']),
  geminiTts: new Set(['credentialIds', 'model', 'voice', 'language', 'maxConcurrency']),
});

const referenceKeys = new Set([
  'nativeArtifactId', 'artifactId', 'artifact', 'nativePlaybackId', 'audioUrl', 'mimeType',
  'bytes', 'format', 'durationMicros',
]);
const artifactKeys = new Set([
  'artifactId', 'format', 'bytes', 'durationMicros', 'sampleRateHz', 'channels',
]);

export const invalid = () => new SpeechServiceError(
  'invalidNarrationAdapterRequest',
  'The native narration request is invalid'
);

const requireRecord = (value) => {
  if (!isPlainDataRecord(value)) throw invalid();
  return value;
};

export const requireRequestKeys = (rawValue, allowed, required = allowed) => {
  const value = requireRecord(rawValue);
  if (Object.keys(value).some((key) => !allowed.has(key))
      || [...required].some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw invalid();
  }
  return value;
};

export const requireMethod = (value) => {
  const method = methodAliases.get(value);
  if (method === undefined) throw invalid();
  return method;
};

export const requireUuid = (value, expectedVersion) => {
  if (typeof value !== 'string' || !validateUuid(value)) throw invalid();
  try {
    if (uuidVersion(value) !== expectedVersion) throw invalid();
  } catch {
    throw invalid();
  }
  return value;
};

const requireFinite = (value, minimum, maximum) => {
  if (typeof value !== 'number'
      || !Number.isFinite(value)
      || value < minimum
      || value > maximum) {
    throw invalid();
  }
  return value;
};

export const requireLifecycleEpoch = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
};

const toMilli = (value, fallback, minimum, maximum) => (
  Math.round(requireFinite(value ?? fallback, minimum, maximum) * 1_000)
);

const parseSignedControl = (value, suffix) => {
  if (value === undefined || value === null || value === '') return 0;
  if (Number.isSafeInteger(value)) {
    if (value < -100 || value > 100) throw invalid();
    return value;
  }
  if (typeof value !== 'string') throw invalid();
  const expression = suffix === '%'
    ? /^([+-]?\d{1,3})%$/
    : /^([+-]?\d{1,3})Hz$/;
  const match = value.trim().match(expression);
  if (match === null) throw invalid();
  const parsed = Number(match[1]);
  if (!Number.isSafeInteger(parsed) || parsed < -100 || parsed > 100) throw invalid();
  return parsed;
};

export const referenceId = (reference) => {
  if (typeof reference === 'string') return requireUuid(reference, 7);
  if (!isPlainDataRecord(reference)) throw invalid();
  if (Object.keys(reference).some((key) => !referenceKeys.has(key))) throw invalid();
  if (reference.artifact !== undefined
      && (!isPlainDataRecord(reference.artifact)
        || Object.keys(reference.artifact).some((key) => !artifactKeys.has(key)))) {
    throw invalid();
  }
  const candidates = [
    reference.nativeArtifactId,
    reference.artifactId,
    reference.artifact?.artifactId,
  ].filter((value) => value !== undefined);
  if (candidates.length === 0 || new Set(candidates).size !== 1) throw invalid();
  return requireUuid(candidates[0], 7);
};

const normalizeSubtitleId = (value, fallback) => {
  const candidate = value ?? fallback;
  if ((typeof candidate !== 'string' && typeof candidate !== 'number')
      || (typeof candidate === 'number' && !Number.isSafeInteger(candidate))) {
    throw invalid();
  }
  const text = String(candidate);
  if (text.length === 0 || text.length > 256 || hasInvalidControls(text)) {
    throw invalid();
  }
  return candidate;
};

const normalizeSubtitleTiming = (subtitle) => {
  const hasStart = subtitle.start !== undefined && subtitle.start !== null;
  const hasEnd = subtitle.end !== undefined && subtitle.end !== null;
  if (hasStart !== hasEnd) throw invalid();
  if (!hasStart) return Object.freeze({ start: undefined, end: undefined });
  const start = requireFinite(subtitle.start, 0, 7 * 24 * 60 * 60);
  const end = requireFinite(subtitle.end, start, 7 * 24 * 60 * 60);
  return Object.freeze({ start, end });
};

export const normalizeSubtitles = (subtitles) => {
  if (!Array.isArray(subtitles) || subtitles.length === 0 || subtitles.length > 1_000) {
    throw invalid();
  }
  const mappings = subtitles.map((rawSubtitle, index) => {
    const subtitle = requireRecord(rawSubtitle);
    const text = typeof subtitle.text === 'string' ? subtitle.text : null;
    if (text === null) throw invalid();
    const subtitleId = normalizeSubtitleId(subtitle.id ?? subtitle.subtitle_id, index + 1);
    const originalIds = subtitle.original_ids === undefined
      ? [subtitleId]
      : subtitle.original_ids;
    if (!Array.isArray(originalIds) || originalIds.length === 0 || originalIds.length > 1_000) {
      throw invalid();
    }
    const timing = normalizeSubtitleTiming(subtitle);
    const outputIndex = subtitle.outputIndex ?? index + 1;
    if (!Number.isSafeInteger(outputIndex) || outputIndex < 1 || outputIndex > 1_000) {
      throw invalid();
    }
    return Object.freeze({
      nativeId: `segment-${index + 1}`,
      subtitleId,
      text,
      outputIndex,
      originalIds: Object.freeze(originalIds.map((id) => normalizeSubtitleId(id, null))),
      start: timing.start,
      end: timing.end,
    });
  });
  if (new Set(mappings.map(({ outputIndex }) => outputIndex)).size !== mappings.length) {
    throw invalid();
  }
  return Object.freeze(mappings);
};

const optionalBoolean = (value, fallback) => {
  const result = value ?? fallback;
  if (typeof result !== 'boolean') throw invalid();
  return result;
};

export const createNativeSpeechProfile = (methodInput, rawSettings = {}) => {
  const backend = requireMethod(methodInput);
  const settings = requireRecord(rawSettings);
  if (Object.keys(settings).some((key) => !settingKeys[backend].has(key))) throw invalid();
  switch (backend) {
    case 'f5Tts': {
      if (settings.language !== undefined) {
        const language = typeof settings.language === 'string'
          ? settings.language.toLowerCase().split('-')[0]
          : '';
        if (!['en', 'zh'].includes(language)) throw invalid();
      }
      const randomSeed = settings.useRandomSeed === true;
      const seed = randomSeed
        ? null
        : settings.seed ?? null;
      return normalizeSpeechProfile({
        backend,
        referenceText: settings.referenceText ?? null,
        model: settings.model ?? settings.modelId ?? 'f5tts-v1-base',
        speechRateMilli: settings.speechRateMilli
          ?? toMilli(settings.speechRate, 1.1, 0.5, 2),
        nfeSteps: settings.nfeSteps ?? settings.nfeStep ?? 32,
        swayMilli: settings.swayMilli
          ?? toMilli(settings.swayCoef, -1, -1.1, 1.7),
        guidanceMilli: settings.guidanceMilli
          ?? toMilli(settings.guidance ?? settings.cfgStrength, 2, 1, 5),
        seed,
        removeSilence: optionalBoolean(settings.removeSilence, true),
      });
    }
    case 'chatterbox': {
      const languageValue = settings.language ?? settings.lang ?? 'en';
      if (typeof languageValue !== 'string') throw invalid();
      const language = languageValue.toLowerCase().split('-')[0];
      if (!CHATTERBOX_LANGUAGES.includes(language)) throw invalid();
      return normalizeSpeechProfile({
        backend,
        language,
        exaggerationMilli: settings.exaggerationMilli
          ?? toMilli(settings.exaggeration, 1, 0.25, 2),
        cfgWeightMilli: settings.cfgWeightMilli
          ?? toMilli(settings.cfgWeight, 0.5, 0, 1),
      });
    }
    case 'edgeTts':
      return normalizeSpeechProfile({
        backend,
        voice: settings.voice,
        ratePercent: settings.ratePercent ?? parseSignedControl(settings.rate, '%'),
        volumePercent: settings.volumePercent ?? parseSignedControl(settings.volume, '%'),
        pitchHz: settings.pitchHz ?? parseSignedControl(settings.pitch, 'Hz'),
      });
    case 'gtts': {
      const domain = settings.domain ?? settings.tld ?? 'com';
      if (!GTTS_DOMAINS.includes(domain)) throw invalid();
      return normalizeSpeechProfile({
        backend,
        language: settings.language ?? settings.lang,
        domain,
        slow: optionalBoolean(settings.slow, false),
      });
    }
    case 'geminiTts': {
      const model = settings.model ?? GEMINI_SPEECH_MODELS[0];
      const voice = settings.voice ?? 'Aoede';
      if (!GEMINI_SPEECH_MODELS.includes(model)
          || !GEMINI_SPEECH_VOICES.includes(voice)
          || !Array.isArray(settings.credentialIds)) {
        throw invalid();
      }
      return normalizeSpeechProfile({
        backend,
        credentialIds: settings.credentialIds,
        model,
        voice,
        language: settings.language ?? 'en-US',
        maxConcurrency: settings.maxConcurrency ?? 5,
      });
    }
    default:
      throw invalid();
  }
};

export const resultFromNative = (result, mapping, backend, authority) => {
  const common = {
    subtitle_id: mapping.subtitleId,
    text: mapping.text,
    pending: false,
    outputIndex: mapping.outputIndex,
    original_ids: mapping.originalIds,
    start: mapping.start,
    end: mapping.end,
    method: legacyMethod[backend],
    projectId: authority.projectId,
    projectStateVersion: authority.expectedProjectStateVersion,
    filename: result.status === 'completed'
      ? createNativeNarrationToken(result.artifact.artifactId)
      : null,
    audioData: null,
  };
  if (result.status === 'completed') {
    return Object.freeze({
      ...common,
      success: true,
      nativeArtifactId: result.artifact.artifactId,
      nativeFormat: result.artifact.format,
      durationMicros: result.artifact.durationMicros,
    });
  }
  return Object.freeze({
    ...common,
    success: false,
    nativeArtifactId: null,
    errorCode: result.code,
    retryable: result.retryable,
  });
};

export const playableReference = ({ reference, playable }) => Object.freeze({
  nativeArtifactId: playable.artifact.artifactId,
  nativePlaybackId: playable.playback.id,
  audioUrl: playable.playback.playbackUrl,
  mimeType: playable.playback.mimeType,
  bytes: playable.artifact.bytes,
  format: playable.artifact.format,
  durationMicros: playable.artifact.durationMicros,
  projectId: reference.projectId,
  projectStateVersion: reference.projectStateVersion,
  referenceVersion: reference.referenceVersion,
  text: reference.transcript,
  language: reference.language,
  pendingDelivery: reference.pendingDelivery,
});

const adapterHandlerKeys = new Set([
  'onEvent',
  'onProgress',
  'onResult',
  'onComplete',
  'onCancelled',
  'onError',
  'onProtocolError',
]);

export const normalizeCallbacks = (callbacks) => {
  if (callbacks === undefined) return Object.freeze({});
  const value = requireRecord(callbacks);
  if (Object.keys(value).some((key) => !adapterHandlerKeys.has(key))) throw invalid();
  for (const callback of Object.values(value)) {
    if (callback !== undefined && typeof callback !== 'function') throw invalid();
  }
  return Object.freeze(value);
};

export const safelyCall = (callback, ...arguments_) => {
  if (typeof callback !== 'function') return;
  try {
    const result = callback(...arguments_);
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
  } catch {
    // A legacy callback cannot corrupt the native channel state.
  }
};
