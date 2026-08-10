import {
  getYouTubeVideoDetailsNative,
  getYouTubeThumbnailNative,
  searchYouTubeNative,
} from './providerService';

// OAuth preference is non-secret UI state. Authentication itself is validated
// by the native provider command against opaque credential IDs in the OS vault.
export const isOAuthEnabled = () => localStorage.getItem('use_youtube_oauth') === 'true';

export const searchYouTubeVideos = (query, maxResults = 5) => searchYouTubeNative({
  query,
  maxResults,
  useOAuth: isOAuthEnabled(),
});

export const getVideoDetails = (videoId) => getYouTubeVideoDetailsNative({
  videoId,
  useOAuth: isOAuthEnabled(),
});

export const getVideoThumbnail = (videoId) => getYouTubeThumbnailNative({ videoId });
