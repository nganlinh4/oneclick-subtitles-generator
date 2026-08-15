import { validate as validateUuid, version as uuidVersion } from 'uuid';

const TOKEN_PREFIX = 'osg-speech-artifact:';

export const F5_TTS_SUPPORTED_LANGUAGE_CODES = Object.freeze(['en', 'zh']);

const normalizeLanguageCode = (value) => (
  typeof value === 'string' ? value.trim().toLowerCase().split('-')[0] : ''
);

export const getF5TtsLanguageSupport = (language) => {
  const primary = normalizeLanguageCode(language?.languageCode);
  const secondary = Array.isArray(language?.secondaryLanguages)
    ? language.secondaryLanguages.map(normalizeLanguageCode)
    : [];
  const codes = [...new Set([primary, ...secondary].filter(Boolean))];
  if (codes.length === 0 || codes.includes('unknown') || codes.includes('und')) {
    return Object.freeze({ supported: false, reason: 'unknown', languageCodes: Object.freeze(codes) });
  }
  const unsupported = codes.filter((code) => !F5_TTS_SUPPORTED_LANGUAGE_CODES.includes(code));
  return Object.freeze({
    supported: unsupported.length === 0,
    reason: unsupported.length === 0 ? 'supported' : 'unsupported',
    languageCodes: Object.freeze(codes),
  });
};

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

export const createNativeNarrationToken = (artifactId) => {
  if (!isUuidV7(artifactId)) return null;
  return `${TOKEN_PREFIX}${artifactId}`;
};

export const parseNativeNarrationToken = (value) => {
  if (typeof value !== 'string' || !value.startsWith(TOKEN_PREFIX)) return null;
  const artifactId = value.slice(TOKEN_PREFIX.length);
  return isUuidV7(artifactId) ? artifactId : null;
};

export const getNativeNarrationArtifactId = (value) => {
  if (typeof value === 'string') {
    return isUuidV7(value) ? value : parseNativeNarrationToken(value);
  }
  if (!value || typeof value !== 'object') return null;
  if (isUuidV7(value.nativeArtifactId)) return value.nativeArtifactId;
  return parseNativeNarrationToken(value.filename);
};

export const attachNativeNarrationArtifact = (result, artifact) => {
  const artifactId = artifact?.artifactId;
  const filename = createNativeNarrationToken(artifactId);
  if (!filename || !result || typeof result !== 'object') return result;
  return {
    ...result,
    success: true,
    pending: false,
    nativeArtifactId: artifactId,
    nativeFormat: artifact.format,
    durationMicros: artifact.durationMicros,
    filename,
    audioData: null,
  };
};

export const hydrateNativeNarrationResult = (result) => {
  if (!result || typeof result !== 'object') return result;
  const artifactId = getNativeNarrationArtifactId(result);
  if (!artifactId) return result;
  const filename = createNativeNarrationToken(artifactId);
  if (result.nativeArtifactId === artifactId && result.filename === filename) return result;
  return {
    ...result,
    nativeArtifactId: artifactId,
    filename,
    audioData: null,
  };
};

export const hydrateNativeNarrationResults = (results) => (
  Array.isArray(results) ? results.map(hydrateNativeNarrationResult) : []
);

export const isNativeNarrationResult = (result) => (
  getNativeNarrationArtifactId(result) !== null
);
