/**
 * Audio file controller for narration
 *
 * This file has been modularized to improve maintainability and handle large numbers of audio segments.
 * The implementation now uses batch processing to avoid ENAMETOOLONG errors when the FFmpeg command
 * becomes too long due to having too many audio segments.
 */

// Import all functions from the modularized files
const {
  serveAudioFile
} = require('./audioFile/serveAudio');

const {
  downloadAlignedAudio
} = require('./audioFile/alignAudio');

const {
  downloadAllAudio
} = require('./audioFile/zipAudio');

const {
  enhanceF5TTSNarrations
} = require('./audioFile/enhancer');

const {
  modifyAudioSpeed,
  batchModifyAudioSpeed
} = require('./audioFile/speedModifier');

const {
  batchModifyAudioTrim,
  modifyAudioTrimAndSpeedCombined,
  batchModifyAudioTrimAndSpeedCombined
} = require('./audioFile/trimModifier');

const {
  getAudioDuration,
  batchGetAudioDurations
} = require('./audioFile/durationInfo');

// Export all functions
module.exports = {
  serveAudioFile,
  downloadAlignedAudio,
  downloadAllAudio,
  enhanceF5TTSNarrations,
  modifyAudioSpeed,
  batchModifyAudioSpeed,
  batchModifyAudioTrim,
  modifyAudioTrimAndSpeedCombined,
  batchModifyAudioTrimAndSpeedCombined,
  getAudioDuration,
  batchGetAudioDurations
};