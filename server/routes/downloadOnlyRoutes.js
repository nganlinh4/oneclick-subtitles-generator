const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { VIDEOS_DIR } = require('../config');
const { getYtDlpPath, getYtDlpArgs } = require('../services/shared/ytdlpUtils');
const { setDownloadProgress, getDownloadProgress } = require('../services/shared/progressTracker');
const { updateProgressFromYtdlpOutput } = require('../services/shared/progressTracker');
const { lockDownload, unlockDownload, isDownloadActive, getDownloadInfo } = require('../services/shared/globalDownloadManager');

// Track active downloads to prevent duplicates
const activeDownloads = new Map();

// Track active file operations to prevent race conditions
const activeFileOperations = new Set();

// Track active yt-dlp processes to prevent multiple spawns and enable cancellation
const activeYtdlpProcesses = new Map(); // processKey -> { videoId, process }

/**
 * POST /api/download-only - Download video or audio only
 */
router.post('/download-only', async (req, res) => {
  const { url, type, quality, source, useCookies = false, forceRetry = false } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'Video URL is required'
    });
  }

  if (!type || !['video', 'audio'].includes(type)) {
    return res.status(400).json({
      success: false,
      error: 'Type must be either "video" or "audio"'
    });
  }

  // Generate unique video ID for progress tracking (outside try block for finally access)
  const timestamp = Date.now();
  const videoId = `${type}_${timestamp}_${Math.random().toString(36).substring(2, 9)}`;

  try {
    console.log(`[DOWNLOAD-ONLY] Starting ${type} download:`, { url, type, quality, source });

    // Check global download lock first
    if (isDownloadActive(videoId)) {
      const downloadInfo = getDownloadInfo(videoId);
      console.log(`[DOWNLOAD-ONLY] Download blocked: ${videoId} is already being downloaded by ${downloadInfo.route}`);
      
      // If forceRetry is true, clean up the stuck download and proceed
      if (forceRetry) {
        console.log(`[DOWNLOAD-ONLY] Force retry requested - cleaning up stuck download for ${videoId}`);
        unlockDownload(videoId, downloadInfo.route);
        // Clear any progress tracking
        const { clearDownloadProgress } = require('../services/shared/progressTracker');
        clearDownloadProgress(videoId);
        
        // Clean up any active download tracking
        for (const [key, vid] of activeDownloads.entries()) {
          if (vid === videoId) {
            activeDownloads.delete(key);
            console.log(`[DOWNLOAD-ONLY] Cleaned up active download tracking for: ${key}`);
            break;
          }
        }
        
        // Clean up any active yt-dlp processes
        for (const [processKey, processInfo] of activeYtdlpProcesses.entries()) {
          if (processInfo.videoId === videoId) {
            try {
              processInfo.process.kill('SIGTERM');
              console.log(`[DOWNLOAD-ONLY] Killed stuck yt-dlp process for: ${videoId}`);
            } catch (killErr) {
              console.error(`[DOWNLOAD-ONLY] Error killing process: ${killErr.message}`);
            }
            activeYtdlpProcesses.delete(processKey);
            break;
          }
        }
        
        console.log(`[DOWNLOAD-ONLY] Cleaned up stuck download, proceeding with retry`);
      } else {
        return res.status(409).json({
          success: false,
          error: 'Video is already being downloaded',
          activeRoute: downloadInfo.route,
          videoId: videoId,
          canRetry: true
        });
      }
    }

    // Create a unique key for this download request
    const downloadKey = `${url}_${type}_${quality || 'default'}`;

    // Check if this exact download is already in progress
    if (activeDownloads.has(downloadKey)) {
      const existingVideoId = activeDownloads.get(downloadKey);
      console.log(`[DOWNLOAD-ONLY] DUPLICATE DOWNLOAD DETECTED! Returning existing videoId: ${existingVideoId}`);
      return res.json({
        success: true,
        videoId: existingVideoId,
        message: 'Download already in progress',
        isDuplicate: true
      });
    }

    // Acquire global download lock
    if (!lockDownload(videoId, 'download-only-route')) {
      return res.status(409).json({
        success: false,
        error: 'Failed to acquire download lock',
        videoId: videoId
      });
    }

    // Register this download to prevent duplicates
    activeDownloads.set(downloadKey, videoId);
    console.log(`[DOWNLOAD-ONLY] Registered download: ${downloadKey} -> ${videoId}`);

    // Generate output filename
    const extension = type === 'video' ? 'mp4' : 'mp3';
    const outputFilename = `${videoId}.${extension}`;
    const outputPath = path.join(VIDEOS_DIR, outputFilename);

    // Check if this exact file is already being created (race condition protection)
    if (activeFileOperations.has(outputPath)) {
      console.log(`[DOWNLOAD-ONLY] File operation already in progress: ${outputPath}`);
      return res.json({
        success: false,
        error: 'File operation already in progress',
        videoId: videoId
      });
    }

    // Check if file already exists
    if (fs.existsSync(outputPath)) {
      console.log(`[DOWNLOAD-ONLY] File already exists: ${outputPath}`);
      return res.json({
        success: true,
        videoId: videoId,
        message: 'File already exists',
        filename: outputFilename,
        isExisting: true
      });
    }

    // Lock this file operation
    activeFileOperations.add(outputPath);
    console.log(`[DOWNLOAD-ONLY] Locked file operation: ${outputPath}`);

    // Check if yt-dlp process is already running for this exact command
    const processKey = `${url}_${type}_${quality || 'default'}`;
    if (activeYtdlpProcesses.has(processKey)) {
      console.log(`[DOWNLOAD-ONLY] yt-dlp process already running for: ${processKey}`);
      activeFileOperations.delete(outputPath);
      return res.json({
        success: false,
        error: 'Download process already running',
        videoId: videoId
      });
    }

    // Lock the yt-dlp process
    activeYtdlpProcesses.set(processKey, videoId);
    console.log(`[DOWNLOAD-ONLY] Locked yt-dlp process: ${processKey} -> ${videoId}`);

    // Ensure videos directory exists
    if (!fs.existsSync(VIDEOS_DIR)) {
      fs.mkdirSync(VIDEOS_DIR, { recursive: true });
    }

    // Remove existing file if it exists
    if (fs.existsSync(outputPath)) {
      console.log(`[DOWNLOAD-ONLY] Removing existing file: ${outputPath}`);
      fs.unlinkSync(outputPath);
    }

    // Start download process asynchronously; swallow rejections to avoid unhandled promise rejection crashing the server
    downloadMediaAsync(url, outputPath, type, quality, videoId, useCookies, processKey)
      .catch((err) => {
        console.error(`[DOWNLOAD-ONLY] Background download error for ${videoId}:`, err?.message || err);
      });

    res.json({
      success: true,
      videoId: videoId,
      message: `${type} download started`,
      downloadUrl: `/videos/${outputFilename}`,
      filename: outputFilename
    });

  } catch (error) {
    console.error('[DOWNLOAD-ONLY] Error starting download:', error);
    
    // Clear progress tracking
    const { clearDownloadProgress } = require('../services/shared/progressTracker');
    clearDownloadProgress(videoId);
    
    // Clean up any partial files
    const extension = type === 'video' ? 'mp4' : 'mp3';
    const outputFilename = `${videoId}.${extension}`;
    const outputPath = path.join(VIDEOS_DIR, outputFilename);
    try {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        console.log(`[DOWNLOAD-ONLY] Cleaned up partial file: ${outputPath}`);
      }
    } catch (cleanupErr) {
      console.error(`[DOWNLOAD-ONLY] Error cleaning up partial file: ${cleanupErr.message}`);
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to start download',
      videoId: videoId,
      canRetry: true
    });
  } finally {
    // Always release the global download lock
    unlockDownload(videoId, 'download-only-route');
  }
});

/**
 * GET /api/download-only-progress/:videoId - Get download progress
 */
router.get('/download-only-progress/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    const progress = getDownloadProgress(videoId);

    res.json({
      success: true,
      progress: progress.progress || 0,
      status: progress.status || 'unknown'
    });
  } catch (error) {
    console.error('[DOWNLOAD-ONLY] Error getting progress:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get download progress'
    });
  }
});

/**
 * GET /api/download-only-file/:videoId - Download the completed file
 */
router.get('/download-only-file/:videoId', (req, res) => {
  const { videoId } = req.params;

  try {
    // Determine file by existence; support multiple audio/video extensions produced by yt-dlp
    const candidates = [
      { ext: 'mp3', mime: 'audio/mpeg' },
      { ext: 'm4a', mime: 'audio/mp4' },
      { ext: 'webm', mime: 'audio/webm' },
      { ext: 'opus', mime: 'audio/ogg' },
      { ext: 'mp4', mime: 'video/mp4' }
    ];

    let filePath = null;
    let filename = null;
    let mimeType = null;

    for (const c of candidates) {
      const p = path.join(VIDEOS_DIR, `${videoId}.${c.ext}`);
      if (fs.existsSync(p)) {
        filePath = p;
        filename = `${videoId}.${c.ext}`;
        mimeType = c.mime;
        break;
      }
    }

    if (!filePath) {
      return res.status(404).json({
        success: false,
        error: 'File not found'
      });
    }

    // Set headers for file download
    const stats = fs.statSync(filePath);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-cache');

    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      console.error('[DOWNLOAD-ONLY] Error streaming file:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Error streaming file'
        });
      }
    });

  } catch (error) {
    console.error('[DOWNLOAD-ONLY] Error serving download:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to serve download'
    });
  }
});

/**
 * POST /api/cancel-download-only/:videoId - Cancel an ongoing download-only process
 */
router.post('/cancel-download-only/:videoId', (req, res) => {
  const { videoId } = req.params;

  if (!videoId) {
    return res.status(400).json({
      success: false,
      error: 'Video ID is required'
    });
  }

  try {
    let processFound = false;

    // Find and kill the yt-dlp process for this video
    for (const [processKey, processInfo] of activeYtdlpProcesses.entries()) {
      if (processInfo.videoId === videoId) {
        console.log(`[DOWNLOAD-ONLY] Cancelling download for ${videoId}, killing process`);

        // Kill the yt-dlp process
        processInfo.process.kill('SIGTERM');

        // Clean up tracking
        activeYtdlpProcesses.delete(processKey);

        // Update progress to cancelled
        setDownloadProgress(videoId, 0, 'cancelled');

        // Broadcast cancellation
        try {
          const { broadcastProgress } = require('../services/shared/progressWebSocket');
          broadcastProgress(videoId, 0, 'cancelled', 'download');
        } catch (error) {
          // WebSocket module might not be initialized yet
        }

        processFound = true;
        break;
      }
    }

    // Also clean up from activeDownloads map
    for (const [downloadKey, downloadVideoId] of activeDownloads.entries()) {
      if (downloadVideoId === videoId) {
        activeDownloads.delete(downloadKey);
        break;
      }
    }

    // Release global download lock
    unlockDownload(videoId, 'download-only-route');

    if (processFound) {
      res.json({
        success: true,
        message: `Download cancelled for ${videoId}`
      });
    } else {
      res.status(404).json({
        success: false,
        error: `No active download found for ${videoId}`
      });
    }
  } catch (error) {
    console.error('[DOWNLOAD-ONLY] Error cancelling download:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel download'
    });
  }
});

/**
 * Async function to download media (video or audio)
 */
async function downloadMediaAsync(url, outputPath, type, quality, videoId, useCookies = false, processKey) {
  return new Promise((resolve, reject) => {
    const ytDlpPath = getYtDlpPath();
    
    // Initialize progress tracking
    setDownloadProgress(videoId, 0, 'downloading');

    let args;
    if (type === 'video') {
      // Video download with quality - use the same logic as qualityScanner.js
      let formatSelector;
      if (quality) {
        const height = quality.replace('p', '');

        // Use the same format selection logic as the working qualityScanner
        if (url.includes('tiktok.com') || url.includes('douyin.com')) {
          // For TikTok/Douyin, use simple format to avoid compatibility issues
          formatSelector = `best[height<=${height}]`;
        } else {
          // For other sites (YouTube, etc.), use complex format for better quality
          formatSelector = `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
        }
      } else {
        // Default to best quality if no specific quality requested
        formatSelector = 'best[ext=mp4]/best';
      }

      args = [
        ...getYtDlpArgs(useCookies),
        '--format', formatSelector,
        '--merge-output-format', 'mp4',
        '--output', outputPath,
        '--no-playlist',
        '--progress',
        '--newline',
        '--force-overwrites',
        url
      ];
    } else {
      // Audio download
      args = [
        ...getYtDlpArgs(useCookies),
        '--format', 'bestaudio/best',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '192K',
        '--output', outputPath.replace('.mp3', '.%(ext)s'),
        '--no-playlist',
        '--progress',
        '--newline',
        '--force-overwrites',
        url
      ];
    }

    console.log(`[DOWNLOAD-ONLY] Starting yt-dlp with args:`, args);

    // FINAL CHECK: Ensure no other process is writing to this exact file
    try {
      // Try to open the file exclusively to check if it's being written to
      const fd = fs.openSync(outputPath, 'wx');
      fs.closeSync(fd);
      fs.unlinkSync(outputPath); // Remove the test file
    } catch (error) {
      if (error.code === 'EEXIST') {
        console.log(`[DOWNLOAD-ONLY] CRITICAL: File is being written by another process: ${outputPath}`);
        const cleanupKey = `${url}_${type}_${quality || 'default'}`;
        activeDownloads.delete(cleanupKey);
        activeFileOperations.delete(outputPath);
        activeYtdlpProcesses.delete(processKey);
        setDownloadProgress(videoId, 0, 'error');
        return reject(new Error('File is being written by another process'));
      }
    }

    const ytdlpProcess = spawn(ytDlpPath, args);

    // Track the process for cancellation
    activeYtdlpProcesses.set(processKey, { videoId, process: ytdlpProcess });

    let stderr = '';
    let stdoutBuffer = ''; // Buffer for line-by-line processing

    ytdlpProcess.stdout.on('data', (data) => {
      const output = data.toString();
      stdoutBuffer += output;

      // Process complete lines only
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop(); // Keep the incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          // Update progress tracking
          updateProgressFromYtdlpOutput(videoId, line);
        }
      }
    });

    ytdlpProcess.stderr.on('data', (data) => {
      const errorOutput = data.toString();
      stderr += errorOutput;
      console.error(`[DOWNLOAD-ONLY] yt-dlp stderr:`, errorOutput);
      // Removed duplicate progress parsing from stderr to prevent conflicts
    });

    ytdlpProcess.on('close', (code, signal) => {
      // Clean up the active download tracking
      const cleanupKey = `${url}_${type}_${quality || 'default'}`;
      activeDownloads.delete(cleanupKey);

      console.log(`[DOWNLOAD-ONLY] Cleaned up download tracking for: ${cleanupKey}`);

      // Clean up the file operation lock
      activeFileOperations.delete(outputPath);
      console.log(`[DOWNLOAD-ONLY] Released file operation lock: ${outputPath}`);

      // Clean up the yt-dlp process lock
      activeYtdlpProcesses.delete(processKey);
      console.log(`[DOWNLOAD-ONLY] Released yt-dlp process lock: ${processKey}`);

      // Detect explicit cancellation (by signal) or via progress tracker state
      let wasCancelled = false;
      try {
        const state = getDownloadProgress(videoId);
        wasCancelled = state && state.status === 'cancelled';
      } catch (e) {
        // ignore
      }

      if (code === 0) {
        console.log(`[DOWNLOAD-ONLY] Download completed successfully for ${videoId}`);
        setDownloadProgress(videoId, 100, 'completed');

        try {
          const { broadcastProgress } = require('../services/shared/progressWebSocket');
          broadcastProgress(videoId, 100, 'completed', 'download');
        } catch (error) {
          // WebSocket module might not be initialized yet
        }

        resolve();
      } else if (signal === 'SIGTERM' || wasCancelled) {
        console.log(`[DOWNLOAD-ONLY] Download cancelled for ${videoId} (signal: ${signal || 'none'})`);
        // Remove partial file if exists
        try {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
            console.log(`[DOWNLOAD-ONLY] Removed partial file after cancel: ${outputPath}`);
          }
        } catch (e) {
          console.warn(`[DOWNLOAD-ONLY] Failed to remove partial file ${outputPath}:`, e?.message || e);
        }
        // Do not mark as error; cancel route already set status to 'cancelled' and broadcasted
        resolve(); // Resolve gracefully to avoid unhandled rejection on cancellation
      } else {
        console.error(`[DOWNLOAD-ONLY] Download failed for ${videoId} with code ${code}:`, stderr);
        setDownloadProgress(videoId, 0, 'error');

        try {
          const { broadcastProgress } = require('../services/shared/progressWebSocket');
          broadcastProgress(videoId, 0, 'error', 'download');
        } catch (error) {
          // WebSocket module might not be initialized yet
        }

        // Provide more user-friendly error messages
        let errorMessage = stderr;
        if (stderr.includes('Requested format is not available')) {
          errorMessage = `The requested quality (${quality || 'default'}) is not available for this video. Please try a different quality.`;
        } else if (stderr.includes('Video unavailable')) {
          errorMessage = 'This video is unavailable or has been removed.';
        } else if (stderr.includes('Private video')) {
          errorMessage = 'This video is private and cannot be downloaded.';
        } else if (stderr.includes('Sign in to confirm your age')) {
          errorMessage = 'This video requires age verification and cannot be downloaded.';
        }

        reject(new Error(errorMessage));
      }
    });

    ytdlpProcess.on('error', (error) => {
      console.error(`[DOWNLOAD-ONLY] Process error for ${videoId}:`, error);
      setDownloadProgress(videoId, 0, 'error');
      
      try {
        const { broadcastProgress } = require('../services/shared/progressWebSocket');
        broadcastProgress(videoId, 0, 'error', 'download');
      } catch (wsError) {
        // WebSocket module might not be initialized yet
      }
      
      reject(error);
    });

    // Set timeout to prevent hanging (increased due to cookie extraction time)
    setTimeout(() => {
      ytdlpProcess.kill();
      setDownloadProgress(videoId, 0, 'error');
      reject(new Error('Download timeout'));
    }, 600000); // 10 minute timeout
  });
}

module.exports = router;
