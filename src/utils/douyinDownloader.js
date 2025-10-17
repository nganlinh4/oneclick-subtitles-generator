/**
 * Utility functions for downloading and handling Douyin videos
 */

// Global download queue to track video download status
const downloadQueue = {};

// Track active download intervals for cancellation
const activeDownloadIntervals = {};

// Server URL for the local download server - using unified port configuration
const SERVER_URL = 'http://localhost:3031';

/**
 * Starts downloading a Douyin video to the local videos folder
 * This allows starting the download process in parallel with other operations
 * @param {string} douyinUrl - The Douyin video URL
 * @param {boolean} forceRefresh - Force a fresh download even if the video exists in cache
 * @returns {string} - The video ID that can be used to check download status
 */
export const startDouyinVideoDownload = (douyinUrl, forceRefresh = false) => {
  const videoId = extractDouyinVideoId(douyinUrl);
  if (!videoId) {
    throw new Error('Invalid Douyin URL');
  }

  // Check if already in the queue and not forcing refresh
  if (downloadQueue[videoId] && !forceRefresh) {
    return videoId;
  }

  // Initialize download status
  downloadQueue[videoId] = {
    status: 'initializing',
    progress: 0,
    url: null,
    error: null,
    forceRefresh: forceRefresh
  };

  // Start the download process asynchronously
  (async () => {
    try {


      // Check if the video already exists on the server (unless forceRefresh is true)
      if (!downloadQueue[videoId].forceRefresh) {
        const checkResponse = await fetch(`${SERVER_URL}/api/video-exists/${videoId}`);
        const checkData = await checkResponse.json();

        if (checkData.exists) {
          // Video already exists, no need to download

          downloadQueue[videoId].status = 'completed';
          downloadQueue[videoId].progress = 100;
          downloadQueue[videoId].url = `${SERVER_URL}${checkData.url}`;
          return;
        }
      } else {

      }

      // If not, start the download
      downloadQueue[videoId].status = 'downloading';
      downloadQueue[videoId].progress = 10;



      // Get quality setting from localStorage (default to 360p for consistency)
      const quality = localStorage.getItem('optimized_resolution') || '360p';

      // Request server to download the video
      const downloadResponse = await fetch(`${SERVER_URL}/api/download-douyin-video`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          videoId,
          url: douyinUrl,
          quality,
          forceRefresh: downloadQueue[videoId].forceRefresh,
          useCookies: localStorage.getItem('use_cookies_for_download') === 'true'
        }),
      });

      // Parse the response
      const responseData = await downloadResponse.json();

      if (!downloadResponse.ok) {
        // Handle error response
        const errorMessage = responseData.error || 'Failed to download video';
        const errorDetails = responseData.details || '';

        console.error(`Douyin download error: ${errorMessage}`, errorDetails);

        // Update queue with error information if it still exists
        if (downloadQueue[videoId]) {
          downloadQueue[videoId].status = 'error';
          downloadQueue[videoId].error = `${errorMessage}${errorDetails ? ': ' + errorDetails : ''}`;
          downloadQueue[videoId].progress = 0;
        }

        throw new Error(`${errorMessage}${errorDetails ? ': ' + errorDetails : ''}`);
      }

      // Handle successful response
      if (responseData.success) {
        downloadQueue[videoId].status = 'completed';
        downloadQueue[videoId].progress = 100;
        downloadQueue[videoId].url = `${SERVER_URL}${responseData.url}`;
        downloadQueue[videoId].method = responseData.method || 'unknown';

      } else {
        // This should not happen with the current API, but handle it just in case
        const errorMessage = responseData.error || 'Unknown download error';
        if (downloadQueue[videoId]) {
          downloadQueue[videoId].status = 'error';
          downloadQueue[videoId].error = errorMessage;
          downloadQueue[videoId].progress = 0;
        }
        throw new Error(errorMessage);
      }
    } catch (error) {
      console.error('Error downloading Douyin video:', error);
      // Update queue with error information if it still exists
      if (downloadQueue[videoId]) {
        downloadQueue[videoId].status = 'error';
        downloadQueue[videoId].error = error.message;
      }
    }
  })();

  return videoId;
};

/**
 * Checks the status of a Douyin video download
 * @param {string} videoId - The video ID to check
 * @returns {Object} - The download status object
 */
export const checkDouyinDownloadStatus = (videoId) => {
  if (!downloadQueue[videoId]) {
    return {
      status: 'not_found',
      progress: 0,
      url: null,
      error: 'Download not found'
    };
  }

  return { ...downloadQueue[videoId] };
};

/**
 * Downloads a Douyin video and waits for completion
 * @param {string} douyinUrl - The Douyin video URL
 * @param {Function} onProgress - Progress callback (0-100)
 * @param {boolean} forceRefresh - Force a fresh download even if the video exists in cache
 * @returns {Promise<string>} - A promise that resolves to a video URL
 */
export const downloadDouyinVideo = async (douyinUrl, onProgress = () => {}, forceRefresh = false) => {
  // If forceRefresh is true, remove any existing download from the queue
  const videoId = extractDouyinVideoId(douyinUrl);

  if (forceRefresh && downloadQueue[videoId]) {

    delete downloadQueue[videoId];
  }

  // Start the download process
  const id = startDouyinVideoDownload(douyinUrl, forceRefresh);
  const originalUrl = douyinUrl;

  // Set up an interval to check download status
  return new Promise((resolve, reject) => {
    // Check immediately first
    const initialStatus = checkDouyinDownloadStatus(id);
    if (initialStatus.status === 'completed') {
      onProgress(100);
      resolve(initialStatus.url);
      return;
    } else if (initialStatus.status === 'error') {
      reject(new Error(initialStatus.error || 'Unknown download error'));
      return;
    }

    // Then set up interval for continuous checking
    const checkInterval = setInterval(async () => {
      const status = checkDouyinDownloadStatus(id);

      // Always get real progress from server, regardless of local status
      try {
        const progressResponse = await fetch(`${SERVER_URL}/api/douyin-download-progress/${id}`);
        if (progressResponse.ok) {
          const progressData = await progressResponse.json();
          if (progressData.success) {
            // Update local queue with server status
            downloadQueue[id].progress = progressData.progress;
            downloadQueue[id].status = progressData.status;

            onProgress(progressData.progress);
          } else {
            // Fallback to local status progress
            onProgress(status.progress);
          }
        } else {
          // Fallback to local status progress
          onProgress(status.progress);
        }
      } catch (error) {
        console.warn('Error fetching Douyin download progress:', error);
        // Fallback to local status progress
        onProgress(status.progress);
      }

      if (status.status === 'completed') {
        // Check if the video URL is valid by making a HEAD request
        try {
          const checkResponse = await fetch(status.url, { method: 'HEAD' });
          if (!checkResponse.ok) {
            // Video file doesn't exist anymore, restart the download silently

            clearInterval(checkInterval);

            // Remove the video from the download queue
            delete downloadQueue[videoId];

            // Restart the download process
            const newVideoId = startDouyinVideoDownload(originalUrl);

            // Set up a new interval to check the new download
            const newCheckInterval = setInterval(async () => {
              const newStatus = checkDouyinDownloadStatus(newVideoId);

              // Always get real progress from server
              try {
                const progressResponse = await fetch(`${SERVER_URL}/api/douyin-download-progress/${newVideoId}`);
                if (progressResponse.ok) {
                  const progressData = await progressResponse.json();
                  if (progressData.success) {
                    // Update local queue with server status
                    downloadQueue[newVideoId].progress = progressData.progress;
                    downloadQueue[newVideoId].status = progressData.status;

                    onProgress(progressData.progress);
                  } else {
                    onProgress(newStatus.progress);
                  }
                } else {
                  onProgress(newStatus.progress);
                }
              } catch (error) {
                console.warn('Error fetching Douyin download progress:', error);
                onProgress(newStatus.progress);
              }

              if (newStatus.status === 'completed') {
                clearInterval(newCheckInterval);
                resolve(newStatus.url);
              } else if (newStatus.status === 'error') {
                clearInterval(newCheckInterval);
                reject(new Error(newStatus.error || 'Unknown download error'));
              }
            }, 1000);

            return;
          }
        } catch (error) {
          console.warn('Error checking video file:', error);
          // Continue with the normal flow even if the check fails
        }

        clearInterval(checkInterval);
        resolve(status.url);
      } else if (status.status === 'error') {
        clearInterval(checkInterval);
        reject(new Error(status.error || 'Unknown download error'));
      } else if (status.status === 'checking') {
        // Check if the video exists on the server
        try {
          const checkResponse = await fetch(`${SERVER_URL}/api/video-exists/${videoId}`);
          const checkData = await checkResponse.json();

          if (checkData.exists) {
            // Video exists, update status and resolve
            downloadQueue[videoId] = {
              status: 'completed',
              progress: 100,
              url: `${SERVER_URL}${checkData.url}`,
              error: null
            };
            clearInterval(checkInterval);
            resolve(`${SERVER_URL}${checkData.url}`);
            return;
          }
        } catch (error) {
          console.warn('Error checking video existence:', error);
        }
      }
    }, 1000);

    // Store the interval ID for potential cancellation
    activeDownloadIntervals[id] = checkInterval;
  });
};

/**
 * Cancels an ongoing Douyin video download
 * @param {string} videoId - The video ID to cancel
 * @returns {Promise<boolean>} - Success status
 */
export const cancelDouyinVideoDownload = async (videoId) => {
  if (!videoId) {
    return false;
  }

  // Clear the check interval if it exists
  if (activeDownloadIntervals[videoId]) {
    clearInterval(activeDownloadIntervals[videoId]);
    delete activeDownloadIntervals[videoId];
  }

  // Update status to cancelled if download exists in queue
  if (downloadQueue[videoId]) {
    downloadQueue[videoId].status = 'cancelled';
    downloadQueue[videoId].progress = 0;
  }

  // Try to cancel on the server side using the correct endpoint
  try {
    const response = await fetch(`${SERVER_URL}/api/cancel-douyin-download/${videoId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const result = await response.json();
    console.log('Server cancel response:', result);

    // Remove from download queue after successful server cancellation
    if (downloadQueue[videoId]) {
      delete downloadQueue[videoId];
    }

    return response.ok && result.success;
  } catch (error) {
    console.warn('Error cancelling download on server:', error);

    // Still remove from local queue even if server call fails
    if (downloadQueue[videoId]) {
      delete downloadQueue[videoId];
    }

    return false;
  }
};

/**
 * Extract Douyin video ID from various Douyin URL formats
 * @param {string} url - The Douyin URL
 * @returns {string|null} - The video ID or null if invalid
 */
export const extractDouyinVideoId = (url) => {
  if (!url) return null;

  // Extract ID from full URL format: https://www.douyin.com/video/7123456789012345678
  const fullUrlMatch = url.match(/douyin\.com\/video\/(\d+)/);
  if (fullUrlMatch && fullUrlMatch[1]) {
    return fullUrlMatch[1];
  }

  // Extract ID from short URL format: https://v.douyin.com/ABC123/
  const shortUrlMatch = url.match(/v\.douyin\.com\/([a-zA-Z0-9]+)/);
  if (shortUrlMatch && shortUrlMatch[1]) {
    return shortUrlMatch[1];
  }

  return null;
};

/**
 * Preload a Douyin video for faster playback
 * @param {string} douyinUrl - The Douyin video URL
 */
export const preloadDouyinVideo = (douyinUrl) => {


  if (!douyinUrl || (!douyinUrl.includes('douyin.com'))) {
    return;
  }

  // Store the URL in localStorage for the VideoPreview component
  localStorage.setItem('current_video_url', douyinUrl);

  // Start the background download process
  try {
    startDouyinVideoDownload(douyinUrl);
  } catch (error) {
    console.warn('Failed to start background download:', error);
  }
};
