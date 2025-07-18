const express = require('express');
const router = express.Router();
const { scanAvailableQualities, getVideoInfo, downloadWithQuality } = require('../services/qualityScanner');
const path = require('path');
const fs = require('fs');
const { VIDEOS_DIR } = require('../config');
const { getDownloadProgress } = require('../services/shared/progressTracker');

/**
 * POST /api/scan-video-qualities - Scan available qualities for a video URL
 */
router.post('/scan-video-qualities', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'Video URL is required'
    });
  }

  try {
    console.log(`[QUALITY-SCAN] Scanning qualities for: ${url}`);
    
    // Scan available qualities
    const qualities = await scanAvailableQualities(url);
    
    console.log(`[QUALITY-SCAN] Found ${qualities.length} qualities:`, qualities.map(q => q.quality));
    
    res.json({
      success: true,
      qualities,
      message: `Found ${qualities.length} available qualities`
    });
  } catch (error) {
    console.error('[QUALITY-SCAN] Error scanning qualities:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to scan video qualities'
    });
  }
});

/**
 * POST /api/get-video-info - Get video information
 */
router.post('/get-video-info', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'Video URL is required'
    });
  }

  try {
    console.log(`[VIDEO-INFO] Getting info for: ${url}`);
    
    // Get video information
    const info = await getVideoInfo(url);
    
    console.log(`[VIDEO-INFO] Retrieved info for: ${info.title}`);
    
    res.json({
      success: true,
      info,
      message: 'Video information retrieved successfully'
    });
  } catch (error) {
    console.error('[VIDEO-INFO] Error getting video info:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get video information'
    });
  }
});

/**
 * POST /api/download-video-quality - Download video with specific quality
 */
router.post('/download-video-quality', async (req, res) => {
  const { url, quality, videoId } = req.body;

  if (!url || !quality) {
    return res.status(400).json({
      success: false,
      error: 'Video URL and quality are required'
    });
  }

  try {
    console.log(`[QUALITY-DOWNLOAD] Downloading ${quality} for: ${url}`);

    // Use provided video ID or generate unique one for progress tracking
    const progressVideoId = videoId || `quality_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    console.log(`[QUALITY-DOWNLOAD] Using video ID: ${progressVideoId}`);

    // Generate output path (with quality suffix for filename)
    const outputFilename = `${progressVideoId}_${quality}.mp4`;
    const outputPath = path.join(VIDEOS_DIR, outputFilename);

    // Ensure videos directory exists
    if (!fs.existsSync(VIDEOS_DIR)) {
      fs.mkdirSync(VIDEOS_DIR, { recursive: true });
    }

    // Remove existing file if it exists to force fresh download
    if (fs.existsSync(outputPath)) {
      console.log(`[QUALITY-DOWNLOAD] Removing existing file: ${outputPath}`);
      fs.unlinkSync(outputPath);
    }

    // Download with specific quality and progress tracking
    console.log(`[QUALITY-DOWNLOAD] Starting download with videoId: ${progressVideoId}`);
    await downloadWithQuality(url, outputPath, quality, progressVideoId);

    // Verify the file was actually created
    if (!fs.existsSync(outputPath)) {
      throw new Error(`Download completed but file not found at: ${outputPath}`);
    }

    const stats = fs.statSync(outputPath);
    console.log(`[QUALITY-DOWNLOAD] Download completed: ${outputFilename}, size: ${stats.size} bytes`);

    // Try to get video metadata to verify it's a valid video file
    try {
      const { getMediaDuration } = require('../services/videoProcessing/durationUtils');
      const duration = await getMediaDuration(outputPath);
      console.log(`[QUALITY-DOWNLOAD] Video metadata: duration=${duration}s`);
    } catch (metadataError) {
      console.warn(`[QUALITY-DOWNLOAD] Could not get video metadata: ${metadataError.message}`);
    }

    res.json({
      success: true,
      videoPath: `/videos/${outputFilename}`,
      quality,
      videoId: progressVideoId,
      message: `Video downloaded successfully in ${quality}`,
      fileSize: stats.size
    });
  } catch (error) {
    console.error('[QUALITY-DOWNLOAD] Error downloading video:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to download video'
    });
  }
});

/**
 * POST /api/scan-and-download - Combined endpoint to scan qualities and download
 */
router.post('/scan-and-download', async (req, res) => {
  const { url, selectedQuality, videoId } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'Video URL is required'
    });
  }

  try {
    console.log(`[SCAN-AND-DOWNLOAD] Processing: ${url}`);
    
    // First scan available qualities
    const qualities = await scanAvailableQualities(url);
    
    if (selectedQuality) {
      // If quality is specified, download it
      const qualityExists = qualities.some(q => q.quality === selectedQuality);
      
      if (!qualityExists) {
        return res.status(400).json({
          success: false,
          error: `Quality ${selectedQuality} not available`,
          availableQualities: qualities
        });
      }
      
      // Generate output path
      const outputFilename = videoId ? `${videoId}_${selectedQuality}.mp4` : `video_${Date.now()}_${selectedQuality}.mp4`;
      const outputPath = path.join(VIDEOS_DIR, outputFilename);
      
      // Ensure videos directory exists
      if (!fs.existsSync(VIDEOS_DIR)) {
        fs.mkdirSync(VIDEOS_DIR, { recursive: true });
      }
      
      // Download with specific quality
      await downloadWithQuality(url, outputPath, selectedQuality);
      
      res.json({
        success: true,
        qualities,
        downloadedVideo: {
          path: `/videos/${outputFilename}`,
          quality: selectedQuality
        },
        message: `Video downloaded successfully in ${selectedQuality}`
      });
    } else {
      // Just return available qualities
      res.json({
        success: true,
        qualities,
        message: `Found ${qualities.length} available qualities`
      });
    }
  } catch (error) {
    console.error('[SCAN-AND-DOWNLOAD] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process video'
    });
  }
});

/**
 * GET /api/quality-download-progress/:videoId - Get download progress for quality download
 */
router.get('/quality-download-progress/:videoId', (req, res) => {
  const { videoId } = req.params;

  try {
    const progress = getDownloadProgress(videoId);
    res.json({
      success: true,
      progress: progress.progress || 0,
      status: progress.status || 'unknown',
      error: progress.error || null
    });
  } catch (error) {
    console.error('[QUALITY-PROGRESS] Error getting progress:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get download progress'
    });
  }
});

module.exports = router;
