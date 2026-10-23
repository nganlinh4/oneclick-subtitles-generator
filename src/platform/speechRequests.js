// Request-side normalizers for the native speech bridge: every value sent to Rust is rebuilt here
// from typed settings and opaque IDs, or refused.
import {
  hasExactKeys,
  hasOnlyKeys,
  isPlainDataRecord,
  utf8ByteLength,
} from './plainDataRecord';
import {
  backendSet,
  characterCount,
  chatterboxLanguageSet,
  geminiModelSet,
  geminiVoiceSet,
  GEMINI_SPEECH_MODELS,
  gttsDomainSet,
  hasInvalidControls,
  invalidRequest,
  MAX_CHATTERBOX_CHARACTERS,
  MAX_EXPORT_FILE_NAME_CHARACTERS,
  MAX_PROJECT_NARRATION_MICROS,
  MAX_SEGMENT_TEXT_BYTES,
  MAX_SEGMENT_TEXT_CHARACTERS,
  MAX_SPEECH_BATCH_BYTES,
  MAX_SPEECH_SEGMENTS,
  MAX_TIME_MS,
  normalizeNarrationCueId,
  projectNarrationMethods,
  referenceBackendSet,
  requireIdentifier,
  requireInteger,
  requireLanguage,
  requireUuid,
} from './speechContract';

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
  f5Tts: [
    'backend', 'referenceText', 'model', 'speechRateMilli', 'nfeSteps', 'swayMilli',
    'guidanceMilli', 'seed', 'removeSilence',
  ],
  chatterbox: ['backend', 'language', 'exaggerationMilli', 'cfgWeightMilli'],
  edgeTts: ['backend', 'voice', 'ratePercent', 'volumePercent', 'pitchHz'],
  gtts: ['backend', 'language', 'domain', 'slow'],
  geminiTts: ['backend', 'credentialIds', 'model', 'voice', 'language', 'maxConcurrency'],
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
      if (model !== null && !new Set([
        'f5tts-v1-base', 'F5TTS_v1_Base', 'f5tts-spanish', 'f5tts-russian',
        'f5tts-portuguese-br', 'f5tts-italian', 'f5tts-vietnamese-vivoice',
        'f5tts-german', 'f5tts-finnish', 'f5tts-polish',
      ]).has(model)) {
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
      if (!Array.isArray(profile.credentialIds)
          || profile.credentialIds.length === 0
          || profile.credentialIds.length > 10) throw invalidRequest();
      const credentialIds = profile.credentialIds.map((id) => requireUuid(id, 7));
      if (new Set(credentialIds).size !== credentialIds.length) throw invalidRequest();
      return Object.freeze({
        backend: 'geminiTts',
        credentialIds: Object.freeze(credentialIds),
        model,
        voice,
        language: requireLanguage(profile.language ?? 'en-US'),
        maxConcurrency: requireInteger(profile.maxConcurrency ?? 5, 1, 10),
      });
    }
    default:
      throw invalidRequest();
  }
};

export const normalizeSpeechStartRequest = (request) => {
  const allowed = [
    'projectId', 'expectedProjectStateVersion', 'segments', 'profile',
    'referenceArtifactId', 'lifecycleEpoch',
  ];
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
  return Object.freeze({
    projectId: requireUuid(request.projectId, 7),
    expectedProjectStateVersion: requireInteger(
      request.expectedProjectStateVersion,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    segments: Object.freeze(segments),
    profile,
    referenceArtifactId,
    lifecycleEpoch: requireInteger(request.lifecycleEpoch, 0, Number.MAX_SAFE_INTEGER),
  });
};

export const normalizeReferenceExtract = (request) => {
  if (!hasExactKeys(request, [
    'backend', 'startMs', 'endMs', 'projectId', 'expectedProjectStateVersion',
    'expectedReferenceVersion',
  ])
      || !referenceBackendSet.has(request.backend)) {
    throw invalidRequest();
  }
  const startMs = requireInteger(request.startMs, 0, MAX_TIME_MS);
  const endMs = requireInteger(request.endMs, 1, MAX_TIME_MS);
  const maximum = request.backend === 'f5Tts' ? 12_000 : 60_000;
  if (endMs <= startMs || endMs - startMs > maximum) throw invalidRequest();
  return Object.freeze({
    backend: request.backend,
    startMs,
    endMs,
    projectId: requireUuid(request.projectId, 7),
    expectedProjectStateVersion: requireInteger(
      request.expectedProjectStateVersion, 0, Number.MAX_SAFE_INTEGER
    ),
    expectedReferenceVersion: requireInteger(
      request.expectedReferenceVersion, 0, Number.MAX_SAFE_INTEGER
    ),
  });
};

export const normalizeReferenceSelection = (request) => {
  if (!hasExactKeys(request, [
    'backend', 'projectId', 'expectedProjectStateVersion', 'expectedReferenceVersion',
  ]) || !referenceBackendSet.has(request.backend)) {
    throw invalidRequest();
  }
  return Object.freeze({
    backend: request.backend,
    projectId: requireUuid(request.projectId, 7),
    expectedProjectStateVersion: requireInteger(
      request.expectedProjectStateVersion, 0, Number.MAX_SAFE_INTEGER
    ),
    expectedReferenceVersion: requireInteger(
      request.expectedReferenceVersion, 0, Number.MAX_SAFE_INTEGER
    ),
  });
};

export const normalizeReferenceImport = (request) => {
  if (!hasExactKeys(request, [
    'backend', 'assetId', 'projectId', 'expectedProjectStateVersion',
    'expectedReferenceVersion',
  ])
      || !referenceBackendSet.has(request.backend)) {
    throw invalidRequest();
  }
  return Object.freeze({
    backend: request.backend,
    assetId: requireUuid(request.assetId, 7),
    projectId: requireUuid(request.projectId, 7),
    expectedProjectStateVersion: requireInteger(
      request.expectedProjectStateVersion, 0, Number.MAX_SAFE_INTEGER
    ),
    expectedReferenceVersion: requireInteger(
      request.expectedReferenceVersion, 0, Number.MAX_SAFE_INTEGER
    ),
  });
};

export const normalizeArtifactEdit = (request) => {
  if (!hasExactKeys(request, [
    'artifactId', 'projectId', 'expectedProjectStateVersion',
    'normalizedStart', 'normalizedEnd', 'speedFactor',
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
    projectId: requireUuid(request.projectId, 7),
    expectedProjectStateVersion: requireInteger(
      request.expectedProjectStateVersion, 0, Number.MAX_SAFE_INTEGER
    ),
    normalizedStartMillionths,
    normalizedEndMillionths,
    speedMilli,
  });
};

export const normalizeArtifactExport = (request) => {
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

export const normalizeProjectNarrationResultRequest = (result) => {
  if (!hasExactKeys(result, [
    'subtitleId', 'text', 'artifactId', 'method', 'outputIndex', 'originalIds',
    'startMicros', 'endMicros',
  ])
      || typeof result.text !== 'string'
      || result.text.length === 0
      || utf8ByteLength(result.text) > MAX_SEGMENT_TEXT_BYTES
      || !projectNarrationMethods.has(result.method)
      || !Array.isArray(result.originalIds)
      || result.originalIds.length === 0
      || result.originalIds.length > MAX_SPEECH_SEGMENTS) {
    throw invalidRequest();
  }
  const startMicros = requireInteger(result.startMicros, 0, MAX_PROJECT_NARRATION_MICROS);
  const endMicros = requireInteger(result.endMicros, 1, MAX_PROJECT_NARRATION_MICROS);
  if (endMicros <= startMicros) throw invalidRequest();
  return Object.freeze({
    subtitleId: normalizeNarrationCueId(result.subtitleId),
    text: result.text,
    artifactId: requireUuid(result.artifactId, 7),
    method: result.method,
    outputIndex: result.outputIndex === null
      ? null : requireInteger(result.outputIndex, 0, MAX_SPEECH_SEGMENTS - 1),
    originalIds: Object.freeze(result.originalIds.map((id) => normalizeNarrationCueId(id))),
    startMicros,
    endMicros,
  });
};

export const normalizeVoiceConversionRequest = (request) => {
  if (!hasExactKeys(request, [
    'inputArtifactId', 'targetVoiceArtifactId', 'lifecycleEpoch',
  ])) {
    throw invalidRequest();
  }
  return Object.freeze({
    inputArtifactId: requireUuid(request.inputArtifactId, 7),
    targetVoiceArtifactId: requireUuid(request.targetVoiceArtifactId, 7),
    lifecycleEpoch: requireInteger(request.lifecycleEpoch, 0, Number.MAX_SAFE_INTEGER),
  });
};
