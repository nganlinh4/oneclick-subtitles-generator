// YouTube provider failures, classified by the native error code. An error without one is
// reported as a generic failure.
import { errorCodeOf } from '../../utils/errorCode';

export const YOUTUBE_ERROR_KIND = Object.freeze({
  AUTH_REQUIRED: 'authRequired',
  NO_API_KEY: 'noApiKey',
  QUOTA_EXCEEDED: 'quotaExceeded',
  API_NOT_ENABLED: 'apiNotEnabled',
  OTHER: 'other',
});

const classifyByCode = (code, oauth) => {
  switch (code) {
    case 'youtubeQuotaExceeded': return YOUTUBE_ERROR_KIND.QUOTA_EXCEEDED;
    case 'youtubeApiNotEnabled': return YOUTUBE_ERROR_KIND.API_NOT_ENABLED;
    case 'youtubeAuthenticationRequired':
      return oauth ? YOUTUBE_ERROR_KIND.AUTH_REQUIRED : YOUTUBE_ERROR_KIND.OTHER;
    case 'credentialNotFound':
      return oauth ? YOUTUBE_ERROR_KIND.AUTH_REQUIRED : YOUTUBE_ERROR_KIND.NO_API_KEY;
    default: return YOUTUBE_ERROR_KIND.OTHER;
  }
};

/** @param {{ oauth: boolean }} options whether the request authenticated with OAuth */
export const classifyYoutubeError = (error, { oauth }) => classifyByCode(errorCodeOf(error), oauth);

export const youtubeQuotaMessage = (t) => t(
  'errors.quotaExceeded',
  'Quota exceeded, please wait tomorrow, or create a new Google Cloud project and update API or OAuth.'
);

/** The toast text and duration for a failed YouTube search. */
export const youtubeSearchErrorToast = (t, error, { oauth }) => {
  switch (classifyYoutubeError(error, { oauth })) {
    case YOUTUBE_ERROR_KIND.AUTH_REQUIRED:
      return [t('youtube.authError', 'YouTube authentication required. Please set up OAuth in settings.'), 8000];
    case YOUTUBE_ERROR_KIND.NO_API_KEY:
      return [t('youtube.noApiKey', 'Please set your YouTube API key in the settings first.'), 5000];
    case YOUTUBE_ERROR_KIND.QUOTA_EXCEEDED:
      return [youtubeQuotaMessage(t), 8000];
    case YOUTUBE_ERROR_KIND.API_NOT_ENABLED:
      return [t('errors.youtubeApiNotEnabled', 'YouTube Data API v3 is not enabled in your Google Cloud project. Please enable it by visiting the Google Cloud Console and enabling the YouTube Data API v3 service.'), 8000];
    default:
      return [t('youtube.searchError', 'Error searching YouTube. Please try again or enter a URL directly.'), 5000];
  }
};
