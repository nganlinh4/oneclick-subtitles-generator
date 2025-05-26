/**
 * Utility functions for downloading and handling YouTube videos
 */

// Global download queue to track video download status
const downloadQueue = {};

// Track active download intervals for cancellation
const activeDownloadIntervals = {};

// Server URL for the local YouTube download server
const SERVER_URL = 'http://localhost:3007'; // Changed from 3004 to match server port
const WEBSOCKET_URL = 'ws://localhost:3007'; // WebSocket server URL

// Global map to track active WebSocket connections
const videoWebSockets = {};

/**
 * Starts downloading a YouTube video to the local videos folder
 * This allows starting the download process in parallel with other operations
 * @param {string} youtubeUrl - The YouTube video URL
 * @param {boolean} forceRefresh - Force a fresh download even if the video exists in cache
 * @returns {string} - The video ID that can be used to check download status
 */
export const startYoutubeVideoDownload = (youtubeUrl, forceRefresh = false) => {
  const videoId = extractYoutubeVideoId(youtubeUrl);
  if (!videoId) {
    throw new Error('Invalid YouTube URL');
  }

  // Check if already in the queue and not forcing refresh
  if (downloadQueue[videoId] && !forceRefresh) {
    return videoId;
  }

  // Initialize download queue entry
  downloadQueue[videoId] = {
    status: 'checking',
    progress: 0,
    url: null,
    error: null,
    forceRefresh: forceRefresh // Store the forceRefresh flag
  };

  // Setup WebSocket connection if not already open
  if (!videoWebSockets[videoId] || videoWebSockets[videoId].readyState === WebSocket.CLOSED) {
    const ws = new WebSocket(WEBSOCKET_URL);
    videoWebSockets[videoId] = ws;

    ws.onopen = () => {
      console.log(`WebSocket connection opened for videoId: ${videoId}`);
      ws.send(JSON.stringify({ type: 'register', videoId: videoId }));

      // Proceed with the download initiation now that WebSocket is open
      initiateDownload(videoId);
    };

    ws.onmessage = (event) => {
      try {
        const parsedMessage = JSON.parse(event.data);
        if (parsedMessage.videoId === videoId) {
          if (parsedMessage.type === 'downloadProgress') {
            if (downloadQueue[videoId]) {
              downloadQueue[videoId].progress = parsedMessage.progress;
              downloadQueue[videoId].status = 'downloading'; // Ensure status is downloading
            }
          } else if (parsedMessage.type === 'registered') {
            console.log(`WebSocket registered for videoId: ${videoId}`);
          } else if (parsedMessage.type === 'error') {
            console.error(`Server-side error for ${videoId}: ${parsedMessage.message}`);
            if (downloadQueue[videoId]) {
                downloadQueue[videoId].status = 'error';
                downloadQueue[videoId].error = parsedMessage.message || 'Server-side WebSocket error';
            }
            // Optionally close WebSocket on server error message
            // ws.close();
          }
        }
      } catch (e) {
        console.error('Error parsing WebSocket message:', e);
      }
    };

    ws.onclose = () => {
      console.log(`WebSocket connection closed for videoId: ${videoId}`);
      if (downloadQueue[videoId] && downloadQueue[videoId].status === 'downloading') {
        // If download was in progress and not completed, mark as error
        downloadQueue[videoId].status = 'error';
        downloadQueue[videoId].error = 'WebSocket connection closed unexpectedly.';
      }
      delete videoWebSockets[videoId];
    };

    ws.onerror = (error) => {
      console.error(`WebSocket error for videoId: ${videoId}:`, error);
      if (downloadQueue[videoId]) {
        downloadQueue[videoId].status = 'error';
        downloadQueue[videoId].error = 'WebSocket connection error.';
      }
      delete videoWebSockets[videoId];
    };
  } else if (videoWebSockets[videoId].readyState === WebSocket.OPEN) {
    // If WebSocket is already open, just ensure registration and proceed
    videoWebSockets[videoId].send(JSON.stringify({ type: 'register', videoId: videoId }));
    initiateDownload(videoId);
  } else {
    // WebSocket is CONNECTING or CLOSING, queue might need handling or wait
    console.warn(`WebSocket for ${videoId} is in state: ${videoWebSockets[videoId].readyState}`);
    // Potentially retry or wait for OPEN state, for now, we'll let initiateDownload proceed
    // which might lead to download starting without WS progress if WS doesn't open in time.
    // Or, defer initiateDownload until ws.onopen is confirmed.
    // For simplicity, the current structure calls initiateDownload after attempting to set up ws.onopen.
  }


  // Asynchronous function to handle the actual download initiation
  const initiateDownload = async (currentVideoId) => {
    try {
      // Ensure queue entry exists, especially if called when WS was already open
      if (!downloadQueue[currentVideoId]) {
        downloadQueue[currentVideoId] = {
          status: 'checking',
          progress: 0,
          url: null,
          error: null,
          forceRefresh: forceRefresh
        };
      }

      if (!downloadQueue[currentVideoId].forceRefresh) {
        const checkResponse = await fetch(`${SERVER_URL}/api/video-exists/${currentVideoId}`);
        if (!checkResponse.ok) throw new Error(`Failed to check video existence: ${checkResponse.statusText}`);
        const checkData = await checkResponse.json();
        if (checkData.exists) {
          downloadQueue[currentVideoId].status = 'completed';
          downloadQueue[currentVideoId].progress = 100;
          downloadQueue[currentVideoId].url = `${SERVER_URL}${checkData.url}`;
          // If WebSocket is open, close it as download is "completed" (already existed)
          if (videoWebSockets[currentVideoId] && videoWebSockets[currentVideoId].readyState === WebSocket.OPEN) {
            videoWebSockets[currentVideoId].close();
          }
          return;
        }
      }

      downloadQueue[currentVideoId].status = 'downloading';
      // Small initial progress to indicate process has started
      // downloadQueue[currentVideoId].progress = 5; // WebSocket will soon provide real progress

      const downloadResponse = await fetch(`${SERVER_URL}/api/download-video`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: currentVideoId, forceRefresh: downloadQueue[currentVideoId].forceRefresh }),
      });

      if (!downloadResponse.ok) {
        const errorData = await downloadResponse.json();
        throw new Error(errorData.error || `Failed to start download: ${downloadResponse.statusText}`);
      }

      const downloadData = await downloadResponse.json();
      // The server's response means the download request was accepted.
      // Actual completion is tracked by polling or WebSocket.
      // If the server immediately says it's completed (e.g. from cache after forceRefresh), update.
      if (downloadData.success && downloadData.url) {
         // This part might be redundant if server relies on WS for progress and final status.
         // However, if download-video can return completed (e.g. server cache hit), handle it.
        if (downloadQueue[currentVideoId].status !== 'completed') { // Avoid race condition with WS updates
            // downloadQueue[currentVideoId].status = 'completed'; // Let polling handle final 'completed' state
            // downloadQueue[currentVideoId].progress = 100;
            // downloadQueue[currentVideoId].url = `${SERVER_URL}${downloadData.url}`;
        }
      }
      // Note: Actual 'completed' status and 100% progress should primarily be set by the polling logic
      // in downloadYoutubeVideo, which verifies file existence, or if server sends a final WS message.
    } catch (error) {
      console.error(`Error in download initiation for ${currentVideoId}:`, error);
      if (downloadQueue[currentVideoId]) {
        downloadQueue[currentVideoId].status = 'error';
        downloadQueue[currentVideoId].error = error.message;
      }
      // If WebSocket is open, send an error or close it
      if (videoWebSockets[currentVideoId] && videoWebSockets[currentVideoId].readyState === WebSocket.OPEN) {
        // videoWebSockets[currentVideoId].send(JSON.stringify({ type: 'error', videoId: currentVideoId, message: error.message }));
        videoWebSockets[currentVideoId].close();
      }
    }
  };

  // If WebSocket is already open, call initiateDownload directly.
  // Otherwise, it will be called in ws.onopen.
  if (videoWebSockets[videoId] && videoWebSockets[videoId].readyState === WebSocket.OPEN) {
    initiateDownload(videoId);
  } else if (!videoWebSockets[videoId] || videoWebSockets[videoId].readyState === WebSocket.CLOSED) {
    // WebSocket setup is in progress, initiateDownload will be called onopen
  } else {
    // WebSocket is CONNECTING or CLOSING, this case needs careful handling.
    // For now, we assume onopen will eventually trigger or an error/close will occur.
    // If it's CONNECTING, onopen will handle it. If CLOSING, it will soon be CLOSED.
    console.warn(`WebSocket for ${videoId} in intermediate state ${videoWebSockets[videoId].readyState}, download might be delayed or fail if WS doesn't open.`);
  }

  return videoId;
};

/**
 * Checks the status of a YouTube video download
 * @param {string} videoId - The YouTube video ID
 * @returns {Object} - Status object with properties: status, progress, url, error
 */
export const checkDownloadStatus = (videoId) => {
  if (!downloadQueue[videoId]) {
    // Not in queue, check if it might exist on server directly
    return {
      status: 'checking',
      progress: 0,
      url: null,
      error: null
    };
  }

  return downloadQueue[videoId];
};

/**
 * Downloads a YouTube video and waits for completion
 * @param {string} youtubeUrl - The YouTube video URL
 * @param {Function} onProgress - Progress callback (0-100)
 * @param {boolean} forceRefresh - Force a fresh download even if the video exists in cache
 * @returns {Promise<string>} - A promise that resolves to a video URL
 */
export const downloadYoutubeVideo = async (youtubeUrl, onProgress = () => {}, forceRefresh = false) => {
  // If forceRefresh is true, remove any existing download from the queue
  const videoId = extractYoutubeVideoId(youtubeUrl);

  if (forceRefresh && downloadQueue[videoId]) {

    delete downloadQueue[videoId];
  }

  // Start the download process
  startYoutubeVideoDownload(youtubeUrl, forceRefresh);

  // Store the original URL for potential redownload
  const originalUrl = youtubeUrl;



  // Poll for completion
  return new Promise((resolve, reject) => {
    let attempts = 0;
    // No maximum attempts - we'll wait indefinitely
    // let simulatedProgress = 5; // Removed simulated progress

    const checkInterval = setInterval(async () => {
      const status = checkDownloadStatus(videoId);

      // If status is 'downloading', progress is updated by WebSocket
      // Call onProgress with the current progress from the queue
      onProgress(status.progress);

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
            const newVideoId = startYoutubeVideoDownload(originalUrl);

            // Set up a new interval to check the download status
            const newCheckInterval = setInterval(async () => {
              const newStatus = checkDownloadStatus(newVideoId);
              onProgress(newStatus.progress);

              if (newStatus.status === 'completed') {
                clearInterval(newCheckInterval);
                resolve(newStatus.url);
              } else if (newStatus.status === 'error') {
                clearInterval(newCheckInterval);
                reject(new Error(newStatus.error || 'Unknown download error'));
              }
            }, 500);

            return;
          }
        } catch (error) {
          console.warn('Error checking video existence with HEAD request:', error);
          // Continue with the resolve anyway, the App.js error handling will catch any issues
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

      // Increment attempts counter (for logging purposes)
      ++attempts;

      // Log every 30 seconds to show we're still waiting
      if (attempts % 60 === 0) {

      }
    }, 500);
    // Store the interval for potential cancellation
    activeDownloadIntervals[videoId] = checkInterval;
  });
};

/**
 * Cancels an ongoing YouTube video download
 * @param {string} videoId - The video ID to cancel
 * @returns {boolean} - True if the download was cancelled, false if it wasn't found
 */
export const cancelYoutubeVideoDownload = (videoId) => {
  // Check if the video is in the download queue
  if (!downloadQueue[videoId]) {

    return false;
  }

  // Clear any active interval for this download
  if (activeDownloadIntervals[videoId]) {
    clearInterval(activeDownloadIntervals[videoId]);
    delete activeDownloadIntervals[videoId];
  }

  // Close and delete WebSocket if it exists
  if (videoWebSockets[videoId]) {
    videoWebSockets[videoId].close();
    delete videoWebSockets[videoId];
  }

  // Try to cancel the download on the server
  fetch(`${SERVER_URL}/api/cancel-download/${videoId}`, { method: 'POST' })
    .then(response => response.json())
    .then(data => {
      console.log('Server cancellation response:', data);
    })
    .catch(error => {
      console.error('Error cancelling download on server:', error);
    });

  // Update the download queue entry
  if (downloadQueue[videoId]) { // Ensure entry exists before updating
    downloadQueue[videoId].status = 'cancelled';
    downloadQueue[videoId].error = 'Download cancelled by user';
  }


  return true;
};

/**
 * Extract YouTube video ID from various YouTube URL formats
 * @param {string} url - The YouTube URL
 * @returns {string|null} - The video ID or null if invalid
 */
export const extractYoutubeVideoId = (url) => {
  if (!url) return null;

  // Handle both youtube.com and youtu.be formats
  const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[7] && match[7].length === 11) ? match[7] : null;
};