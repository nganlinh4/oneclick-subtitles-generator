/**
 * Client-side utility for scanning video qualities
 */

// Use unified port configuration - backend is on port 3031
const SERVER_URL = process.env.REACT_APP_SERVER_URL || 'http://localhost:3031';

/**
 * Check if URL is a Douyin URL
 * @param {string} url - URL to check
 * @returns {boolean} - Whether the URL is a Douyin URL
 */
const isDouyinUrl = (url) => {
  const douyinRegex = /^(https?:\/\/)?(www\.|v\.)?douyin\.com\/(video\/\d+|[a-zA-Z0-9]+\/?)/;
  return douyinRegex.test(url);
};

/**
 * Scan available video qualities for a given URL
 * @param {string} videoUrl - The video URL to scan
 * @returns {Promise<Array>} - Array of available quality options
 */
export const scanVideoQualities = async (videoUrl) => {
  try {
    const startResponse = await fetch(`${SERVER_URL}/api/scan-video-qualities`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: videoUrl,
        useCookies: localStorage.getItem('use_cookies_for_download') === 'true'
      })
    });

    const startData = await startResponse.json();
    console.log('[qualityScanner] Scan started:', startData);

    if (!startData.success) {
      throw new Error(startData.error || 'Failed to start quality scan');
    }

    const scanId = startData.scanId;
    console.log('[qualityScanner] Polling for results with scanId:', scanId);

    // Step 2: Poll for results
    const maxPolls = 60; // 5 minutes max (5 second intervals)
    let pollCount = 0;

    while (pollCount < maxPolls) {
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
      pollCount++;

      console.log(`[qualityScanner] Polling attempt ${pollCount}/${maxPolls}...`);

      const pollResponse = await fetch(`${SERVER_URL}/api/scan-video-qualities/${scanId}`);
      const pollData = await pollResponse.json();

      console.log('[qualityScanner] Poll result:', pollData);

      if (pollData.status === 'completed') {
        console.log('[qualityScanner] Scan completed! Found qualities:', pollData.qualities);
        return pollData.qualities;
      } else if (pollData.status === 'error') {
        throw new Error(pollData.error || 'Quality scan failed');
      }

      // Still scanning, continue polling
      console.log('[qualityScanner] Still scanning, waiting...');
    }

    throw new Error('Quality scan timeout - scan took too long to complete');

  } catch (error) {
    console.error('[qualityScanner] Error scanning qualities:', error);
    throw error;
  }
};

/**
 * Get video information including title and duration
 * @param {string} videoUrl - The video URL to get info for
 * @returns {Promise<Object>} - Video information
 */
export const getVideoInfo = async (videoUrl) => {
  try {
    console.log('[qualityScanner] Getting video info for:', videoUrl);

    // Create an AbortController for timeout (must be longer than backend timeout)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 360000); // 6 minute timeout (longer than backend's 5 minutes)

    const response = await fetch(`${SERVER_URL}/api/get-video-info`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: videoUrl
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const data = await response.json();
    
    if (data.success) {
      console.log('[qualityScanner] Got video info:', data.info);
      return data.info;
    } else {
      throw new Error(data.error || 'Failed to get video info');
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('[qualityScanner] Video info timeout - this may be due to cookie extraction taking longer');
      throw new Error('Video info timeout - please try again');
    }
    console.error('[qualityScanner] Error getting video info:', error);
    throw error;
  }
};

/**
 * Download video with specific quality
 * @param {string} videoUrl - The video URL
 * @param {string} quality - The quality to download (e.g., '720p', '1080p')
 * @param {string} videoId - Video ID for progress tracking
 * @returns {Promise<Object>} - Download result
 */
export const downloadVideoWithQuality = async (videoUrl, quality, videoId) => {
  try {
    console.log('[qualityScanner] Downloading video:', { videoUrl, quality, videoId });
    
    const response = await fetch(`${SERVER_URL}/api/download-video-quality`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: videoUrl,
        quality: quality,
        videoId: videoId,
        useCookies: localStorage.getItem('use_cookies_for_download') === 'true'
      }),
    });

    const data = await response.json();
    
    if (data.success) {
      console.log('[qualityScanner] Download started:', data);
      return data;
    } else {
      throw new Error(data.error || 'Failed to start video download');
    }
  } catch (error) {
    console.error('[qualityScanner] Error downloading video:', error);
    throw error;
  }
};

/**
 * Get download progress for a video
 * @param {string} videoId - Video ID to check progress for
 * @returns {Promise<Object>} - Progress information
 */
export const getDownloadProgress = async (videoId) => {
  try {
    const response = await fetch(`${SERVER_URL}/api/quality-download-progress/${videoId}`);
    const data = await response.json();
    
    if (data.success) {
      return {
        progress: data.progress || 0,
        status: data.status || 'unknown'
      };
    } else {
      throw new Error(data.error || 'Failed to get download progress');
    }
  } catch (error) {
    console.error('[qualityScanner] Error getting download progress:', error);
    throw error;
  }
};
