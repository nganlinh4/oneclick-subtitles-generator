// Native download wire vocabulary: limits, allowed values, scalar predicates and typed failures.
import { DOWNLOAD_COOKIE_SOURCES } from './downloadCookiePreference';

const DOWNLOAD_AUDIO_FORMATS = Object.freeze(['mp3', 'm4a', 'flac', 'wav']);

export const MAX_URL_CHARACTERS = 8_192;
export const MAX_FORMATS = 4_096;
export const MAX_SUBTITLES = 512;
export const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
export const MAX_PENDING_EVENTS = 4_096;
export const MAX_SAFE_FILENAME_CHARACTERS = 512;
export const cookieSources = new Set(DOWNLOAD_COOKIE_SOURCES);
export const audioFormats = new Set(DOWNLOAD_AUDIO_FORMATS);
export const containers = new Set([
  'mp4', 'webm', 'm4a', 'mp3', 'opus', 'ogg', 'flac', 'wav', 'other',
]);
export const subtitleFormats = new Set(['srt', 'vtt', 'ttml', 'ass', 'lrc', 'json3', 'other']);
export const subtitleSources = new Set(['manual', 'automatic']);
export const progressPhases = new Set(['downloading', 'downloadFinished', 'postProcessing']);
export const mediaKinds = new Set(['audio', 'video']);
export const unavailableReasons = new Set([
  'downloaderUnavailable',
  'downloaderHealthCheckFailed',
  'javascriptRuntimeUnavailable',
  'mediaToolsUnavailable',
  'cacheUnavailable',
]);
export const jobStates = new Set([
  'queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
export const activeJobStates = new Set(['running', 'cancelling']);
export const cancellationResponseStates = new Set([
  'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted',
]);
export const downloadCommandCodes = new Set([
  'internal',
  'invalidInput',
  'mediaToolsUnavailable',
  'downloaderAuthenticationRequired',
  'downloaderExecutionFailed',
  'downloaderFormatUnavailable',
  'downloaderNetworkFailed',
  'downloaderPostProcessingFailed',
  'downloaderRateLimited',
  'downloaderSourceUnavailable',
  'jobAlreadyExists',
  'jobNotFound',
  'jobConflict',
  'invalidJobState',
  'jobRegistry',
  'database',
]);

export const characterCountWithin = (value, maximum) => {
  if (typeof value !== 'string') return false;
  let count = 0;
  for (const character of value) {
    count += character.length > 0 ? 1 : 0;
    if (count > maximum) return false;
  }
  return true;
};

export const isSafeInteger = (value, { positive = false } = {}) => (
  Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0)
);

export const isOptionalSafeInteger = (value) => value === null || isSafeInteger(value);

export const hasControlCharacter = (value) => Array.from(value).some((character) => {
  const codePoint = character.codePointAt(0);
  return codePoint <= 31 || codePoint === 127;
});

export const isSafeDisplayText = (value, maximum) => (
  characterCountWithin(value, maximum)
  && value.trim().length > 0
  && !hasControlCharacter(value)
  && !value.includes('/')
  && !value.includes('\\')
);

export const isFormatId = (value) => (
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value)
);

export const isLanguage = (value) => (
  typeof value === 'string' && /^[A-Za-z0-9._-]{1,35}$/.test(value)
);

export class DownloadServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DownloadServiceError';
    this.code = code;
  }
}

export const invalidRequest = () => new DownloadServiceError(
  'invalidDownloadRequest',
  'The native download request is invalid'
);

export const invalidResponse = () => new DownloadServiceError(
  'invalidDownloadResponse',
  'The desktop host returned invalid download data'
);

export const runtimeRequired = () => new DownloadServiceError(
  'desktopRuntimeUnavailable',
  'Media downloads require the desktop runtime'
);

export const normalizeInvocationFailure = (error) => {
  let code = 'downloadCommandFailed';
  try {
    const candidate = error !== null && (typeof error === 'object' || typeof error === 'function')
      ? error.code
      : null;
    if (downloadCommandCodes.has(candidate)) code = candidate;
  } catch {
    // A hostile transport accessor is not authoritative error metadata.
  }
  return new DownloadServiceError(code, 'The native media download could not be completed');
};
