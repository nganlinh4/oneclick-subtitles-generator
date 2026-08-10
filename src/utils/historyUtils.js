/**
 * Utility functions for managing URL and search history
 */

// Constants for localStorage keys
const YOUTUBE_URL_HISTORY_KEY = 'youtube_url_history';
const YOUTUBE_SEARCH_HISTORY_KEY = 'youtube_search_history';
const ALL_SITES_URL_HISTORY_KEY = 'all_sites_url_history';
const MAX_HISTORY_ITEMS = 10;

/**
 * Add a YouTube URL to history
 * @param {Object} videoData - Video data object with id, url, title, and thumbnail
 */
export const addYoutubeUrlToHistory = (videoData) => {
  if (!videoData || !videoData.url || !videoData.id) return;

  try {
    // Get existing history
    const historyJson = localStorage.getItem(YOUTUBE_URL_HISTORY_KEY);
    let history = historyJson ? JSON.parse(historyJson) : [];

    // Check if this URL is already in history
    const existingIndex = history.findIndex(item => item.id === videoData.id);

    // If it exists, remove it (we'll add it to the top)
    if (existingIndex !== -1) {
      history.splice(existingIndex, 1);
    }

    // Add the new item to the beginning
    history.unshift({
      id: videoData.id,
      url: videoData.url,
      title: videoData.title || 'YouTube Video',
      // Provider-image capabilities are process-scoped bearer URLs and must never be persisted.
      thumbnail: '',
      timestamp: Date.now()
    });

    // Limit history size
    if (history.length > MAX_HISTORY_ITEMS) {
      history = history.slice(0, MAX_HISTORY_ITEMS);
    }

    // Save back to localStorage
    localStorage.setItem(YOUTUBE_URL_HISTORY_KEY, JSON.stringify(history));
  } catch (error) {
    console.error('Error saving YouTube URL history:', error);
  }
};

/**
 * Get YouTube URL history
 * @returns {Array} Array of history items
 */
export const getYoutubeUrlHistory = () => {
  try {
    const historyJson = localStorage.getItem(YOUTUBE_URL_HISTORY_KEY);
    const parsed = historyJson ? JSON.parse(historyJson) : [];
    if (!Array.isArray(parsed)) return [];
    const sanitized = parsed.slice(0, MAX_HISTORY_ITEMS).map((item) => ({
      ...item,
      // Migrate both old provider URLs and expired loopback capability URLs out of storage.
      thumbnail: '',
    }));
    if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) {
      localStorage.setItem(YOUTUBE_URL_HISTORY_KEY, JSON.stringify(sanitized));
    }
    return sanitized;
  } catch (error) {
    console.error('Error retrieving YouTube URL history:', error);
    return [];
  }
};

/**
 * Clear YouTube URL history
 */
export const clearYoutubeUrlHistory = () => {
  localStorage.removeItem(YOUTUBE_URL_HISTORY_KEY);
};

/**
 * Add a search query to history
 * @param {string} query - Search query
 */
export const addSearchQueryToHistory = (query) => {
  if (!query || query.trim().length < 3) return;

  try {
    // Get existing history
    const historyJson = localStorage.getItem(YOUTUBE_SEARCH_HISTORY_KEY);
    let history = historyJson ? JSON.parse(historyJson) : [];

    // Normalize the query
    const normalizedQuery = query.trim();

    // Check if this query is already in history
    const existingIndex = history.findIndex(item =>
      item.query.toLowerCase() === normalizedQuery.toLowerCase()
    );

    // If it exists, remove it (we'll add it to the top)
    if (existingIndex !== -1) {
      history.splice(existingIndex, 1);
    }

    // Add the new item to the beginning
    history.unshift({
      query: normalizedQuery,
      timestamp: Date.now()
    });

    // Limit history size
    if (history.length > MAX_HISTORY_ITEMS) {
      history = history.slice(0, MAX_HISTORY_ITEMS);
    }

    // Save back to localStorage
    localStorage.setItem(YOUTUBE_SEARCH_HISTORY_KEY, JSON.stringify(history));
  } catch (error) {
    console.error('Error saving search query history:', error);
  }
};

/**
 * Get search query history
 * @returns {Array} Array of history items
 */
export const getSearchQueryHistory = () => {
  try {
    const historyJson = localStorage.getItem(YOUTUBE_SEARCH_HISTORY_KEY);
    return historyJson ? JSON.parse(historyJson) : [];
  } catch (error) {
    console.error('Error retrieving search query history:', error);
    return [];
  }
};

/**
 * Clear search query history
 */
export const clearSearchQueryHistory = () => {
  localStorage.removeItem(YOUTUBE_SEARCH_HISTORY_KEY);
};

/**
 * Format a timestamp to a readable date
 * @param {number} timestamp - Timestamp in milliseconds
 * @returns {string} Formatted date string
 */
export const formatTimestamp = (timestamp) => {
  const date = new Date(timestamp);
  const now = new Date();

  // If it's today, show time
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // If it's yesterday, show "Yesterday"
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }

  // Otherwise show date
  return date.toLocaleDateString();
};

/**
 * Add an All Sites URL to history
 * @param {Object} videoData - Video data object with id, url, title
 */
export const addAllSitesUrlToHistory = (videoData) => {
  if (!videoData || !videoData.url || !videoData.id) return;

  try {
    // Get existing history
    const historyJson = localStorage.getItem(ALL_SITES_URL_HISTORY_KEY);
    let history = historyJson ? JSON.parse(historyJson) : [];

    // Check if this URL is already in history
    const existingIndex = history.findIndex(item => item.id === videoData.id);

    // If it exists, remove it (we'll add it to the top)
    if (existingIndex !== -1) {
      history.splice(existingIndex, 1);
    }

    // Add the new item to the beginning
    history.unshift({
      id: videoData.id,
      url: videoData.url,
      title: videoData.title || 'Video',
      thumbnail: videoData.thumbnail || '',
      timestamp: Date.now()
    });

    // Limit history size
    if (history.length > MAX_HISTORY_ITEMS) {
      history = history.slice(0, MAX_HISTORY_ITEMS);
    }

    // Save back to localStorage
    localStorage.setItem(ALL_SITES_URL_HISTORY_KEY, JSON.stringify(history));
  } catch (error) {
    console.error('Error saving All Sites URL history:', error);
  }
};

/**
 * Get All Sites URL history
 * @returns {Array} Array of history items
 */
export const getAllSitesUrlHistory = () => {
  try {
    const historyJson = localStorage.getItem(ALL_SITES_URL_HISTORY_KEY);
    return historyJson ? JSON.parse(historyJson) : [];
  } catch (error) {
    console.error('Error retrieving All Sites URL history:', error);
    return [];
  }
};

/**
 * Clear All Sites URL history
 */
export const clearAllSitesUrlHistory = () => {
  localStorage.removeItem(ALL_SITES_URL_HISTORY_KEY);
};
