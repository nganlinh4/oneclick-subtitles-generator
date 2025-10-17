/**
 * Shared progress tracking system for all video downloads - CLEANED VERSION
 */

// Global progress tracking for downloads
const downloadProgress = new Map();

/**
 * Get download progress for a video
 * @param {string} videoId - Video ID
 * @returns {Object} - Progress information
 */
function getDownloadProgress(videoId) {
  return downloadProgress.get(videoId) || { progress: 0, status: 'unknown' };
}

/**
 * Set download progress for a video
 * @param {string} videoId - Video ID
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} status - Download status
 */
function setDownloadProgress(videoId, progress, status = 'downloading') {
  // Clear cancelled status when starting a new download
  const currentProgress = downloadProgress.get(videoId);
  if (currentProgress && currentProgress.status === 'cancelled' && status === 'downloading' && progress <= 10) {
    console.log(`[ProgressTracker] Starting new download for previously cancelled: ${videoId}`);
    // Clear the cancelled status to allow the new download
    downloadProgress.delete(videoId);
  }

  // Map status to user-friendly phase names
  let phase = status;
  if (status === 'finalizing') phase = 'finalizing';
  else if (status === 'processing') phase = 'moving file';
  else if (status === 'normalizing') phase = 'normalizing video';
  else if (status === 'completed') phase = 'completed';
  else if (status === 'error') phase = 'error';
  else if (status === 'cancelled') phase = 'cancelled';
  else if (status === 'downloading') phase = 'downloading';
  else if (status === 'merge') phase = 'merging';

  downloadProgress.set(videoId, {
    progress,
    status,
    phase,
    timestamp: Date.now()
  });

  // Broadcast to WebSocket clients
  try {
    const { broadcastProgress } = require('./progressWebSocket');
    broadcastProgress(videoId, progress, status, phase);
    console.log(`[Progress] ${videoId}: ${progress}% - ${phase}`);
  } catch (error) {
    // WebSocket module might not be initialized yet
  }
}

/**
 * Clear download progress for a video
 * @param {string} videoId - Video ID
 */
function clearDownloadProgress(videoId) {
  downloadProgress.delete(videoId);
}

/**
 * Mark a download as cancelled
 * @param {string} videoId - Video ID
 */
function cancelDownloadProgress(videoId) {
  setDownloadProgress(videoId, 0, 'cancelled');
}

/**
 * Parse yt-dlp progress output - ENHANCED VERSION
 * @param {string} output - Raw output from yt-dlp
 * @returns {Object|null} - Parsed progress info or null
 */
function parseYtdlpProgress(output) {
  // Remove ANSI escape codes if present
  const cleanOutput = output.replace(/\x1b\[[0-9;]*m/g, '').trim();
  
  // Match various progress formats
  // Format 1: [download]  45.2% of 123.45MiB at 1.23MiB/s ETA 00:30
  // Format 2: [download] 100% of   50.07MiB in 00:00:46 at 1.08MiB/s
  // Format 3: download  45.2% of ...
  const progressMatch = cleanOutput.match(/(?:\[download\]|download)\s+(\d+\.?\d*)%/);
  if (progressMatch) {
    const progress = parseFloat(progressMatch[1]);

    // Only return valid progress values
    if (progress >= 0 && progress <= 100) {
      // Determine phase from output
      let phase = 'downloading';
      let details = '';
      
      // Extract additional info
      const sizeMatch = cleanOutput.match(/of\s+([\d.]+\w+)/);  // e.g., "of 50.07MiB"
      const speedMatch = cleanOutput.match(/at\s+([\d.]+\w+\/s)/); // e.g., "at 1.08MiB/s"
      const etaMatch = cleanOutput.match(/ETA\s+(\d+:\d+)/); // e.g., "ETA 00:30"
      
      if (sizeMatch) details += `Size: ${sizeMatch[1]}`;
      if (speedMatch) details += ` Speed: ${speedMatch[1]}`;
      if (etaMatch) details += ` ETA: ${etaMatch[1]}`;
      
      // Check file type
      if (cleanOutput.includes('.f8.') || cleanOutput.includes('video')) {
        phase = 'video';
      } else if (cleanOutput.includes('.f2.') || cleanOutput.includes('audio')) {
        phase = 'audio';
      }
      
      return {
        progress: progress,
        status: 'downloading',
        phase: phase,
        details: details.trim()
      };
    }
  }

  // Check for merging phase
  if (cleanOutput.includes('[Merger]') || 
      cleanOutput.includes('Merging') || 
      cleanOutput.includes('ffmpeg command line')) {
    return {
      progress: 95,
      status: 'merging',
      phase: 'merge'
    };
  }

  // Check for completion
  if (cleanOutput.includes('[download] 100%') ||
      cleanOutput.includes('has already been downloaded') ||
      cleanOutput.includes('Deleting original file')) {
    return {
      progress: 100,
      status: 'completed',
      phase: 'completed'
    };
  }

  // Check for extracting/starting phase
  if (cleanOutput.includes('Extracting') || 
      cleanOutput.includes('Downloading webpage') ||
      cleanOutput.includes('Downloading video formats')) {
    return {
      progress: 1,
      status: 'downloading',
      phase: 'extracting'
    };
  }

  return null;
}

/**
 * Update progress from yt-dlp output - RAW PROGRESS, NO VALIDATION
 * @param {string} videoId - Video ID
 * @param {string} output - Raw output from yt-dlp
 */
function updateProgressFromYtdlpOutput(videoId, output) {
  if (!videoId) return;

  const progressInfo = parseYtdlpProgress(output);
  if (progressInfo) {
    setDownloadProgress(videoId, progressInfo.progress, progressInfo.status);

    // Broadcast to WebSocket clients with phase information
    try {
      const { broadcastProgress } = require('./progressWebSocket');
      broadcastProgress(videoId, progressInfo.progress, progressInfo.status, progressInfo.phase);
      
      // Log progress only at intervals to reduce spam
      if (progressInfo.progress % 5 === 0 || progressInfo.progress === 100) {
        console.log(`[Progress] ${videoId}: ${progressInfo.progress}% - ${progressInfo.phase} ${progressInfo.details || ''}`);
      }
    } catch (error) {
      // WebSocket module might not be initialized yet, that's okay
    }
  }
}

module.exports = {
  getDownloadProgress,
  setDownloadProgress,
  clearDownloadProgress,
  cancelDownloadProgress,
  parseYtdlpProgress,
  updateProgressFromYtdlpOutput
};
