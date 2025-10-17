/**
 * Global Download Manager - Prevents multiple yt-dlp processes for the same video
 */

// Global locks across all routes
const globalActiveDownloads = new Map(); // videoId -> { route, startTime, processId, timeout, processRef }

/**
 * Check if a video is currently being downloaded
 * @param {string} videoId - Video ID to check
 * @returns {boolean} - True if download is active
 */
function isDownloadActive(videoId) {
  return globalActiveDownloads.has(videoId);
}

/**
 * Lock a video download
 * @param {string} videoId - Video ID to lock
 * @param {string} route - Route name (e.g., 'video', 'quality-scan', 'download-only')
 * @param {number} processId - Process ID (optional)
 * @param {Object} processRef - Process reference object for cancellation (optional)
 * @returns {boolean} - True if lock was acquired, false if already locked
 */
function lockDownload(videoId, route, processId = null, processRef = null) {
  if (globalActiveDownloads.has(videoId)) {
    const existing = globalActiveDownloads.get(videoId);
    console.log(`[GlobalDownloadManager] BLOCKED: ${route} tried to download ${videoId}, but ${existing.route} is already downloading it`);
    return false;
  }

  // Set up auto-release timeout (5 minutes)
  const timeout = setTimeout(() => {
    if (globalActiveDownloads.has(videoId)) {
      console.log(`[GlobalDownloadManager] AUTO-UNLOCK: Releasing stale lock for ${videoId} (was held by ${route})`);

      // Clean up process if it exists
      const info = globalActiveDownloads.get(videoId);
      if (info && info.processRef) {
        cleanupProcess(info.processRef);
      }

      globalActiveDownloads.delete(videoId);
    }
  }, 5 * 60 * 1000); // 5 minutes

  globalActiveDownloads.set(videoId, {
    route,
    startTime: Date.now(),
    processId,
    timeout,
    processRef
  });

  console.log(`[GlobalDownloadManager] LOCKED: ${route} acquired lock for ${videoId} (auto-release in 5 minutes)`);
  return true;
}

/**
 * Unlock a video download
 * @param {string} videoId - Video ID to unlock
 * @param {string} route - Route name (for logging)
 */
function unlockDownload(videoId, route, options = { cleanup: true }) {
  if (globalActiveDownloads.has(videoId)) {
    const info = globalActiveDownloads.get(videoId);
    // Clear the auto-release timeout
    if (info.timeout) {
      clearTimeout(info.timeout);
    }
    // Clean up process only if requested (on error or cancel)
    if (options.cleanup && info.processRef) {
      cleanupProcess(info.processRef);
    }
    globalActiveDownloads.delete(videoId);
    console.log(`[GlobalDownloadManager] UNLOCKED: ${route} released lock for ${videoId}`);
  }
}

/**
 * Get info about who is downloading a video
 * @param {string} videoId - Video ID to check
 * @returns {Object|null} - Download info or null if not active
 */
function getDownloadInfo(videoId) {
  return globalActiveDownloads.get(videoId) || null;
}

/**
 * Clean up stale downloads (older than specified threshold)
 * @param {number} thresholdMinutes - Minutes after which a download is considered stale (default: 10)
 * @returns {Array} - Array of cleaned up video IDs
 */
function cleanupStaleDownloads(thresholdMinutes = 10) {
  const now = Date.now();
  const staleThreshold = thresholdMinutes * 60 * 1000;
  const cleanedUp = [];

  for (const [videoId, info] of globalActiveDownloads.entries()) {
    if (now - info.startTime > staleThreshold) {
      console.log(`[GlobalDownloadManager] CLEANUP: Removing stale download lock for ${videoId} (${info.route}, age: ${Math.round((now - info.startTime) / 60000)} minutes)`);
      globalActiveDownloads.delete(videoId);
      cleanedUp.push(videoId);
    }
  }

  if (cleanedUp.length > 0) {
    console.log(`[GlobalDownloadManager] Cleaned up ${cleanedUp.length} stale downloads`);
  }

  return cleanedUp;
}

/**
 * Force cleanup a specific download
 * @param {string} videoId - Video ID to force cleanup
 * @returns {boolean} - True if cleaned up, false if not found
 */
function forceCleanupDownload(videoId) {
  if (globalActiveDownloads.has(videoId)) {
    const info = globalActiveDownloads.get(videoId);
    // Clear the auto-release timeout
    if (info.timeout) {
      clearTimeout(info.timeout);
    }
    console.log(`[GlobalDownloadManager] FORCE CLEANUP: Removing download lock for ${videoId} (${info.route})`);
    globalActiveDownloads.delete(videoId);
    return true;
  }
  return false;
}

/**
 * Check if a download is stale
 * @param {string} videoId - Video ID to check
 * @param {number} thresholdMinutes - Minutes after which a download is considered stale (default: 5)
 * @returns {boolean} - True if stale or not found
 */
function isDownloadStale(videoId, thresholdMinutes = 5) {
  const info = globalActiveDownloads.get(videoId);
  if (!info) return true; // Not found means it's not active

  const now = Date.now();
  const ageMinutes = (now - info.startTime) / 60000;
  const isStale = ageMinutes > thresholdMinutes;

  if (isStale) {
    console.log(`[GlobalDownloadManager] Download ${videoId} is stale (age: ${Math.round(ageMinutes)} minutes)`);
  }

  return isStale;
}

/**
 * Get all active downloads
 * @returns {Array} - Array of active download info
 */
function getAllActiveDownloads() {
  const downloads = [];
  const now = Date.now();

  for (const [videoId, info] of globalActiveDownloads.entries()) {
    downloads.push({
      videoId,
      route: info.route,
      startTime: info.startTime,
      ageMinutes: Math.round((now - info.startTime) / 60000),
      processId: info.processId
    });
  }

  return downloads;
}

/**
 * Clean up a process (e.g., close browser, abort request)
 * @param {Object} processRef - Process reference object
 */
function cleanupProcess(processRef) {
  if (!processRef) return;

  // Abort HTTP request if abort controller exists
  if (processRef.abortController && typeof processRef.abortController.abort === 'function') {
    console.log('[GlobalDownloadManager] Aborting HTTP request...');
    try {
      processRef.abortController.abort();
    } catch (e) {
      console.error('Error aborting HTTP request:', e);
    }
  }

  // Close Puppeteer browser if it exists
  if (processRef.browser && typeof processRef.browser.close === 'function') {
    console.log('[GlobalDownloadManager] Closing Puppeteer browser...');
    // Use a timeout to prevent hanging
    Promise.race([
      processRef.browser.close(),
      new Promise(resolve => setTimeout(resolve, 5000)) // 5 second timeout
    ]).catch(e => {
      console.error('Error closing browser during cleanup:', e);
      // Force kill if normal close fails
      if (processRef.browser && typeof processRef.browser.process === 'function') {
        try {
          const browserProcess = processRef.browser.process();
          if (browserProcess) {
            browserProcess.kill('SIGKILL');
          }
        } catch (killError) {
          console.error('Error force-killing browser process:', killError);
        }
      }
    });
  }
}

/**
 * Cancel an ongoing download
 * @param {string} videoId - Video ID to cancel
 * @returns {boolean} - True if cancel was successful
 */
function cancelDownload(videoId) {
  const info = globalActiveDownloads.get(videoId);

  if (!info) {
    console.log(`[GlobalDownloadManager] Cancel request for ${videoId}, but no active download found.`);
    return false;
  }

  console.log(`[GlobalDownloadManager] CANCEL: Cancelling download for ${videoId} (was held by ${info.route})`);

  // Set cancellation flag first to prevent race conditions
  if (info.processRef) {
    info.processRef.cancelled = true;
  }

  // Clean up the process
  if (info.processRef) {
    cleanupProcess(info.processRef);
  }

  // Clear the auto-release timeout
  if (info.timeout) {
    clearTimeout(info.timeout);
  }

  // Remove from active downloads
  globalActiveDownloads.delete(videoId);

  return true;
}

/**
 * Update the process reference for an active download
 * @param {string} videoId - Video ID to update
 * @param {Object} processRef - New process reference object
 */
function updateProcessRef(videoId, processRef) {
  if (globalActiveDownloads.has(videoId)) {
    const info = globalActiveDownloads.get(videoId);
    info.processRef = processRef;
    globalActiveDownloads.set(videoId, info);
    console.log(`[GlobalDownloadManager] Updated process reference for ${videoId}`);
  }
}

// Run cleanup every 2 minutes (more frequently for better responsiveness)
setInterval(() => cleanupStaleDownloads(10), 2 * 60 * 1000);

module.exports = {
  isDownloadActive,
  lockDownload,
  unlockDownload,
  getDownloadInfo,
  cleanupStaleDownloads,
  forceCleanupDownload,
  isDownloadStale,
  getAllActiveDownloads,
  cancelDownload,
  updateProcessRef
};
