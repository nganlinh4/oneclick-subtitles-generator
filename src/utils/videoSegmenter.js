/**
 * Utility functions for handling video segmentation
 * This allows processing long videos by splitting them into smaller segments
 */

// Server URL for the local server - using unified port configuration
const SERVER_URL = 'http://localhost:3031'; // Backend server port

/**
 * Upload a video file to the server and split it into segments
 * @param {File} videoFile - The video file to upload and split
 * @param {number} segmentDuration - Duration of each segment in seconds (default: 600 seconds = 10 minutes)
 * @param {Function} onProgress - Progress callback function
 * @returns {Promise<Object>} - Object containing segment URLs and metadata
 */
export const uploadAndSplitVideo = async (videoFile, segmentDuration = 600, onProgress = () => {}) => {
  try {
    // Use translation key for uploading message
    onProgress(10, 'output.uploadingVideoToServer', 'Uploading video to server...');

    // Create URL with query parameter for segment duration
    const url = `${SERVER_URL}/api/upload-and-split-video?segmentDuration=${segmentDuration}`;

    // Upload the video file using FormData for streaming
    const formData = new FormData();
    formData.append('file', videoFile);

    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      // Add timeout settings to handle large files
      timeout: 300000, // 5 minutes timeout
    });

    if (!response.ok) {
      console.error('Upload failed with status:', response.status);
      let errorMessage = `Failed to upload and split video (Status: ${response.status})`;

      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch (e) {
        console.error('Error parsing error response:', e);
        // Try to get the text response instead
        try {
          const textResponse = await response.text();
          console.error('Error response text:', textResponse);
          errorMessage += ` - Server response: ${textResponse.substring(0, 100)}...`;
        } catch (textError) {
          console.error('Error getting response text:', textError);
        }
      }

      throw new Error(errorMessage);
    }

    // Use translation key for uploaded message
    onProgress(50, 'output.videoUploaded', 'Video uploaded, processing segments...');

    const data = await response.json();


    // Use translation key for segments ready message
    onProgress(100, 'output.videoSegmentsReady', 'Video segments ready');

    return {
      success: true,
      originalVideo: `${SERVER_URL}${data.originalVideo}`,
      batchId: data.batchId,
      segments: data.segments.map(segment => `${SERVER_URL}${segment}`),
      message: data.message
    };
  } catch (error) {
    console.error('Error uploading and splitting video:', error);
    throw error;
  }
};

/**
 * Fetch a video segment from a URL
 * @param {string} segmentUrl - URL of the segment to fetch
 * @returns {Promise<File>} - File object representing the segment
 */
export const fetchVideoSegment = async (segmentUrl) => {
  try {
    const response = await fetch(segmentUrl);

    if (!response.ok) {
      throw new Error(`Failed to fetch segment: ${response.statusText}`);
    }

    const blob = await response.blob();
    const filename = segmentUrl.split('/').pop();

    // Create a File object from the blob
    return new File([blob], filename, { type: blob.type });
  } catch (error) {
    console.error('Error fetching video segment:', error);
    throw error;
  }
};


/**
 * Extract a video segment locally on the server using ffmpeg and return it as a File
 * @param {File} videoFile - Source video file
 * @param {number} startSec - Start time in seconds
 * @param {number} endSec - End time in seconds
 * @returns {Promise<File>} - Extracted segment as a File
 */
export const extractVideoSegmentLocally = async (videoFile, startSec, endSec, options = {}) => {
  const url = `${SERVER_URL}/api/extract-video-segment?start=${encodeURIComponent(startSec)}&end=${encodeURIComponent(endSec)}`;
  const formData = new FormData();
  formData.append('file', videoFile);

  const headers = {};
  const runId = options && options.runId ? options.runId : undefined;
  if (runId) headers['X-Run-Id'] = runId;

  const res = await fetch(url, { method: 'POST', body: formData, headers });
  if (!res.ok) {
    let msg = `Failed to extract segment (Status: ${res.status})`;
    try { const data = await res.json(); if (data?.error) msg = data.error; } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  const clipUrl = data.url?.startsWith('http') ? data.url : `${SERVER_URL}${data.url}`;
  const resp2 = await fetch(clipUrl, { headers });
  if (!resp2.ok) throw new Error(`Failed to fetch extracted segment: ${resp2.statusText}`);
  const blob = await resp2.blob();
  const name = (clipUrl.split('/').pop()) || 'segment.mp4';

  // Cache mapping for offline refresh: per current video
  try {
    const videoKey = localStorage.getItem('current_file_cache_id')
      || localStorage.getItem('current_file_url')
      || localStorage.getItem('current_video_url')
      || (videoFile && (videoFile.__cacheId || `${videoFile.name}|${videoFile.size}`));
    if (videoKey) {
      const raw = localStorage.getItem('offline_segments_cache');
      const cache = raw ? JSON.parse(raw) : {};
      const list = Array.isArray(cache[videoKey]) ? cache[videoKey] : [];
      // Avoid duplicate entries for the same exact range
      const exists = list.some(e => Math.abs(e.start - startSec) < 1e-6 && Math.abs(e.end - endSec) < 1e-6);
      if (!exists) {
        list.push({ start: startSec, end: endSec, url: clipUrl, name, createdAt: Date.now() });
        cache[videoKey] = list;
        localStorage.setItem('offline_segments_cache', JSON.stringify(cache));
      }
      // Notify UI about availability
      try {
        window.dispatchEvent(new CustomEvent('offline-segment-cached', { detail: { start: startSec, end: endSec, url: clipUrl, name } }));
      } catch {}
    }
  } catch {}

  return new File([blob], name, { type: blob.type || 'video/mp4' });
};
