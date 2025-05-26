/**
 * Main YouTube downloader module that uses yt-dlp for downloading videos
 */

const path = require('path');
const { VIDEOS_DIR } = require('../../config');
const { getVideoInfo } = require('./infoUtils');
const { downloadWithYtdlp } = require('./ytdlpDownloader');
const { WebSocket } = require('ws'); // Import WebSocket

/**
 * Download YouTube video using yt-dlp
 * @param {string} videoId - YouTube video ID
 * @param {object} videoSocketMap - Map of video IDs to WebSocket clients
 * @returns {Promise<Object>} - Result object with success status and path
 */
async function downloadYouTubeVideo(videoId, videoSocketMap) {
  const videoURL = `https://www.youtube.com/watch?v=${videoId}`;
  const outputPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);
  const quality = '360p'; // As per existing logic, quality is hardcoded or consistently '360p'



  // Get video info first
  let videoInfo;
  try {
    videoInfo = await getVideoInfo(videoId);
  } catch (error) {
    console.warn(`Could not get video info from oEmbed API: ${error.message}`);
    videoInfo = { title: `YouTube Video ${videoId}` };
  }

  const onProgressCallback = (percentage) => {
    if (videoSocketMap && videoSocketMap[videoId]) {
      const wsClient = videoSocketMap[videoId];
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.send(JSON.stringify({
          type: 'downloadProgress',
          videoId: videoId,
          progress: percentage
        }));
      }
    }
  };

  try {
    await downloadWithYtdlp(videoURL, outputPath, quality, onProgressCallback);

    return {
      success: true,
      path: outputPath,
      message: `Video downloaded successfully with yt-dlp`,
      title: videoInfo.title,
      method: 'yt-dlp'
    };
  } catch (error) {
    console.error(`yt-dlp download failed:`, error.message);
    throw new Error(`YouTube download failed: ${error.message}`);
  }
}

module.exports = {
  downloadYouTubeVideo
};
