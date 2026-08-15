// URL history management for the unified URL input.
import {
  getYoutubeUrlHistory,
  getDouyinUrlHistory,
  addDouyinUrlToHistory,
  getAllSitesUrlHistory
} from '../../utils/historyUtils';
import { isValidDouyinUrl, extractDouyinVideoId } from './urlValidation';
import { getVideoThumbnail } from '../../platform/desktopYoutubeService';

export { addDouyinUrlToHistory, getDouyinUrlHistory };

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
