import { formatSecondsToTimecode } from '../../../utils/timecode';

/**
 * Format time in seconds to HH:MM:SS.mmm format
 * @param {number} timeInSeconds - Time in seconds
 * @returns {string} - Formatted time string
 */
const formatTimeString = (timeInSeconds) => formatSecondsToTimecode(timeInSeconds, '.');

export default formatTimeString;
