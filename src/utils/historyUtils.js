/**
 * Bounded browser compatibility history. Provider images are native process-scoped capabilities;
 * history persists only stable source metadata and rehydrates images when they are displayed.
 */

import { extractDouyinVideoId, extractYoutubeVideoId, isValidUrl } from './mediaUrl';

const YOUTUBE_URL_HISTORY_KEY = 'youtube_url_history';
const YOUTUBE_SEARCH_HISTORY_KEY = 'youtube_search_history';
const DOUYIN_URL_HISTORY_KEY = 'douyin_url_history';
const ALL_SITES_URL_HISTORY_KEY = 'all_sites_url_history';
const MAX_HISTORY_ITEMS = 10;
const MAX_HISTORY_JSON_CHARACTERS = 256 * 1024;
const MAX_URL_CHARACTERS = 8_192;
const MAX_ID_CHARACTERS = 8_192;
const MAX_TITLE_CHARACTERS = 1_000;
const MAX_QUERY_CHARACTERS = 500;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const boundedText = (value, maximum, { minimum = 1 } = {}) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const length = Array.from(trimmed).length;
  if (length < minimum || length > maximum) return null;
  return trimmed;
};

const sanitizeYoutubeItem = (value) => {
  if (!isRecord(value)) return null;
  const id = boundedText(value.id, 11);
  const url = boundedText(value.url, MAX_URL_CHARACTERS);
  const title = boundedText(value.title, MAX_TITLE_CHARACTERS);
  if (id === null || url === null || title === null || !isTimestamp(value.timestamp)
      || extractYoutubeVideoId(url) !== id) return null;
  return { id, url, title, thumbnail: '', timestamp: value.timestamp };
};

const sanitizeAllSitesItem = (value) => {
  if (!isRecord(value)) return null;
  const id = boundedText(value.id, MAX_ID_CHARACTERS);
  const url = boundedText(value.url, MAX_URL_CHARACTERS);
  const title = boundedText(value.title, MAX_TITLE_CHARACTERS);
  if (id === null || !SAFE_ID.test(id) || url === null || !isValidUrl(url)
      || title === null || !isTimestamp(value.timestamp)) return null;
  return { id, url, title, thumbnail: '', timestamp: value.timestamp };
};

const sanitizeDouyinItem = (value) => {
  if (!isRecord(value)) return null;
  const id = boundedText(value.id, MAX_ID_CHARACTERS);
  const url = boundedText(value.url, MAX_URL_CHARACTERS);
  const title = boundedText(value.title, MAX_TITLE_CHARACTERS);
  if (id === null || url === null || title === null || !isTimestamp(value.timestamp)
      || extractDouyinVideoId(url) !== id) return null;
  return { id, url, title, thumbnail: '', timestamp: value.timestamp };
};

const sanitizeSearchItem = (value) => {
  if (!isRecord(value)) return null;
  const query = boundedText(value.query, MAX_QUERY_CHARACTERS, { minimum: 3 });
  if (query === null || !isTimestamp(value.timestamp)) return null;
  return { query, timestamp: value.timestamp };
};

const readBoundedHistory = (key, sanitize, identity) => {
  try {
    const serialized = localStorage.getItem(key);
    if (serialized === null) return [];
    if (serialized.length > MAX_HISTORY_JSON_CHARACTERS) {
      localStorage.removeItem(key);
      return [];
    }
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(key);
      return [];
    }

    const seen = new Set();
    const sanitized = [];
    for (const candidate of parsed) {
      const item = sanitize(candidate);
      if (item === null) continue;
      const itemIdentity = identity(item);
      if (seen.has(itemIdentity)) continue;
      seen.add(itemIdentity);
      sanitized.push(item);
      if (sanitized.length === MAX_HISTORY_ITEMS) break;
    }

    if (JSON.stringify(parsed) !== JSON.stringify(sanitized)) {
      localStorage.setItem(key, JSON.stringify(sanitized));
    }
    return sanitized;
  } catch (error) {
    console.error(`Error retrieving bounded history ${key}:`, error);
    return [];
  }
};

const writeHistory = (key, history) => {
  localStorage.setItem(key, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS)));
};

const upsertHistoryItem = (history, item, identity) => [
  item,
  ...history.filter((candidate) => identity(candidate) !== identity(item)),
].slice(0, MAX_HISTORY_ITEMS);

export const getYoutubeUrlHistory = () => readBoundedHistory(
  YOUTUBE_URL_HISTORY_KEY,
  sanitizeYoutubeItem,
  (item) => item.id,
);

export const addYoutubeUrlToHistory = (videoData) => {
  const item = sanitizeYoutubeItem({
    id: videoData?.id,
    url: videoData?.url,
    title: videoData?.title || 'YouTube Video',
    timestamp: Date.now(),
  });
  if (item === null) return;
  try {
    writeHistory(YOUTUBE_URL_HISTORY_KEY, upsertHistoryItem(
      getYoutubeUrlHistory(),
      item,
      (candidate) => candidate.id,
    ));
  } catch (error) {
    console.error('Error saving YouTube URL history:', error);
  }
};

export const clearYoutubeUrlHistory = () => {
  localStorage.removeItem(YOUTUBE_URL_HISTORY_KEY);
};

export const getSearchQueryHistory = () => readBoundedHistory(
  YOUTUBE_SEARCH_HISTORY_KEY,
  sanitizeSearchItem,
  (item) => item.query.toLocaleLowerCase('en-US'),
);

export const addSearchQueryToHistory = (query) => {
  const item = sanitizeSearchItem({ query, timestamp: Date.now() });
  if (item === null) return;
  try {
    writeHistory(YOUTUBE_SEARCH_HISTORY_KEY, upsertHistoryItem(
      getSearchQueryHistory(),
      item,
      (candidate) => candidate.query.toLocaleLowerCase('en-US'),
    ));
  } catch (error) {
    console.error('Error saving search query history:', error);
  }
};

export const clearSearchQueryHistory = () => {
  localStorage.removeItem(YOUTUBE_SEARCH_HISTORY_KEY);
};

export const getDouyinUrlHistory = () => readBoundedHistory(
  DOUYIN_URL_HISTORY_KEY,
  sanitizeDouyinItem,
  (item) => item.id,
);

export const addDouyinUrlToHistory = (videoData) => {
  const item = sanitizeDouyinItem({
    id: videoData?.id,
    url: videoData?.url,
    title: videoData?.title || 'Douyin Video',
    timestamp: Date.now(),
  });
  if (item === null) return;
  try {
    writeHistory(DOUYIN_URL_HISTORY_KEY, upsertHistoryItem(
      getDouyinUrlHistory(),
      item,
      (candidate) => candidate.id,
    ));
  } catch (error) {
    console.error('Error saving Douyin URL history:', error);
  }
};

export const clearDouyinUrlHistory = () => {
  localStorage.removeItem(DOUYIN_URL_HISTORY_KEY);
};

export const getAllSitesUrlHistory = () => readBoundedHistory(
  ALL_SITES_URL_HISTORY_KEY,
  sanitizeAllSitesItem,
  (item) => item.id,
);

export const addAllSitesUrlToHistory = (videoData) => {
  const item = sanitizeAllSitesItem({
    id: videoData?.id,
    url: videoData?.url,
    title: videoData?.title || 'Video',
    timestamp: Date.now(),
  });
  if (item === null) return;
  try {
    writeHistory(ALL_SITES_URL_HISTORY_KEY, upsertHistoryItem(
      getAllSitesUrlHistory(),
      item,
      (candidate) => candidate.id,
    ));
  } catch (error) {
    console.error('Error saving All Sites URL history:', error);
  }
};

export const clearAllSitesUrlHistory = () => {
  localStorage.removeItem(ALL_SITES_URL_HISTORY_KEY);
};

export const formatTimestamp = (timestamp) => {
  if (!isTimestamp(timestamp)) return '';
  const date = new Date(timestamp);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString();
};
