/**
 * Utility functions for downloading and handling videos from any site using yt-dlp
 */

import progressWebSocketClient from './progressWebSocketClient';

// Global download queue to track video download status
const downloadQueue = {};

// Track active download intervals for cancellation
const activeDownloadIntervals = {};

// Server URL for the local download server - using unified port configuration
const SERVER_URL = 'http://localhost:3031';

/**
 * Check if a video is already downloaded
 * @param {string} videoId - The video ID
 * @returns {Promise<boolean>} - True if the video is already downloaded
 */
const isVideoAlreadyDownloaded = async (videoId) => {
  try {
    const response = await fetch(`${SERVER_URL}/videos/${videoId}.mp4`, {
      method: 'HEAD',
    });
    return response.ok;
  } catch (error) {
    console.error('Error checking if video is downloaded:', error);
    return false;
  }
};

/**
 * Fetch video file as blob and convert to File object
 * @param {string} videoId - The video ID
 * @returns {Promise<File>} - File object for the video
 */
const fetchVideoAsFile = async (videoId) => {
  let lastError = null;
  const maxRetries = 3;
  const retryDelay = 500; // ms
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Add a small delay before fetching (except first attempt)
      if (attempt > 1) {
        console.log(`[fetchVideoAsFile] Retry attempt ${attempt} for ${videoId}`);
        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
      }
      
      const response = await fetch(`${SERVER_URL}/videos/${videoId}.mp4?t=${Date.now()}`, {
        method: 'GET',
        cache: 'no-cache'
      });

      if (!response.ok) {
        throw new Error(`Error fetching video file: ${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();

      // Check if the blob has a reasonable size
      if (blob.size < 100 * 1024) { // Less than 100KB
        console.error(`[fetchVideoAsFile] Downloaded blob is too small (${blob.size} bytes) on attempt ${attempt}`);
        if (attempt === maxRetries) {
          throw new Error(`Downloaded blob is too small (${blob.size} bytes), likely not a valid video`);
        }
        lastError = new Error(`Blob too small: ${blob.size} bytes`);
        continue; // Retry
      }

      // Success - return the file
      console.log(`[fetchVideoAsFile] Successfully fetched ${videoId}: ${Math.round(blob.size / 1024 / 1024 * 100) / 100} MB`);
      return new File([blob], `${videoId}.mp4`, { type: 'video/mp4' });
      
    } catch (error) {
      console.error(`[fetchVideoAsFile] Attempt ${attempt} failed:`, error.message);
      lastError = error;
      
      if (attempt === maxRetries) {
        throw lastError;
      }
    }
  }
  
  // Shouldn't reach here, but just in case
  throw lastError || new Error('Failed to fetch video file after retries');
};

/**
 * Check download progress
 * @param {string} videoId - The video ID
 * @returns {Promise<number>} - Download progress (0-100)
 */
const checkDownloadProgress = async (videoId) => {
  if (!downloadQueue[videoId]) {
    return 0;
  }

  // If the video is already downloaded, return 100%
  if (downloadQueue[videoId].status === 'completed') {
    return 100;
  }

  // If the video is downloading, simulate progress
  if (downloadQueue[videoId].status === 'downloading') {
    // Increment progress by a small amount each time
    downloadQueue[videoId].progress = Math.min(
      95, // Cap at 95% until we confirm it's done
      downloadQueue[videoId].progress + 1
    );
    return downloadQueue[videoId].progress;
  }

  return 0;
};

/**
 * Cancel a video download
 * @param {string} videoId - The video ID
 */
const cancelDownload = async (videoId) => {
  if (!downloadQueue[videoId]) {
    return;
  }

  // Clear the progress check interval
  if (activeDownloadIntervals[videoId]) {
    clearInterval(activeDownloadIntervals[videoId]);
    delete activeDownloadIntervals[videoId];
  }

  // Send cancel request to server
  try {
    await fetch(`${SERVER_URL}/api/cancel-generic-download/${videoId}`, {
      method: 'POST',
    });
  } catch (error) {
    console.error('Error cancelling download:', error);
  }

  // Mark as cancelled in the queue
  downloadQueue[videoId].status = 'cancelled';
  downloadQueue[videoId].progress = 0;
};

/**
 * Generate a video ID from a URL
 * @param {string} url - The video URL
 * @returns {string} - A unique ID for the video
 */
const generateVideoId = (url) => {
  try {
    // Create a consistent ID from URL
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace('www.', '');
    const path = urlObj.pathname.replace(/\//g, '_');
    const query = urlObj.search.replace(/[^a-zA-Z0-9]/g, '_');

    // Create a base ID from domain, path, and query
    const baseId = `${domain}${path}${query}`.replace(/[^a-zA-Z0-9]/g, '_');

    // Remove consecutive underscores and trim
    const cleanId = baseId.replace(/_+/g, '_').replace(/^_|_$/g, '');

    // Combine everything into a valid ID (no timestamp for caching)
    return `site_${cleanId}`;
  } catch (error) {
    console.error('Error generating video ID:', error);
    // Fallback to a hash-based ID for invalid URLs
    const hash = url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
    return `site_${hash}`;
  }
};

/**
 * Downloads a video from any site and waits for completion
 * @param {string} url - The video URL
 * @param {Function} onProgress - Progress callback (0-100)
 * @param {boolean} forceRefresh - Force a fresh download even if the video exists in cache
 * @returns {Promise<string>} - A promise that resolves to a video URL
 */
export const downloadGenericVideo = async (url, onProgress = () => {}, forceRefresh = false) => {
  // Generate a unique ID for this URL
  const videoId = generateVideoId(url);



  // If forceRefresh is true, remove any existing download from the queue
  if (forceRefresh && downloadQueue[videoId]) {

    delete downloadQueue[videoId];
  }

  // If this video is already in the download queue, return its status
  if (downloadQueue[videoId]) {
    // If it's already completed, return the URL
    if (downloadQueue[videoId].status === 'completed') {
      // Return the cached video file
      try {
        return await fetchVideoAsFile(videoId);
      } catch (error) {
        console.error('Error fetching cached video:', error);
        throw error;
      }
    }

    // If it's downloading, set up progress reporting
    if (downloadQueue[videoId].status === 'downloading') {
      // Subscribe to WebSocket for real-time progress
      progressWebSocketClient.subscribe(videoId, (progressData) => {
        if (downloadQueue[videoId]) {
          downloadQueue[videoId].progress = progressData.progress || 0;
          downloadQueue[videoId].status = progressData.status || 'downloading';
          onProgress(progressData.progress || 0);
          console.log(`[WebSocket] ${videoId}: ${progressData.progress}% - ${progressData.status}`);
        }
      }).catch(err => {
        console.warn('Failed to subscribe to WebSocket:', err);
      });
      
      // Set up fallback polling if not already set
      if (!activeDownloadIntervals[videoId]) {
        activeDownloadIntervals[videoId] = setInterval(() => {
          checkDownloadProgress(videoId).then(progress => {
            onProgress(progress);
          });
        }, 5000); // Poll less frequently since we have WebSocket
      }

      // Return a promise that resolves when the download is complete
      return new Promise((resolve, reject) => {
        downloadQueue[videoId].resolve = resolve;
        downloadQueue[videoId].reject = reject;
      });
    }

    // If it was cancelled, restart the download
    if (downloadQueue[videoId].status === 'cancelled') {
      delete downloadQueue[videoId];
    }
  }

  // Initialize the download queue entry
    downloadQueue[videoId] = {
      status: 'downloading',
      progress: 0,
      error: null
    };
    
    // Subscribe to WebSocket immediately for real-time progress
    progressWebSocketClient.subscribe(videoId, (progressData) => {
      if (downloadQueue[videoId]) {
        downloadQueue[videoId].progress = progressData.progress || 0;
        downloadQueue[videoId].status = progressData.status || 'downloading';
        onProgress(progressData.progress || 0);
        console.log(`[WebSocket] ${videoId}: ${progressData.progress}% - ${progressData.phase || 'downloading'}`);
        
        // If completed, clean up polling and resolve any pending promise
        if (progressData.status === 'completed') {
          // Clear polling interval if present
          if (activeDownloadIntervals[videoId]) {
            clearInterval(activeDownloadIntervals[videoId]);
            delete activeDownloadIntervals[videoId];
          }
    
          // Update queue state
          downloadQueue[videoId].status = 'completed';
          downloadQueue[videoId].progress = 100;
          onProgress(100);
    
          // Ensure we have a URL for the completed file
          if (!downloadQueue[videoId].url) {
            downloadQueue[videoId].url = `${SERVER_URL}/videos/${videoId}.mp4`;
          }
    
          // Try to resolve any pending promise by creating a File object
          if (downloadQueue[videoId].resolve) {
            fetchVideoAsFile(videoId)
              .then(file => {
                try {
                  downloadQueue[videoId].resolve(file);
                } catch (err) {
                  console.error('Error resolving download promise after WebSocket completion:', err);
                }
              })
              .catch(error => {
                console.error('Error creating File object after WebSocket completion:', error);
                if (downloadQueue[videoId].reject) {
                  downloadQueue[videoId].reject(error);
                }
              });
          }
    
          // Unsubscribe from further WebSocket updates for this video to avoid leaks
          try {
            progressWebSocketClient.unsubscribe(videoId);
          } catch (err) {
            // ignore unsubscribe errors
          }
        }
      }
    }).catch(err => {
      console.warn('[allSitesDownloader] WebSocket subscription failed:', err);
    });

  try {
    // Check if the video is already downloaded
    const isDownloaded = await isVideoAlreadyDownloaded(videoId);

    if (isDownloaded && !forceRefresh) {

      downloadQueue[videoId].status = 'completed';
      downloadQueue[videoId].progress = 100;
      onProgress(100);

      // Return the already downloaded video file
      try {
        return await fetchVideoAsFile(videoId);
      } catch (error) {
        console.error('Error fetching existing video:', error);
        throw error;
      }
    }

    // If not, start the download
    downloadQueue[videoId].status = 'downloading';
    downloadQueue[videoId].progress = 10;



    // Get quality setting from localStorage (default to 360p for consistency)
    const quality = localStorage.getItem('optimized_resolution') || '360p';

    // Request server to download the video
    const downloadResponse = await fetch(`${SERVER_URL}/api/download-generic-video`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        videoId,
        url,
        quality,
        forceRefresh: downloadQueue[videoId].forceRefresh,
        useCookies: localStorage.getItem('use_cookies_for_download') === 'true'
      }),
    });

    if (!downloadResponse.ok) {
      const errorData = await downloadResponse.json();
      throw new Error(errorData.error || 'Failed to download video');
    }

    const downloadData = await downloadResponse.json();

    if (!downloadData.success) {
      throw new Error(downloadData.error || 'Failed to download video');
    }

    // Set up progress reporting
    activeDownloadIntervals[videoId] = setInterval(async () => {
      // Try to get real progress from server first
      try {
        const progressResponse = await fetch(`${SERVER_URL}/api/generic-download-progress/${videoId}`);
        if (progressResponse.ok) {
          const progressData = await progressResponse.json();
          if (progressData.success) {
            // Update local progress with server progress
            downloadQueue[videoId].progress = progressData.progress;
            onProgress(progressData.progress);

            // If progress is 95% or more, check if the file exists
            if (progressData.progress >= 95) {
              isVideoAlreadyDownloaded(videoId).then(exists => {
                if (exists) {
                  // File exists, mark as completed
                  clearInterval(activeDownloadIntervals[videoId]);
                  delete activeDownloadIntervals[videoId];

                  downloadQueue[videoId].status = 'completed';
                  downloadQueue[videoId].progress = 100;
                  onProgress(100);

              // Resolve any pending promises with a File object
              if (downloadQueue[videoId].resolve) {
                fetchVideoAsFile(videoId)
                  .then(file => downloadQueue[videoId].resolve(file))
                  .catch(error => {
                    console.error('Error creating File object:', error);
                    downloadQueue[videoId].reject(error);
                  });
              }
            }
          });
        }
            return; // Exit early if we got real progress
          } else {
            // Fallback to local progress checking
            console.warn('Server progress not available, falling back to local progress');
          }
        } else {
          // Fallback to local progress checking
          console.warn('Error fetching server progress, falling back to local progress');
        }
      } catch (error) {
        console.warn('Error fetching server progress:', error);
        // Fallback to local progress checking
      }

      // Fallback: use local progress checking
      checkDownloadProgress(videoId).then(progress => {
        onProgress(progress);

        // If progress is 95%, check if the file exists
        if (progress >= 95) {
          isVideoAlreadyDownloaded(videoId).then(exists => {
            if (exists) {
              // File exists, mark as completed
              clearInterval(activeDownloadIntervals[videoId]);
              delete activeDownloadIntervals[videoId];

              downloadQueue[videoId].status = 'completed';
              downloadQueue[videoId].progress = 100;
              onProgress(100);

              // Resolve any pending promises with a File object
              if (downloadQueue[videoId].resolve) {
                fetchVideoAsFile(videoId)
                  .then(file => downloadQueue[videoId].resolve(file))
                  .catch(error => {
                    console.error('Error creating File object:', error);
                    downloadQueue[videoId].reject(error);
                  });
              }
            }
          });
        }
      });
    }, 1000);

    // Wait for the download to complete
    return new Promise((resolve, reject) => {
      downloadQueue[videoId].resolve = resolve;
      downloadQueue[videoId].reject = reject;

      // Check immediately if the file exists
      isVideoAlreadyDownloaded(videoId).then(exists => {
        if (exists) {
          // File exists, mark as completed
          clearInterval(activeDownloadIntervals[videoId]);
          delete activeDownloadIntervals[videoId];

          downloadQueue[videoId].status = 'completed';
          downloadQueue[videoId].progress = 100;
          onProgress(100);

          // Fetch and resolve with the video file
          fetchVideoAsFile(videoId)
            .then(file => resolve(file))
            .catch(error => {
              console.error('Error creating File object:', error);
              reject(error);
            });
        }
      });
    });
  } catch (error) {
    console.error('Error downloading video:', error);

    // Clean up
    if (activeDownloadIntervals[videoId]) {
      clearInterval(activeDownloadIntervals[videoId]);
      delete activeDownloadIntervals[videoId];
    }

    downloadQueue[videoId].status = 'error';
    downloadQueue[videoId].error = error.message;

    // Reject any pending promises
    if (downloadQueue[videoId].reject) {
      downloadQueue[videoId].reject(error);
    }

    throw error;
  }
};

export const cancelGenericVideoDownload = cancelDownload;
