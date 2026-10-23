import {
  getYouTubeVideoDetailsNative,
  getYouTubeThumbnailNative,
  searchYouTubeNative,
} from './providerService';
import { readPreference } from './preferences/store';

// OAuth preference is non-secret UI state. Authentication itself is validated
// by the native provider command against opaque credential IDs in the OS vault.
export const isOAuthEnabled = () => readPreference('use_youtube_oauth');

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
