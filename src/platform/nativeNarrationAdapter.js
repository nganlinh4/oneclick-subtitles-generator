import {
  CHATTERBOX_LANGUAGES,
  createNativeSpeechService,
  GEMINI_SPEECH_MODELS,
  GEMINI_SPEECH_VOICES,
  GTTS_DOMAINS,
  normalizeSpeechProfile,
  normalizeSpeechStartRequest,
  SpeechServiceError,
} from './speechService';
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

const legacyMethod = Object.freeze({
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
  geminiTts: new Set(['credentialId', 'model', 'voice', 'language']),
});

const referenceKeys = new Set([
  'nativeArtifactId', 'artifactId', 'artifact', 'nativePlaybackId', 'audioUrl', 'mimeType',
  'bytes', 'format', 'durationMicros',
]);
const artifactKeys = new Set([
  'artifactId', 'format', 'bytes', 'durationMicros', 'sampleRateHz', 'channels',
]);

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

const invalid = () => new SpeechServiceError(
  'invalidNarrationAdapterRequest',
  'The native narration request is invalid'
);

const requireRecord = (value) => {
  if (!isPlainDataRecord(value)) throw invalid();
  return value;
};

const requireRequestKeys = (rawValue, allowed, required = allowed) => {
  const value = requireRecord(rawValue);
  if (Object.keys(value).some((key) => !allowed.has(key))
      || [...required].some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw invalid();
  }
  return value;
};

const requireMethod = (value) => {
  const method = methodAliases.get(value);
  if (method === undefined) throw invalid();
  return method;
};

const requireUuid = (value, expectedVersion) => {
  if (typeof value !== 'string' || !validateUuid(value)) throw invalid();
  try {
    if (uuidVersion(value) !== expectedVersion) throw invalid();
  } catch {
    throw invalid();
  }
  return value;
};

const hasInvalidControls = (value) => {
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point < 32 || point === 127) return true;
  }
  return false;
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

const referenceId = (reference) => {
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

const normalizeSubtitles = (subtitles) => {
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
    return Object.freeze({
      nativeId: `segment-${index + 1}`,
      subtitleId,
      text,
      outputIndex: index + 1,
      originalIds: Object.freeze(originalIds.map((id) => normalizeSubtitleId(id, null))),
      start: timing.start,
      end: timing.end,
    });
  });
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
          || typeof settings.credentialId !== 'string') {
        throw invalid();
      }
      return normalizeSpeechProfile({
        backend,
        credentialId: settings.credentialId,
        model,
        voice,
        language: settings.language ?? 'en-US',
      });
    }
    default:
      throw invalid();
  }
};

const resultFromNative = (result, mapping, backend) => {
  const common = {
    subtitle_id: mapping.subtitleId,
    text: mapping.text,
    pending: false,
    outputIndex: mapping.outputIndex,
    original_ids: mapping.originalIds,
    start: mapping.start,
    end: mapping.end,
    method: legacyMethod[backend],
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

const playableReference = (value) => Object.freeze({
  nativeArtifactId: value.artifact.artifactId,
  nativePlaybackId: value.playback.id,
  audioUrl: value.playback.playbackUrl,
  mimeType: value.playback.mimeType,
  bytes: value.artifact.bytes,
  format: value.artifact.format,
  durationMicros: value.artifact.durationMicros,
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

const normalizeCallbacks = (callbacks) => {
  if (callbacks === undefined) return Object.freeze({});
  const value = requireRecord(callbacks);
  if (Object.keys(value).some((key) => !adapterHandlerKeys.has(key))) throw invalid();
  for (const callback of Object.values(value)) {
    if (callback !== undefined && typeof callback !== 'function') throw invalid();
  }
  return Object.freeze(value);
};

const safelyCall = (callback, ...arguments_) => {
  if (typeof callback !== 'function') return;
  try {
    const result = callback(...arguments_);
    if (result && typeof result.catch === 'function') result.catch(() => undefined);
  } catch {
    // A legacy callback cannot corrupt the native channel state.
  }
};

/**
 * Logic-only migration adapter for the existing narration hooks. It intentionally does not read
 * browser storage, fetch localhost services, accept filesystem paths, or persist playback tokens.
 */
export const createNativeNarrationAdapter = ({
  speech = createNativeSpeechService(),
} = {}) => {
  const selectReference = async (method) => {
    const backend = requireMethod(method);
    if (backend !== 'f5Tts' && backend !== 'chatterbox') throw invalid();
    const selected = await speech.selectSpeechReference({ backend });
    return selected === null ? null : playableReference(selected);
  };

  const importReference = async (rawRequest) => {
    const { method, assetId } = requireRequestKeys(
      rawRequest,
      new Set(['method', 'assetId'])
    );
    const backend = requireMethod(method);
    if (backend !== 'f5Tts' && backend !== 'chatterbox') throw invalid();
    return playableReference(await speech.importSpeechReference({
      backend,
      assetId: requireUuid(assetId, 7),
    }));
  };

  const extractReference = async (rawRequest) => {
    const { method, startMs, endMs } = requireRequestKeys(
      rawRequest,
      new Set(['method', 'startMs', 'endMs'])
    );
    const backend = requireMethod(method);
    if (backend !== 'f5Tts' && backend !== 'chatterbox') throw invalid();
    return playableReference(await speech.extractSpeechReference({ backend, startMs, endMs }));
  };

  const releasePlayback = async (value) => {
    const playbackId = typeof value === 'string' ? value : value?.nativePlaybackId;
    return speech.releaseSpeechPlayback(requireUuid(playbackId, 4));
  };

  const resolvePlayback = async (result) => {
    const artifactId = typeof result === 'string' ? result : result?.nativeArtifactId;
    const playable = await speech.resolveSpeechArtifact(requireUuid(artifactId, 7));
    return Object.freeze({
      nativeArtifactId: playable.artifact.artifactId,
      nativePlaybackId: playable.playback.id,
      audioUrl: playable.playback.playbackUrl,
      mimeType: playable.playback.mimeType,
      bytes: playable.playback.byteLength,
    });
  };

  const generate = async (rawRequest, rawCallbacks, options) => {
    const requestValue = requireRequestKeys(
      rawRequest,
      new Set(['method', 'subtitles', 'settings', 'reference']),
      new Set(['method', 'subtitles'])
    );
    const {
      method,
      subtitles,
      settings = {},
      reference = null,
    } = requestValue;
    const backend = requireMethod(method);
    const usesReference = backend === 'f5Tts' || backend === 'chatterbox';
    if (!usesReference && reference !== null) throw invalid();
    const mappings = normalizeSubtitles(subtitles);
    const byNativeId = new Map(mappings.map((mapping) => [mapping.nativeId, mapping]));
    const profile = createNativeSpeechProfile(backend, settings);
    const callbacks = normalizeCallbacks(rawCallbacks);
    const mapResult = (result) => {
      const mapping = byNativeId.get(result.segmentId);
      if (mapping === undefined) throw invalid();
      return resultFromNative(result, mapping, backend);
    };
    const handlers = {
      onEvent: (event) => safelyCall(callbacks.onEvent, event),
      onProgress: (event) => safelyCall(callbacks.onProgress, Object.freeze({
        current: event.index,
        total: event.total,
        subtitle_id: event.segmentId === null
          ? null
          : byNativeId.get(event.segmentId)?.subtitleId ?? null,
        phase: event.phase,
        fraction: event.fractionMillionths / 1_000_000,
      })),
      onSegmentCompleted: (event) => {
        const result = mapResult(event.result);
        safelyCall(callbacks.onResult, result, event.index, event.total);
      },
      onSegmentFailed: (event) => {
        const result = mapResult(event.result);
        safelyCall(callbacks.onResult, result, event.index, event.total);
      },
      onCompleted: (event) => safelyCall(callbacks.onComplete, event.results.map(mapResult)),
      onCancelled: (event) => safelyCall(callbacks.onCancelled, event.results.map(mapResult)),
      onFailed: (event) => safelyCall(callbacks.onError, Object.freeze({
        code: event.code,
        results: event.results.map(mapResult),
      })),
      onProtocolError: (error) => safelyCall(callbacks.onProtocolError, error),
    };
    const request = normalizeSpeechStartRequest({
      segments: mappings.map(({ nativeId, text }) => ({ id: nativeId, text })),
      profile,
      referenceArtifactId: usesReference
        ? referenceId(reference)
        : null,
    });
    const job = await speech.startSpeechJob(request, handlers, options);
    return Object.freeze({
      job,
      method: legacyMethod[backend],
      initialResults: Object.freeze(mappings.map((mapping) => Object.freeze({
        subtitle_id: mapping.subtitleId,
        text: mapping.text,
        pending: true,
        success: false,
        filename: null,
        audioData: null,
        outputIndex: mapping.outputIndex,
        original_ids: mapping.originalIds,
        start: mapping.start,
        end: mapping.end,
        method: legacyMethod[backend],
      }))),
    });
  };

  const restore = async (rawRequest) => {
    const { jobId, method, subtitles } = requireRequestKeys(
      rawRequest,
      new Set(['jobId', 'method', 'subtitles'])
    );
    const backend = requireMethod(method);
    const mappings = normalizeSubtitles(subtitles);
    const byNativeId = new Map(mappings.map((mapping) => [mapping.nativeId, mapping]));
    const restored = await speech.getSpeechJobResults(jobId);
    if (restored.backend !== backend) throw invalid();
    const results = restored.results.map((result) => {
      const mapping = byNativeId.get(result.segmentId);
      if (mapping === undefined) throw invalid();
      return resultFromNative(result, mapping, backend);
    });
    return Object.freeze({ job: restored.job, results: Object.freeze(results) });
  };

  const convertVoice = async (rawRequest, callbacks, options) => {
    const { input, targetVoice } = requireRequestKeys(
      rawRequest,
      new Set(['input', 'targetVoice'])
    );
    const normalizedCallbacks = normalizeCallbacks(callbacks);
    const mapConversionResult = (result) => result.status === 'completed'
      ? Object.freeze({
        success: true,
        pending: false,
        nativeArtifactId: result.artifact.artifactId,
        nativeFormat: result.artifact.format,
        durationMicros: result.artifact.durationMicros,
        filename: createNativeNarrationToken(result.artifact.artifactId),
        audioData: null,
      })
      : Object.freeze({
        success: false,
        pending: false,
        nativeArtifactId: null,
        errorCode: result.code,
        retryable: result.retryable,
      });
    return speech.startVoiceConversionJob({
      inputArtifactId: referenceId(input),
      targetVoiceArtifactId: referenceId(targetVoice),
    }, {
      onProgress: (event) => safelyCall(normalizedCallbacks.onProgress, event),
      onSegmentCompleted: (event) => safelyCall(
        normalizedCallbacks.onResult,
        mapConversionResult(event.result),
        1,
        1
      ),
      onSegmentFailed: (event) => safelyCall(
        normalizedCallbacks.onResult,
        mapConversionResult(event.result),
        1,
        1
      ),
      onCompleted: (event) => safelyCall(
        normalizedCallbacks.onComplete,
        event.results.map(mapConversionResult)
      ),
      onCancelled: (event) => safelyCall(
        normalizedCallbacks.onCancelled,
        event.results.map(mapConversionResult)
      ),
      onFailed: (event) => safelyCall(normalizedCallbacks.onError, Object.freeze({
        code: event.code,
        results: event.results.map(mapConversionResult),
      })),
      onProtocolError: (error) => safelyCall(normalizedCallbacks.onProtocolError, error),
    }, options);
  };

  const editArtifact = async (rawRequest) => {
    const requestValue = requireRequestKeys(
      rawRequest,
      new Set(['artifactId', 'normalizedStart', 'normalizedEnd', 'speedFactor']),
      new Set(['artifactId'])
    );
    const {
      artifactId,
      normalizedStart = 0,
      normalizedEnd = 1,
      speedFactor = 1,
    } = requestValue;
    return speech.editSpeechArtifact({
    artifactId: requireUuid(artifactId, 7),
    normalizedStart,
    normalizedEnd,
    speedFactor,
  });
  };

  return Object.freeze({
    getStatus: speech.getSpeechStatus,
    probe: speech.probeSpeechBackend,
    stopRuntime: speech.stopSpeechRuntime,
    cancel: speech.cancelSpeechJob,
    selectReference,
    importReference,
    extractReference,
    releasePlayback,
    resolvePlayback,
    generate,
    restore,
    convertVoice,
    editArtifact,
  });
};

export const nativeNarrationAdapter = createNativeNarrationAdapter();
