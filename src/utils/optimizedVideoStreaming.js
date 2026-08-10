/**
 * Optimized video streaming utilities for handling long videos
 * This module provides improved chunking and caching for better performance
 */

import { isNativeMediaPlaybackUrl } from '../platform/mediaService';
import { fetchBrowserResource } from '../platform/browserFetch';

// Cache for video chunks to avoid redundant processing
// Using LRUCache implementation below instead of this Map

// LRU (Least Recently Used) cache implementation for video chunks
class LRUCache {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.usage = [];
  }

  // Get a chunk from cache
  get(key) {
    if (!this.cache.has(key)) return null;

    // Update usage (move to end of array to mark as recently used)
    this.usage = this.usage.filter(k => k !== key);
    this.usage.push(key);

    return this.cache.get(key);
  }

  // Add a chunk to cache
  set(key, value) {
    // If cache is full, remove least recently used item
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const lruKey = this.usage.shift();
      this.cache.delete(lruKey);
    }

    // Add new item
    this.cache.set(key, value);

    // Update usage
    this.usage = this.usage.filter(k => k !== key);
    this.usage.push(key);
  }

  // Clear the cache
  clear() {
    this.cache.clear();
    this.usage = [];
  }
}

// Create a global LRU cache for video chunks
const videoChunkCache = new LRUCache(100); // Cache up to 100 chunks

/**
 * Preload video chunks for smoother playback
 * @param {string} videoUrl - URL of the video
 * @param {number} currentTime - Current playback time in seconds
 * @param {number} duration - Total duration of the video in seconds
 * @param {number} chunkSize - Size of each chunk in seconds (default: 30)
 * @param {number} preloadAhead - Number of chunks to preload ahead (default: 2)
 */
export const preloadVideoChunks = async (videoUrl, currentTime, duration, chunkSize = 30, preloadAhead = 2) => {
  if (!videoUrl || !duration) return;
  if (isNativeMediaPlaybackUrl(videoUrl)) return;

  // Calculate current chunk and chunks to preload
  const currentChunk = Math.floor(currentTime / chunkSize);
  const chunksToPreload = [];

  // Add current chunk and next chunks
  for (let i = 0; i <= preloadAhead; i++) {
    const chunkIndex = currentChunk + i;
    const chunkStart = chunkIndex * chunkSize;

    // Skip if beyond video duration
    if (chunkStart >= duration) break;

    chunksToPreload.push(chunkIndex);
  }

  // Preload chunks in parallel
  await Promise.all(chunksToPreload.map(async (chunkIndex) => {
    const cacheKey = `${videoUrl}_chunk_${chunkIndex}`;

    // Skip if already in cache
    if (videoChunkCache.get(cacheKey)) return;

    try {
      // Create a range request for this chunk
      const chunkStart = chunkIndex * chunkSize;
      const chunkEnd = Math.min((chunkIndex + 1) * chunkSize, duration);

      // Only preload if not already in browser cache
      // This is a dummy request that will be cached by the browser
      await fetchBrowserResource(videoUrl, {
        method: 'HEAD',
        headers: {
          'Range': `bytes=${Math.floor(chunkStart * 1000000)}-${Math.floor(chunkEnd * 1000000)}`,
        },
      });

      // Mark as preloaded in our cache
      videoChunkCache.set(cacheKey, true);
    } catch (error) {
      console.warn(`Error preloading chunk ${chunkIndex}:`, error);
    }
  }));
};

/**
 * Optimize memory usage by clearing unused video chunks
 * @param {string} videoUrl - URL of the video
 * @param {number} currentTime - Current playback time in seconds
 * @param {number} chunkSize - Size of each chunk in seconds (default: 30)
 * @param {number} keepChunks - Number of chunks to keep before current time (default: 1)
 */
export const clearUnusedChunks = (videoUrl, currentTime, chunkSize = 30, keepChunks = 1) => {
  if (!videoUrl) return;

  const currentChunk = Math.floor(currentTime / chunkSize);

  // Clear chunks that are far behind current playback position
  for (let i = 0; i < currentChunk - keepChunks; i++) {
    const cacheKey = `${videoUrl}_chunk_${i}`;
    videoChunkCache.delete(cacheKey);
  }
};

/**
 * Optimize video element for long videos
 * @param {HTMLVideoElement} videoElement - The video element to optimize
 */
export const optimizeVideoElement = (videoElement) => {
  if (!videoElement) return;

  // Set optimal buffer size for long videos
  videoElement.preload = 'auto';

  // Use lower quality initially for faster startup
  if ('fastSeek' in videoElement) {
    videoElement.fastSeek(0);
  }

  // Disable picture-in-picture to save resources
  videoElement.disablePictureInPicture = true;

  // Optimize memory usage
  videoElement.addEventListener('timeupdate', () => {
    // Clear video buffer when paused for a while
    if (videoElement.paused && videoElement.buffered.length > 0) {
      const bufferedEnd = videoElement.buffered.end(videoElement.buffered.length - 1);
      if (bufferedEnd - videoElement.currentTime > 300) { // More than 5 minutes buffered ahead
        // Force reload of video to clear buffer
        const currentTime = videoElement.currentTime;
        const paused = videoElement.paused;
        const src = videoElement.src;
        videoElement.src = src;
        videoElement.currentTime = currentTime;
        if (!paused) {
          videoElement.play();
        }
      }
    }
  });
};

const optimizedVideoStreaming = {
  preloadVideoChunks,
  clearUnusedChunks,
  optimizeVideoElement,
  videoChunkCache
};

export default optimizedVideoStreaming;
