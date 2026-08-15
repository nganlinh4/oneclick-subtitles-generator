/**
 * Utility functions for parsing SRT files
 */

/**
 * Parse SRT file content into subtitle objects
 * @param {string} srtContent - The content of the SRT file
 * @returns {Array} - Array of subtitle objects
 */
export const parseSrtContent = (srtContent) => {
  if (typeof srtContent !== 'string' || srtContent.trim().length === 0) return [];

  const normalized = srtContent
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const blocks = normalized
    .split(/\n[\t ]*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length === 0) return [];

  const subtitles = [];
  const seenIds = new Set();
  for (const block of blocks) {
    const lines = block.split('\n');
    const hasSequence = /^\d+$/.test(lines[0]?.trim() ?? '');
    const timingIndex = hasSequence ? 1 : 0;
    const timingLine = lines[timingIndex]?.trim();
    const textLines = lines.slice(timingIndex + 1);
    if (!timingLine || textLines.length === 0) return [];

    const timingParts = timingLine.split('-->');
    if (timingParts.length !== 2) return [];
    const start = parseSrtTimestamp(timingParts[0].trim());
    const endToken = timingParts[1].trim().split(/\s+/)[0];
    const end = parseSrtTimestamp(endToken);
    if (start === null || end === null || end.totalMilliseconds <= start.totalMilliseconds) {
      return [];
    }

    const id = hasSequence ? Number(lines[0].trim()) : subtitles.length + 1;
    if (!Number.isSafeInteger(id) || id <= 0 || seenIds.has(id)) return [];
    seenIds.add(id);

    subtitles.push({
      id,
      start: start.totalMilliseconds / 1000,
      end: end.totalMilliseconds / 1000,
      text: textLines.join('\n').trim(),
      startTime: formatSrtTimestamp(start.totalMilliseconds),
      endTime: formatSrtTimestamp(end.totalMilliseconds),
    });
  }

  return subtitles;
};

const parseSrtTimestamp = (value) => {
  if (typeof value !== 'string') return null;
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number(match[4].padEnd(3, '0'));
  if (![hours, minutes, seconds, milliseconds].every(Number.isSafeInteger)
      || minutes >= 60 || seconds >= 60) {
    return null;
  }
  const totalMilliseconds = hours * 3_600_000
    + minutes * 60_000
    + seconds * 1_000
    + milliseconds;
  return Number.isSafeInteger(totalMilliseconds) ? { totalMilliseconds } : null;
};

const formatSrtTimestamp = (totalMilliseconds) => {
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor((totalMilliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  return `${padZero(hours)}:${padZero(minutes)}:${padZero(seconds)},${padZero(milliseconds, 3)}`;
};

/**
 * Pad a number with leading zeros
 * @param {number} num - The number to pad
 * @param {number} length - The desired length (default: 2)
 * @returns {string} - Padded number as string
 */
const padZero = (num, length = 2) => {
  return String(num).padStart(length, '0');
};

/**
 * Convert seconds to SRT time format (HH:MM:SS,mmm)
 * @param {number} seconds - Time in seconds
 * @returns {string} - Formatted time string
 */
export const secondsToSrtTime = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);
  
  return `${padZero(hours)}:${padZero(minutes)}:${padZero(secs)},${padZero(milliseconds, 3)}`;
};
