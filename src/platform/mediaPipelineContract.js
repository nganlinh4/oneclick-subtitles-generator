// Native media pipeline wire vocabulary: operations, limits, scalar predicates and typed failures.
import { isUuidVersion } from './nativeDataSnapshot';

const MEDIA_PIPELINE_OPERATIONS = Object.freeze([
  'preparePlayback',
  'analysisClip',
  'extractAudio',
  'generateWaveform',
]);
const MEDIA_PIPELINE_PHASES = Object.freeze([
  'probing',
  'processing',
  'publishing',
]);

export const operations = new Set(MEDIA_PIPELINE_OPERATIONS);
export const phases = new Set(MEDIA_PIPELINE_PHASES);
export const phaseRanks = Object.freeze({ probing: 0, processing: 1, publishing: 2 });
export const mediaKinds = new Set(['audio', 'video']);
export const jobStates = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
export const activeJobStates = new Set(['running', 'cancelling']);
export const cancellationResponseStates = new Set([
  'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
export const jobKinds = new Set(['processMedia', 'generateWaveform']);
export const mediaPipelineCommandCodes = new Set([
  'internal',
  'invalidInput',
  'invalidPath',
  'mediaUnavailable',
  'mediaToolsUnavailable',
  'invalidMediaLocation',
  'mediaIdentityConflict',
  'invalidMediaOperation',
  'mediaTimeout',
  'mediaCancelled',
  'mediaOutputExists',
  'mediaArtifactMissing',
  'invalidMediaMetadata',
  'mediaToolFailure',
  'mediaMissingAudio',
  'mediaNotPlayable',
  'invalidMediaRange',
  'mediaStagingUnavailable',
  'mediaRegistryFull',
  'mediaServer',
  'jobAlreadyExists',
  'jobNotFound',
  'jobConflict',
  'invalidJobState',
  'jobRegistry',
  'database',
  'artifactStorage',
  'artifactDataCorrupt',
  'invalidArtifactRequest',
  'artifactMetadataTooLarge',
  'artifactLimit',
  'artifactNotFound',
  'artifactContentMismatch',
  'artifactConflict',
  'artifactStateConflict',
  'artifactNotReady',
]);
export const compatibilityActions = new Set([
  'direct', 'remux', 'transcodeAudio', 'transcodeVideo', 'transcodeAll', 'reject',
]);
export const compatibilityIssues = new Set([
  'noPlayableStream',
  'unsupportedContainer',
  'unsupportedVideoCodec',
  'unsupportedAudioCodec',
  'problematicAudioProfile',
  'unsupportedPixelFormat',
  'audioPrecedesVideo',
  'missingDuration',
  'legacyHevcAssumption',
]);
export const audioFormats = new Set(['wav', 'mp3', 'flac']);
export const MAX_DURATION_US = 7 * 24 * 60 * 60 * 1_000_000;
export const MAX_WAVEFORM_POINTS = 1_000_000;
export const MAX_WAVEFORM_PYRAMID_POINTS = 1_400_000;
export const MAX_PENDING_EVENTS = 4_096;
export const PLAYBACK_PATTERN = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/asset\/([0-9a-f-]{36})\?token=([0-9a-f]{64})$/i;
export const MEDIA_MIME_PATTERN = /^(audio|video)\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

export const isUuidV7 = (value) => isUuidVersion(value, 7);
export const isUuidV4 = (value) => isUuidVersion(value, 4);
export const isSafeInteger = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => (
  Number.isSafeInteger(value) && value >= minimum && value <= maximum
);
export const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
export const hasControlCharacter = (value) => [...value].some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
});

export class MediaPipelineServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaPipelineServiceError';
    this.code = code;
  }
}

export const invalidRequest = () => new MediaPipelineServiceError(
  'invalidMediaPipelineRequest',
  'The native media operation request is invalid'
);

export const invalidResponse = () => new MediaPipelineServiceError(
  'invalidMediaPipelineResponse',
  'The desktop host returned invalid media operation data'
);

export const runtimeRequired = () => new MediaPipelineServiceError(
  'desktopRuntimeUnavailable',
  'Native media processing requires the desktop runtime'
);

export const cancelledOperation = () => {
  const error = new Error('The native media operation was cancelled');
  error.name = 'AbortError';
  return error;
};

export const mediaFailureMessage = code => code === 'mediaMissingAudio'
  ? 'The selected media does not contain an audio stream.'
  : 'The native media operation could not be completed';

export const normalizeFailure = (error) => {
  let code = 'mediaPipelineFailed';
  try {
    const candidate = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? error.code
      : null;
    if (mediaPipelineCommandCodes.has(candidate)) code = candidate;
  } catch {
    // A hostile transport accessor is not authoritative error metadata.
  }
  return new MediaPipelineServiceError(code, mediaFailureMessage(code));
};

export const requireAssetId = (value) => {
  if (!isUuidV7(value)) throw invalidRequest();
  return value;
};

export const expectedJobKind = (operation) => (
  operation === 'generateWaveform' ? 'generateWaveform' : 'processMedia'
);

export const mediaPipelineEventKeys = Object.freeze([
  'event', 'job', 'operation', 'phase', 'fraction', 'result', 'error',
]);
