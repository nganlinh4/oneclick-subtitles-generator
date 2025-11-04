// Centralized subtitle cache + cache ID utilities

import { extractYoutubeVideoId } from '../utils/videoDownloader';

/**
 * Generate a consistent cache ID from any video URL
 * @param {string} url
 * @returns {Promise<string|null>}
 */
export const generateUrlBasedCacheId = async (url) => {
  if (!url) return null;
  try {
    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      return extractYoutubeVideoId(url);
    }
    if (url.includes('douyin.com')) {
      const { extractDouyinVideoId } = await import('../utils/douyinDownloader');
      return extractDouyinVideoId(url);
    }
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace('www.', '');
    const path = urlObj.pathname.replace(/\//g, '_');
    const query = urlObj.search.replace(/[^a-zA-Z0-9]/g, '_');
    const baseId = `${domain}${path}${query}`.replace(/[^a-zA-Z0-9]/g, '_');
    const cleanId = baseId.replace(/_+/g, '_').replace(/^_|_$/g, '');
    return `site_${cleanId}`;
  } catch (error) {
    console.error('[subtitleCache] Error generating URL-based cache ID:', error);
    return null;
  }
};

/**
 * Check if cached subtitles exist for a cache ID and return them if valid.
 * Validates URL association for non-file uploads.
 * @param {string} cacheId
 * @param {string|null} currentVideoUrl
 * @returns {Promise<Array|null>}
 */
export const getCachedSubtitles = async (cacheId, currentVideoUrl = null) => {
  try {
    const response = await fetch(`http://localhost:3031/api/subtitle-exists/${cacheId}`);
    const data = await response.json();
    if (!data.exists) return null;

    const currentFileCacheId = localStorage.getItem('current_file_cache_id');
    const isFileUpload = currentFileCacheId === cacheId;

    if (!isFileUpload && currentVideoUrl && data.metadata && data.metadata.sourceUrl) {
      if (data.metadata.sourceUrl !== currentVideoUrl) {
        console.log(`[Cache] Cache ID collision detected. Cache for ${data.metadata.sourceUrl}, current: ${currentVideoUrl}`);
        return null;
      }
    }

    console.log(`[Cache] Cache validation passed for ${isFileUpload ? 'file upload' : 'video URL'}`);
    return data.subtitles;
  } catch (error) {
    console.error('[subtitleCache] Error checking subtitle cache:', error);
    return null;
  }
};

/**
 * Save subtitles to cache with metadata
 * @param {string} cacheId
 * @param {Array} subtitles
 */
export const saveSubtitlesToCache = async (cacheId, subtitles) => {
  try {
    const currentVideoUrl = localStorage.getItem('current_video_url');
    const metadata = currentVideoUrl ? { sourceUrl: currentVideoUrl } : {};

    const response = await fetch('http://localhost:3031/api/save-subtitles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheId, subtitles, metadata })
    });

    const result = await response.json();
    if (!result.success) {
      console.error('[subtitleCache] Failed to save subtitles:', result.error);
    }
  } catch (error) {
    console.error('[subtitleCache] Error saving subtitles to cache:', error);
  }
};
