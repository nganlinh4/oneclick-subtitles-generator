/**
 * Index file for audio file controller modules
 * Re-exports all functions from the modularized files
 */

// Import all modules
const serveAudio = require('./serveAudio');
const alignAudio = require('./alignAudio');
const batchProcessor = require('./batchProcessor');
const zipAudio = require('./zipAudio');
const enhancer = require('./enhancer');
const speedModifier = require('./speedModifier');
const trimModifier = require('./trimModifier');
const durationInfo = require('./durationInfo');

// Export all functions
module.exports = {
  // Serve audio files
  serveAudioFile: serveAudio.serveAudioFile,

  // Aligned audio processing
  downloadAlignedAudio: alignAudio.downloadAlignedAudio,

  // Batch processing for large numbers of segments
  processBatch: batchProcessor.processBatch,
  concatenateAudioFiles: batchProcessor.concatenateAudioFiles,
  analyzeAndAdjustSegments: batchProcessor.analyzeAndAdjustSegments,

  // Zip file creation
  downloadAllAudio: zipAudio.downloadAllAudio,

  // Audio speed modification
  modifyAudioSpeed: speedModifier.modifyAudioSpeed,
  batchModifyAudioSpeed: speedModifier.batchModifyAudioSpeed,

  // Audio trim modification
  batchModifyAudioTrim: trimModifier.batchModifyAudioTrim,
  modifyAudioTrimAndSpeedCombined: trimModifier.modifyAudioTrimAndSpeedCombined,
  batchModifyAudioTrimAndSpeedCombined: trimModifier.batchModifyAudioTrimAndSpeedCombined,

  // Duration info
  getAudioDuration: durationInfo.getAudioDuration,
  batchGetAudioDurations: durationInfo.batchGetAudioDurations,

  // Utility functions
  enhanceF5TTSNarrations: enhancer.enhanceF5TTSNarrations
};
