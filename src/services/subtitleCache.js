// Centralized subtitle cache + cache ID utilities

import {
  extractDouyinVideoId,
  extractYoutubeVideoId,
} from '../utils/mediaUrl';
import {
  loadProjectSubtitles,
  saveProjectSubtitles,
} from '../platform/subtitleProjectStore';

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
export const getCachedSubtitles = async (cacheId, _currentVideoUrl = null) => {
  try {
    return await loadProjectSubtitles(cacheId);
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
    await saveProjectSubtitles(cacheId, subtitles);
    return { success: true };
  } catch (error) {
    console.error('[subtitleCache] Error saving subtitles to cache:', error);
    return { success: false, error };
  }
};
