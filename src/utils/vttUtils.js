/**
 * Subtitle time-string parsing (SRT, WebVTT and MMmSSsNNNms forms).
 */

/**
 * Convert time string to seconds
 * @param {string} timeString - Time in SRT format (00:00:00,000) or MMmSSsNNNms format (00m00s000ms)
 * @returns {number} - Time in seconds
 */
export const convertTimeStringToSeconds = (timeString) => {
  if (!timeString) return 0;

  // Check if timeString is a string
  if (typeof timeString !== 'string') {
    console.warn('Invalid time string type:', typeof timeString, timeString);
    return 0;
  }

  // Handle SRT format (00:00:00,000)
  const srtMatch = timeString.match(/^(\d+):(\d+):(\d+),(\d+)$/);
  if (srtMatch) {
    const hours = parseInt(srtMatch[1]);
    const minutes = parseInt(srtMatch[2]);
    const seconds = parseInt(srtMatch[3]);
    const milliseconds = parseInt(srtMatch[4]);

    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  }

  // Handle MMmSSsNNNms format (e.g., 00m30s500ms)
  const mmssmsMatch = timeString.match(/^(\d+)m(\d+)s(\d+)ms$/);
  if (mmssmsMatch) {
    const minutes = parseInt(mmssmsMatch[1]);
    const seconds = parseInt(mmssmsMatch[2]);
    const milliseconds = parseInt(mmssmsMatch[3]);

    return minutes * 60 + seconds + milliseconds / 1000;
  }

  // Handle WebVTT format (00:00:00.000)
  const vttMatch = timeString.match(/^(\d+):(\d+):(\d+)\.(\d+)$/);
  if (vttMatch) {
    const hours = parseInt(vttMatch[1]);
    const minutes = parseInt(vttMatch[2]);
    const seconds = parseInt(vttMatch[3]);
    const milliseconds = parseInt(vttMatch[4]);

    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
  }

  console.warn('Unrecognized time format:', timeString);
  return 0;
};

