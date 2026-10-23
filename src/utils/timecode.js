/**
 * Format a duration in seconds as a zero-padded HH:MM:SS<sep>mmm timecode.
 *
 * Used by translation/utils/formatTimeString; the separator selects WebVTT or SRT style.
 *
 * @param {number} seconds
 * @param {string} [sep='.'] separator before milliseconds ('.' for WebVTT, ',' for SRT)
 * @returns {string} e.g. "01:01:01.500"
 */
export const formatSecondsToTimecode = (seconds, sep = '.') => {
  if (seconds === undefined || seconds === null) return `00:00:00${sep}000`;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${sep}${String(ms).padStart(3, '0')}`;
};
