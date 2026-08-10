import { validate as validateUuid, version as uuidVersion } from 'uuid';

const TOKEN_PREFIX = 'osg-speech-artifact:';

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
