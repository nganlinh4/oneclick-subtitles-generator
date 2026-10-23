/**
 * Gemini error classification and the status reporting built on it. Native errors are classified
 * by their stable `code`; English message matching is only a fallback for errors without one.
 */

import { errorCodeOf } from './errorCode';

export const GEMINI_ERROR_KIND = Object.freeze({
  RATE_LIMITED: 'rateLimited',
  OVERLOADED: 'overloaded',
  PROVIDER_FAILURE: 'providerFailure',
  TOKEN_LIMIT: 'tokenLimit',
  FILE_TOO_LARGE: 'fileTooLarge',
});

const KIND_BY_CODE = Object.freeze({
  geminiRateLimited: GEMINI_ERROR_KIND.RATE_LIMITED,
  // The host's catch-all for upstream statuses other than 400/401/403/404/429 (5xx in practice).
  geminiProvider: GEMINI_ERROR_KIND.PROVIDER_FAILURE,
});

const TRANSIENT_KINDS = new Set([
  GEMINI_ERROR_KIND.RATE_LIMITED,
  GEMINI_ERROR_KIND.OVERLOADED,
  GEMINI_ERROR_KIND.PROVIDER_FAILURE,
]);

const errorMessageOf = (error) => (typeof error?.message === 'string' ? error.message : '');

const classifyByMessage = (message) => {
  if (!message) return null;
  const lower = message.toLowerCase();
  if (message.includes('429') || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) {
    return GEMINI_ERROR_KIND.RATE_LIMITED;
  }
  if (message.includes('503') || message.includes('UNAVAILABLE') || /overloaded/i.test(message)) {
    return GEMINI_ERROR_KIND.OVERLOADED;
  }
  if (lower.includes('token') && lower.includes('exceeds the maximum')) {
    return GEMINI_ERROR_KIND.TOKEN_LIMIT;
  }
  if (message.includes('File size') && message.includes('exceeds the recommended maximum')) {
    return GEMINI_ERROR_KIND.FILE_TOO_LARGE;
  }
  return null;
};

/** One of GEMINI_ERROR_KIND, or null when the error is not a recognised Gemini failure. */
export const classifyGeminiError = (error) => {
  const code = errorCodeOf(error);
  if (code !== null) return KIND_BY_CODE[code] ?? null;
  return classifyByMessage(errorMessageOf(error));
};

/** Rate-limit, overload and upstream failures are worth retrying with backoff. */
export const isTransientGeminiError = (error) => TRANSIENT_KINDS.has(classifyGeminiError(error));

const reportRateLimit = (message, { t, setStatus, startQuotaCountdown }) => {
  const retryMatch = message.match(/Please retry in\s*([\d.]+)s/i);
  const seconds = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
  const isFreeTier = /free_tier/i.test(message);
  if (seconds !== null && typeof startQuotaCountdown === 'function') {
    startQuotaCountdown(seconds, isFreeTier);
    return;
  }
  setStatus({
    message: isFreeTier
      ? t('errors.geminiQuotaExceeded', 'Gemini free-tier quota exceeded. Please try again later or use a different API key/add billing.')
      : t('errors.geminiQuotaExceeded', 'Gemini quota exceeded. Please try again later or use a different API key/add billing.'),
    type: 'error',
  });
};

const reportOverload = (message, { t, setStatus }) => {
  setStatus({
    message: message.includes('503')
      ? t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)')
      : t('errors.geminiOverloaded', 'Strong model tends to get overloaded, please consider using other model and try again, or try lower the segment duration. Or create a new Google Cloud Project and get an API Key.'),
    type: 'error',
  });
};

const reportTokenLimit = (message, { t, setStatus }) => {
  const tokenMatch = message.match(/input token count\s*\((\d+)\)\s*exceeds the maximum number of tokens allowed\s*\((\d+)\)/i);
  setStatus({
    message: tokenMatch
      ? t('errors.tokenLimitExceededCounts', 'The video segment is too large for Gemini to process (required {{required}} tokens, limit {{limit}} tokens). Please reduce FPS/quality or shorten each request and try again.', { required: tokenMatch[1], limit: tokenMatch[2] })
      : t('errors.tokenLimitExceeded'),
    type: 'error',
  });
};

const reportFileTooLarge = (message, { t, setStatus }) => {
  const sizeMatch = message.match(/(\d+)MB\) exceeds the recommended maximum of (\d+)MB/);
  setStatus({
    message: sizeMatch
      ? t('errors.fileSizeTooLarge', 'File size ({{size}}MB) exceeds the recommended maximum of {{maxSize}}MB. Please use a smaller file or lower quality video.', { size: sizeMatch[1], maxSize: sizeMatch[2] })
      : message,
    type: 'error',
  });
};

const REPORTERS = Object.freeze({
  [GEMINI_ERROR_KIND.RATE_LIMITED]: reportRateLimit,
  [GEMINI_ERROR_KIND.OVERLOADED]: reportOverload,
  [GEMINI_ERROR_KIND.TOKEN_LIMIT]: reportTokenLimit,
  [GEMINI_ERROR_KIND.FILE_TOO_LARGE]: reportFileTooLarge,
});

/**
 * Report a recognised Gemini subtitle-generation error through `setStatus` (or the quota
 * countdown when the provider said how long to wait).
 *
 * @param {Error} error
 * @param {{ t: Function, setStatus: Function, startQuotaCountdown?: Function }} ctx
 * @returns {boolean} true when the error was recognised and reported.
 */
export const reportKnownGeminiSubtitleError = (error, ctx) => {
  const report = REPORTERS[classifyGeminiError(error)];
  if (!report) return false;
  report(errorMessageOf(error), ctx);
  return true;
};
