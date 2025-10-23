/**
 * Utility functions for formatting time in different formats
 */

/**
 * Format time in seconds to a specific format
 * @param {number} timeInSeconds - Time in seconds
 * @param {string} format - Format to use ('seconds' or 'hms')
 * @returns {string} - Formatted time string
 */
export const formatTime = (timeInSeconds, format = 'seconds') => {
  if (timeInSeconds === undefined || timeInSeconds === null) {
    return '';
  }

  if (format === 'seconds') {
    // Format as seconds, removing redundant .00 for whole numbers
    const formatted = timeInSeconds.toFixed(2);
    // Remove .00 if it's a whole number, but keep other decimals
    const cleanFormatted = formatted.replace(/\.00$/, '');
    return cleanFormatted + 's';
  } else if (format === 'hms') {
    // Format as HH:MM:SS without milliseconds for cleaner look
    const hours = Math.floor(timeInSeconds / 3600);
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const seconds = Math.floor(timeInSeconds % 60);

    // Only show hours if there are any
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    } else {
      return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }
  } else if (format === 'hms_ms') {
    // Format as HH:MM:SS.ms with milliseconds for timing controls
    const hours = Math.floor(timeInSeconds / 3600);
    const minutes = Math.floor((timeInSeconds % 3600) / 60);
    const seconds = Math.floor(timeInSeconds % 60);
    const milliseconds = Math.floor((timeInSeconds % 1) * 100);

    // Only show hours if there are any
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}`;
    } else {
      return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}`;
    }
  } else if (format === 's_ms') {
    // Format as seconds.ms without minutes or hours
    const seconds = Math.floor(timeInSeconds);
    const milliseconds = Math.floor((timeInSeconds % 1) * 100);
    return `${seconds}.${String(milliseconds).padStart(2, '0')}`;
  }

  // Default fallback
  const formatted = timeInSeconds.toFixed(2);
  // Remove .00 if it's a whole number, but keep other decimals
  const cleanFormatted = formatted.replace(/\.00$/, '');
  return cleanFormatted + 's';
};

/**
 * Parse a formatted time string back to seconds
 * @param {string} timeString - Formatted time string
 * @returns {number} - Time in seconds
 */
export const parseTimeString = (timeString) => {
  // Remove the 's' suffix if present
  timeString = timeString.replace('s', '');

  // Check if it's in HH:MM:SS format
  if (timeString.includes(':')) {
    const parts = timeString.split(':');

    if (parts.length === 3) {
      // HH:MM:SS format
      const hours = parseInt(parts[0], 10);
      const minutes = parseInt(parts[1], 10);
      const secondsParts = parts[2].split('.');
      const seconds = parseInt(secondsParts[0], 10);
      const milliseconds = secondsParts.length > 1 ? parseInt(secondsParts[1], 10) : 0;

      return hours * 3600 + minutes * 60 + seconds + (milliseconds / (secondsParts[1]?.length === 2 ? 100 : 1000));
    } else if (parts.length === 2) {
      // MM:SS format
      const minutes = parseInt(parts[0], 10);
      const secondsParts = parts[1].split('.');
      const seconds = parseInt(secondsParts[0], 10);
      const milliseconds = secondsParts.length > 1 ? parseInt(secondsParts[1], 10) : 0;

      return minutes * 60 + seconds + (milliseconds / (secondsParts[1]?.length === 2 ? 100 : 1000));
    }
  }

  // Assume it's just seconds
  return parseFloat(timeString);
};
