/**
 * Utility functions for color handling in the timeline visualization
 */

// Simple hash function for consistent colors
const hashString = (str) => {
  let hash = 0;
  for (let i = 0; str.length > i; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
};

// Color cache to avoid recalculating colors for the same text
const colorCache = new Map();

/**
 * Get color for a lyric, using cache for better performance
 * @param {string} text - The lyric text to generate color for
 * @param {boolean} isDark - Whether dark mode is active
 * @returns {Object} - Object with fillStyle and strokeStyle properties
 */
export const getLyricColor = (text, isDark) => {
  const cacheKey = `${text}-${isDark}`;

  if (colorCache.has(cacheKey)) {
    return colorCache.get(cacheKey);
  }

  const hash = hashString(text);
  const hue = hash % 360;
  const saturation = 70 + (hash % 20); // Vary saturation slightly
  const lightness = isDark ? '40%' : '60%';
  const alpha = isDark ? '0.8' : '0.7';

  const colors = {
    fillStyle: `hsla(${hue}, ${saturation}%, ${lightness}, ${alpha})`,
    strokeStyle: `hsla(${hue}, ${saturation}%, ${isDark ? '50%' : '40%'}, 0.9)`
  };

  colorCache.set(cacheKey, colors);
  return colors;
};

/**
 * Generate a random height for a segment based on its text
 * @param {string} text - The lyric text
 * @returns {number} - A height percentage between 0.4 and 0.85
 */
export const getRandomHeight = (text) => {
  // Use the same hash function we use for colors
  const hash = hashString(text);
  // Generate a height between 40% and 85% of the available height
  // This provides good visual distinction while maintaining readability
  // and ensuring segments don't get too small or too large
  return 0.4 + (hash % 45) / 100;
};
