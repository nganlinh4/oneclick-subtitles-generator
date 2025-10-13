/**
 * API routes for Douyin video operations
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { VIDEOS_DIR } = require('../config');
const { downloadDouyinVideoWithRetry } = require('../services/douyin');
const { getDownloadProgress } = require('../services/shared/progressTracker');

/**
 * POST /api/download-douyin-video - Download a Douyin video
 */
router.post('/download-douyin-video', async (req, res) => {
  const { videoId, url, quality = '360p', useCookies = false } = req.body;



  if (!videoId || !url) {
    return res.status(400).json({ error: 'Video ID and URL are required' });
  }

  const videoPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

  // Check if video already exists
  if (fs.existsSync(videoPath)) {
    return res.json({
      success: true,
      message: 'Video already downloaded',
      url: `/videos/${videoId}.mp4`
    });
  }

  try {
    // Download the video using yt-dlp with retry and fallback
    const result = await downloadDouyinVideoWithRetry(videoId, url, quality, useCookies);

    // Check if the file was created successfully
    if (fs.existsSync(videoPath)) {

      return res.json({
        success: true,
        message: result.message || 'Video downloaded successfully',
        url: `/videos/${videoId}.mp4`,
        method: result.method
      });
    } else {
      throw new Error('Download completed but video file was not found');
    }
  } catch (error) {
    console.error('Error downloading Douyin video:', error);

    // Clean up any partial file
    try {
      if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
      }
    } catch (e) {
      console.error('Error cleaning up incomplete file:', e);
    }

    // Provide a more user-friendly error message
    let errorMessage = 'Failed to download Douyin video';
    let details = error.message;

    if (error.message.includes('region-restricted')) {
      // This is already a formatted message from our TikTokDien approach
      errorMessage = 'This Douyin video is region-restricted';
      details = 'Douyin videos are only accessible from within China. You need to use a VPN with a Chinese server to access Douyin content.';
    } else if (error.message.includes('HTTP Error') || error.message.includes('Expecting value') || error.message.includes('Could not get direct video URL')) {
      errorMessage = 'Douyin API access restricted';
      details = 'Douyin restricts API access from outside China. You need to use a VPN with a Chinese server to download Douyin videos.';
    } else if (error.message.includes('private')) {
      errorMessage = 'This Douyin video is private';
      details = 'The video is not publicly accessible.';
    } else if (error.message.includes('deleted')) {
      errorMessage = 'This Douyin video has been deleted';
      details = 'The video is no longer available on Douyin.';
    } else if (error.message.includes('invalid') || error.message.includes('Invalid URL format')) {
      errorMessage = 'Invalid Douyin URL';
      details = 'Please check the URL and try again.';
    } else if (error.message.includes('TikTokDien extractor failed')) {
      errorMessage = 'TikTokDien extractor failed';
      details = 'The TikTokDien approach failed to download the video. This is likely due to regional restrictions.';
    }

    return res.status(500).json({
      error: errorMessage,
      details: details
    });
  }
});

/**
 * GET /api/douyin-download-progress/:videoId - Get download progress for a Douyin video
 */
router.get('/douyin-download-progress/:videoId', (req, res) => {
  const { videoId } = req.params;

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  try {
    const progress = getDownloadProgress(videoId);
    res.json({
      success: true,
      videoId: videoId,
      progress: progress.progress,
      status: progress.status,
      timestamp: progress.timestamp
    });
  } catch (error) {
    console.error('Error getting Douyin download progress:', error);
    res.status(500).json({
      error: 'Failed to get download progress',
      details: error.message
    });
  }
});

/**
 * POST /api/cancel-douyin-download/:videoId - Cancel an ongoing Douyin download
 */
router.post('/cancel-douyin-download/:videoId', (req, res) => {
  const { videoId } = req.params;

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }



  // Currently, we don't have a way to cancel an ongoing yt-dlp process
  // But we can return success to let the client know we received the request
  return res.json({
    success: true,
    message: 'Cancel request received'
  });
});

/**
 * GET /api/douyin-download-file/:videoId - Download a completed Douyin video file
 */
router.get('/douyin-download-file/:videoId', (req, res) => {
  const { videoId } = req.params;

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  const videoPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

  // Check if video exists
  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({
      success: false,
      error: 'Video file not found'
    });
  }

  try {
    // Set headers for file download
    const stats = fs.statSync(videoPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${videoId}.mp4"`);
    res.setHeader('Cache-Control', 'no-cache');

    // Stream the file
    const fileStream = fs.createReadStream(videoPath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('[DOUYIN] Error streaming file:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Error streaming file'
        });
      }
    });
  } catch (error) {
    console.error('[DOUYIN] Error serving download:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to serve download'
    });
  }
});

/**
 * GET /api/douyin-video-exists/:videoId - Check if a Douyin video exists
 */
router.get('/douyin-video-exists/:videoId', (req, res) => {
  const { videoId } = req.params;

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  const videoPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

  // Check if video exists
  if (fs.existsSync(videoPath)) {
    return res.json({
      exists: true,
      url: `/videos/${videoId}.mp4`
    });
  } else {
    return res.json({
      exists: false
    });
  }
});

module.exports = router;
