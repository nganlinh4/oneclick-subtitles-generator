// URL history management for the unified URL input.
import {
  getYoutubeUrlHistory,
  getAllSitesUrlHistory
} from '../../utils/historyUtils';
import { isValidDouyinUrl, extractDouyinVideoId } from './urlValidation';
import { getVideoThumbnail } from '../../platform/desktopYoutubeService';

// Helper functions for Douyin URL history
export const getDouyinUrlHistory = () => {
  try {
    const history = JSON.parse(localStorage.getItem('douyin_url_history') || '[]');
    return Array.isArray(history) ? history : [];
  } catch (error) {
    console.error('Error parsing Douyin URL history:', error);
    return [];
  }
};

export const addDouyinUrlToHistory = (video) => {
  try {
    if (!video || !video.id || !video.url) return;

    const history = getDouyinUrlHistory();

    // Check if this URL is already in history
    const existingIndex = history.findIndex(item => item.id === video.id);

    // If it exists, remove it (we'll add it to the top)
    if (existingIndex !== -1) {
      history.splice(existingIndex, 1);
    }

    // Add to the beginning of the array
    history.unshift({
      id: video.id,
      url: video.url,
      title: video.title || 'Douyin Video',
      timestamp: Date.now()
    });

    // Keep only the most recent 20 items
    const trimmedHistory = history.slice(0, 20);

    // Save back to localStorage
    localStorage.setItem('douyin_url_history', JSON.stringify(trimmedHistory));
  } catch (error) {
    console.error('Error saving Douyin URL to history:', error);
  }
};

// Load combined history from all sources
export const loadHistory = async (setHistory) => {
  const youtubeHistory = getYoutubeUrlHistory().map(item => ({ ...item, source: 'youtube' }));
  const douyinHistory = getDouyinUrlHistory().map(item => ({ ...item, source: 'douyin' }));
  const allSitesHistory = getAllSitesUrlHistory().map(item => ({ ...item, source: 'all-sites' }));

  // Combine and sort by timestamp (newest first)
  const combinedHistory = [...youtubeHistory, ...douyinHistory, ...allSitesHistory]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 20); // Keep only the most recent 20 items

  setHistory(combinedHistory);
  const hydrated = await Promise.all(combinedHistory.map(async (item) => {
    if (item.source !== 'youtube') return item;
    try {
      return { ...item, thumbnail: await getVideoThumbnail(item.id) };
    } catch {
      return { ...item, thumbnail: '' };
    }
  }));
  setHistory(hydrated);
};

// Handle selecting a video from history
export const handleSelectFromHistory = async (historyItem, { setUrl, setSelectedVideo, setUrlType, setShowHistory }) => {
  setUrl(historyItem.url);

  // Check if this is a Douyin URL that should use unified downloader
  if (isValidDouyinUrl(historyItem.url)) {
    const videoId = extractDouyinVideoId(historyItem.url);
    if (videoId) {
      setSelectedVideo({
        id: videoId,
        url: historyItem.url,
        source: 'douyin',
        title: 'Douyin Video',
        thumbnail: ''
      });
      setUrlType('douyin');
      setShowHistory(false);
      return;
    }
  }

  // Use original history item for non-Douyin URLs
  let thumbnail = '';
  if (historyItem.source === 'youtube') {
    try {
      thumbnail = historyItem.thumbnail || await getVideoThumbnail(historyItem.id);
    } catch {
      thumbnail = '';
    }
  }
  setSelectedVideo({
    id: historyItem.id,
    url: historyItem.url,
    source: historyItem.source,
    title: historyItem.title,
    thumbnail
  });
  setUrlType(historyItem.source);
  setShowHistory(false);
};
