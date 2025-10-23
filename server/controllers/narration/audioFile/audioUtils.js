/**
 * Shared audio utilities for narration ffmpeg operations
 */

const path = require('path');

/**
 * Build codec args based on file extension
 * Fallback to copy for other formats.
 */
const getCodecArgs = (audioPath) => {
  const ext = String(path.extname(audioPath)).toLowerCase();
  if (ext === '.mp3') return ['-c:a', 'libmp3lame', '-b:a', '192k'];
  if (ext === '.wav') return ['-c:a', 'pcm_s16le', '-ar', '44100'];
  return ['-c:a', 'copy'];
};

module.exports = { getCodecArgs };

