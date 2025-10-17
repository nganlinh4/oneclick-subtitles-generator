/**
 * API routes for media (video and audio) operations
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { spawn } = require('child_process');
const { VIDEOS_DIR, SERVER_URL } = require('../config');
const { downloadYouTubeVideo } = require('../services/youtube');
const { getDownloadProgress, setDownloadProgress } = require('../services/shared/progressTracker');
const { lockDownload, unlockDownload, isDownloadActive, getDownloadInfo } = require('../services/shared/globalDownloadManager');
const { normalizeVideo } = require('../services/video/universalVideoNormalizer');
const { cancelYtdlpProcess } = require('../services/youtube/ytdlpDownloader');
const { getFfmpegPath, getFfprobePath } = require('../services/shared/ffmpegUtils');
// Legacy video processing is deprecated
// const { splitVideoIntoSegments, splitMediaIntoSegments, optimizeVideo, createAnalysisVideo, convertAudioToVideo } = require('../services/videoProcessingService');

// Stub implementations for deprecated functions
const optimizeVideo = async (inputPath, outputPath, options) => {
  console.warn('optimizeVideo is deprecated and not implemented');
  return { success: true, path: outputPath, optimized: false };
};

const createAnalysisVideo = async (inputPath, outputPath) => {
  console.warn('createAnalysisVideo is deprecated and not implemented');
  return { success: true, path: outputPath, isOriginal: true, frameCount: 0 };
};

/**
 * Get video and audio metadata using ffprobe (JSON parsing for robustness)
 */
function getVideoDimensions(videoPath) {
  return new Promise((resolve, reject) => {
    const ffprobePath = getFfprobePath();
    const ff = spawn(ffprobePath, [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      videoPath
    ]);

    let out = '';
    let err = '';
    ff.stdout.on('data', d => { out += d.toString(); });
    ff.stderr.on('data', d => { err += d.toString(); });
    ff.on('close', (code) => {
      if (code !== 0) {
        console.error(`ffprobe error: ${err}`);
        return reject(new Error(`ffprobe failed with code ${code}: ${err}`));
      }
      let data;
      try {
        data = JSON.parse(out);
      } catch (e) {
        return reject(new Error('Failed to parse ffprobe JSON output'));
      }

      const streams = Array.isArray(data.streams) ? data.streams : [];
      const format = data.format || {};

      const vStream = streams.find(s => s.codec_type === 'video');
      if (!vStream || !Number.isFinite(parseInt(vStream.width)) || !Number.isFinite(parseInt(vStream.height))) {
        return reject(new Error('Invalid video dimensions'));
      }
      const widthNum = parseInt(vStream.width);
      const heightNum = parseInt(vStream.height);

      // FPS from avg_frame_rate or r_frame_rate
      let fps = null;
      const rate = vStream.avg_frame_rate || vStream.r_frame_rate;
      if (rate && rate.includes('/')) {
        const [num, den] = rate.split('/').map(n => parseFloat(n));
        if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) fps = Math.round((num / den) * 100) / 100;
      } else if (rate && Number.isFinite(parseFloat(rate))) {
        fps = Math.round(parseFloat(rate) * 100) / 100;
      }

      // Duration: prefer format.duration, fallback to stream.duration
      let duration = null;
      if (format.duration && Number.isFinite(parseFloat(format.duration))) duration = parseFloat(format.duration);
      else if (vStream.duration && Number.isFinite(parseFloat(vStream.duration))) duration = parseFloat(vStream.duration);

      // Bitrate (video stream)
      let vBitRate = null;
      if (vStream.bit_rate && Number.isFinite(parseInt(vStream.bit_rate))) vBitRate = parseInt(vStream.bit_rate);

      // Quality from height
      let quality = 'Unknown';
      let resolution = 'Unknown';
      if (heightNum >= 2160) { quality = '4K'; resolution = '4K'; }
      else if (heightNum >= 1440) { quality = '1440p'; resolution = '1440p'; }
      else if (heightNum >= 1080) { quality = '1080p'; resolution = '1080p'; }
      else if (heightNum >= 720) { quality = '720p'; resolution = '720p'; }
      else if (heightNum >= 480) { quality = '480p'; resolution = '480p'; }
      else if (heightNum >= 360) { quality = '360p'; resolution = '360p'; }
      else { quality = `${heightNum}p`; resolution = `${heightNum}p`; }

      // Audio stream
      const aStream = streams.find(s => s.codec_type === 'audio');
      const aCodec = aStream?.codec_name || null;
      const aChannels = aStream?.channels;
      const aSampleRate = aStream?.sample_rate ? parseInt(aStream.sample_rate) : null;
      const aLayout = aStream?.channel_layout || null;
      const aBitRate = aStream?.bit_rate ? parseInt(aStream.bit_rate) : null;

      resolve({
        width: widthNum,
        height: heightNum,
        duration,
        fps,
        codec: vStream.codec_name || null,
        bit_rate: vBitRate,
        quality,
        resolution,
        audio_codec: aCodec,
        audio_channels: Number.isFinite(parseInt(aChannels)) ? parseInt(aChannels) : null,
        audio_sample_rate: aSampleRate,
        audio_channel_layout: aLayout,
        audio_bit_rate: Number.isFinite(aBitRate) ? aBitRate : null
      });
    });

    setTimeout(() => {
      try { ff.kill(); } catch {}
      reject(new Error('ffprobe timeout'));
    }, 10000);
  });
}

// Configure multer for large file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, VIDEOS_DIR);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const originalName = file.originalname || 'uploaded-file';
    const extension = path.extname(originalName);
    const baseName = path.basename(originalName, extension);
    const filename = `large_upload_${timestamp}_${baseName}${extension}`;
    cb(null, filename);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024 // 5GB limit
  }
});

// Create a separate multer instance for streaming uploads (no file size limit for streaming)
const streamingStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, VIDEOS_DIR);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const originalName = file.originalname || 'uploaded-file';
    const extension = path.extname(originalName);
    const baseName = path.basename(originalName, extension);
    const filename = `streaming_upload_${timestamp}_${baseName}${extension}`;
    cb(null, filename);
  }
});

const streamingUpload = multer({
  storage: streamingStorage,
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024 // 5GB limit
  }
});

/**
 * Convert an audio file to a video file with a static image
 * @param {string} audioPath - Path to the audio file
 * @param {string} videoPath - Path to save the video file
 * @returns {Promise<Object>} - Video metadata
 */
function convertAudioToVideo(audioPath, videoPath) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();

    // Create a video with a static black background at 256x144 (144p) resolution
    // Using 15 fps for a smoother playback experience while keeping file size reasonable
    const ffmpeg = spawn(ffmpegPath, [
      '-i', audioPath,
      '-f', 'lavfi',
      '-i', 'color=c=black:s=256x144:r=15',
      '-shortest',
      '-c:v', 'libx264',
      '-tune', 'stillimage',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-y',
      videoPath
    ]);

    let errorOutput = '';

    ffmpeg.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code !== 0) {
        console.error(`[CONVERT-AUDIO] FFmpeg error: ${errorOutput}`);
        return reject(new Error(`FFmpeg failed with code ${code}`));
      }

      // Get the duration of the output video
      const ffprobePath = getFfprobePath();
      const ffprobe = spawn(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        videoPath
      ]);

      let durationOutput = '';

      ffprobe.stdout.on('data', (data) => {
        durationOutput += data.toString();
      });

      ffprobe.on('close', (probeCode) => {
        if (probeCode !== 0) {
          console.warn('[CONVERT-AUDIO] Could not get duration, using default');
          // Return without duration if ffprobe fails
          return resolve({
            width: 256,
            height: 144,
            fps: 15,
            duration: null
          });
        }

        const duration = parseFloat(durationOutput.trim());

        resolve({
          width: 256,
          height: 144,
          fps: 15,
          duration: isNaN(duration) ? null : duration
        });
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      ffmpeg.kill();
      reject(new Error('Audio to video conversion timeout'));
    }, 300000);
  });
}

/**
 * POST /api/copy-large-file - Copy a large file to the videos directory with progress tracking
 */
router.post('/copy-large-file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const filename = req.file.filename;

    // Normalize the video if needed (fix codec/stream issues)
    console.log('[UPLOAD] Checking video for compatibility issues...');
    const normalizationResult = await normalizeVideo(filePath);

    if (normalizationResult.normalized) {
      console.log(`[UPLOAD] Video normalized using ${normalizationResult.method}`);
    }

    // Return the file path for the client to reference
    res.json({
      success: true,
      filePath: `/videos/${filename}`,
      serverPath: filePath,
      size: req.file.size,
      normalized: normalizationResult.normalized,
      normalizationMethod: normalizationResult.method || null,
      message: normalizationResult.normalized ?
        'File uploaded and normalized successfully' :
        'Large file copied successfully'
    });
  } catch (error) {
    console.error('Error copying large file:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to copy large file',
      details: error.message
    });
  }
});

/**
 * GET /api/video-exists/:videoId - Check if a video exists
 */
router.get('/video-exists/:videoId', (req, res) => {
  const { videoId } = req.params;
  let videoPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);
  let filename = `${videoId}.mp4`;

  // If exact match doesn't exist, look for files starting with videoId
  if (!fs.existsSync(videoPath)) {
    const files = fs.readdirSync(VIDEOS_DIR);
    const matchingFile = files.find(file =>
      file.startsWith(`${videoId}_`) && file.endsWith('.mp4')
    );

    if (matchingFile) {
      videoPath = path.join(VIDEOS_DIR, matchingFile);
      filename = matchingFile;
    }
  }

  if (fs.existsSync(videoPath)) {
    const stats = fs.statSync(videoPath);
    res.json({
      exists: true,
      url: `/videos/${filename}`,
      size: stats.size,
      createdAt: stats.birthtime
    });
  } else {
    res.json({ exists: false });
  }
});

/**
 * GET /api/segment-exists/:segmentId - Check if a segment exists
 */
router.get('/segment-exists/:segmentId', (req, res) => {
  const { segmentId } = req.params;
  const segmentPath = path.join(VIDEOS_DIR, `${segmentId}.mp4`);

  if (fs.existsSync(segmentPath)) {
    const stats = fs.statSync(segmentPath);
    res.json({
      exists: true,
      url: `/videos/${segmentId}.mp4`,
      size: stats.size,
      createdAt: stats.birthtime
    });
  } else {
    res.json({ exists: false });
  }
});

/**
 * POST /api/download-video - Download a YouTube video
 */
router.post('/download-video', async (req, res) => {
  const { videoId, useCookies = false, forceRetry = false } = req.body;

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  // Check global download lock first
  if (isDownloadActive(videoId)) {
    const downloadInfo = getDownloadInfo(videoId);
    console.log(`[VIDEO-ROUTE] Download blocked: ${videoId} is already being downloaded by ${downloadInfo.route}`);

    // If forceRetry is true, clean up the stuck download and proceed
    if (forceRetry) {
      console.log(`[VIDEO-ROUTE] Force retry requested - cleaning up stuck download for ${videoId}`);
      unlockDownload(videoId, downloadInfo.route);
      // Clear any progress tracking
      const { clearDownloadProgress } = require('../services/shared/progressTracker');
      clearDownloadProgress(videoId);
      console.log(`[VIDEO-ROUTE] Cleaned up stuck download, proceeding with retry`);
    } else {
      return res.status(409).json({
        error: 'Video is already being downloaded',
        activeRoute: downloadInfo.route,
        videoId: videoId,
        canRetry: true
      });
    }
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

  // Acquire global download lock
  if (!lockDownload(videoId, 'video-route')) {
    return res.status(409).json({
      error: 'Failed to acquire download lock',
      videoId: videoId
    });
  }

  let lockReleased = false;
  try {
    // Download the video using JavaScript libraries with audio prioritized
    const result = await downloadYouTubeVideo(videoId, useCookies);

    // Check if download was cancelled
    if (result.cancelled) {
      // Release lock for cancelled downloads
      unlockDownload(videoId, 'video-route');
      lockReleased = true;
      console.log(`[VIDEO-ROUTE] Released download lock for cancelled download: ${videoId}`);

      return res.json({
        success: false,
        cancelled: true,
        message: result.message || 'Download was cancelled',
        url: null // Explicitly set url to null for cancelled downloads
      });
    }

    // Check if the file was created successfully
    if (fs.existsSync(videoPath)) {
      // Normalize the downloaded video if needed
      console.log('[DOWNLOAD] Checking downloaded video for compatibility issues...');
      const { setDownloadProgress } = require('../services/shared/progressTracker');

      // Update progress to show normalization is happening
      setDownloadProgress(videoId, 99, 'normalizing');

      const normalizationResult = await normalizeVideo(videoPath);

      if (normalizationResult.normalized) {
        console.log(`[DOWNLOAD] Video normalized using ${normalizationResult.method}`);

        // Add a small delay to ensure file is fully written and handles are released
        await new Promise(resolve => setTimeout(resolve, 500));

        // Verify the file is accessible and not corrupted
        try {
          const stats = fs.statSync(videoPath);
          if (stats.size < 100 * 1024) { // Less than 100KB
            throw new Error(`Video file is too small (${stats.size} bytes)`);
          }
          console.log(`[DOWNLOAD] Verified normalized video: ${Math.round(stats.size / 1024 / 1024 * 100) / 100} MB`);
        } catch (verifyError) {
          console.error('[DOWNLOAD] File verification failed:', verifyError);
          throw new Error('Video file verification failed after normalization');
        }
      }

      // NOW set progress to 100% after everything is done
      setDownloadProgress(videoId, 100, 'completed');

      // Release the lock AFTER normalization completes and file is verified
      unlockDownload(videoId, 'video-route');
      lockReleased = true;
      console.log(`[VIDEO-ROUTE] Released download lock for ${videoId}`);

      return res.json({
        success: true,
        message: normalizationResult.normalized ?
          'Video downloaded and normalized successfully' :
          (result.message || 'Video downloaded successfully'),
        url: `/videos/${videoId}.mp4`,
        normalized: normalizationResult.normalized,
        normalizationMethod: normalizationResult.method || null
      });
    } else {
      throw new Error('Download completed but video file was not found');
    }
  } catch (error) {
    console.error('Error downloading video:', error);

    // Clean up any partial file
    try {
      if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
        console.log(`[VIDEO-ROUTE] Cleaned up partial file: ${videoPath}`);
      }
    } catch (e) {
      console.error('Error cleaning up incomplete file:', e);
    }

    // Clear progress tracking
    const { clearDownloadProgress } = require('../services/shared/progressTracker');
    clearDownloadProgress(videoId);

    // Provide more user-friendly error message with retry option
    let errorMessage = 'Failed to download video';
    let canRetry = true;

    if (error.message.includes('Video unavailable')) {
      errorMessage = 'This video is unavailable or has been removed.';
      canRetry = false;
    } else if (error.message.includes('Private video')) {
      errorMessage = 'This video is private and cannot be downloaded.';
      canRetry = false;
    } else if (error.message.includes('Sign in to confirm')) {
      errorMessage = 'This video requires age verification and cannot be downloaded.';
      canRetry = false;
    }

    // Release lock on error (if not already released)
    if (!lockReleased) {
      unlockDownload(videoId, 'video-route');
      console.log(`[VIDEO-ROUTE] Released download lock for ${videoId} due to error`);
    }

    return res.status(500).json({
      error: errorMessage,
      details: error.message,
      videoId: videoId,
      canRetry: canRetry
    });
  }
});

/**
 * GET /api/download-progress/:videoId - Get download progress for a video
 */
router.get('/download-progress/:videoId', (req, res) => {
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
    console.error('Error getting download progress:', error);
    res.status(500).json({
      error: 'Failed to get download progress',
      details: error.message
    });
  }
});

/**
 * POST /api/cancel-download/:videoId - Cancel an ongoing video download
 */
router.post('/cancel-download/:videoId', (req, res) => {
  const { videoId } = req.params;

  if (!videoId) {
    return res.status(400).json({
      success: false,
      error: 'Video ID is required'
    });
  }

  try {
    // Try to kill the yt-dlp process
    const processKilled = cancelYtdlpProcess(videoId);

    // Release global download lock
    unlockDownload(videoId, 'video-route');

    // Update progress to cancelled
    setDownloadProgress(videoId, 0, 'cancelled');

    // Broadcast cancellation
    try {
      const { broadcastProgress } = require('../services/shared/progressWebSocket');
      broadcastProgress(videoId, 0, 'cancelled');
    } catch (error) {
      // WebSocket module might not be initialized yet
    }

    res.json({
      success: true,
      message: processKilled ?
        `Download cancelled and process killed for ${videoId}` :
        `Download cancellation requested for ${videoId} (no active process found)`
    });
  } catch (error) {
    console.error('[VIDEO-ROUTE] Error cancelling download:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel download'
    });
  }
});

/**
 * GET /api/video-dimensions/:videoId - Get video dimensions and quality
 */
router.get('/video-dimensions/:videoId', async (req, res) => {
  const { videoId } = req.params;


  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
  }

  try {
    // Look for video file with pattern matching (handles files with titles)
    let videoPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

    // If exact match doesn't exist, look for files starting with videoId
    if (!fs.existsSync(videoPath)) {
      const files = fs.readdirSync(VIDEOS_DIR);

      const matchingFile = files.find(file =>
        file.startsWith(`${videoId}_`) && file.endsWith('.mp4')
      );

      if (matchingFile) {
        videoPath = path.join(VIDEOS_DIR, matchingFile);
      } else {
        // Try to find files that contain the videoId (more flexible matching)
        const flexibleMatch = files.find(file =>
          file.includes(videoId) && file.endsWith('.mp4')
        );

        if (flexibleMatch) {
          videoPath = path.join(VIDEOS_DIR, flexibleMatch);
        }
      }
    }


    if (!fs.existsSync(videoPath)) {
      return res.status(404).json({
        success: false,
        error: 'Video file not found'
      });
    }

    const dimensions = await getVideoDimensions(videoPath);


    res.json({
      success: true,
      videoId: videoId,
      width: dimensions.width,
      height: dimensions.height,
      quality: dimensions.quality,
      resolution: dimensions.resolution,
      dimensions: `${dimensions.width}x${dimensions.height}`,
      fps: dimensions.fps ?? null,
      codec: dimensions.codec || null,
      bit_rate: dimensions.bit_rate ?? null,
      audio_codec: dimensions.audio_codec || null,
      audio_channels: dimensions.audio_channels ?? null,
      audio_sample_rate: dimensions.audio_sample_rate ?? null,
      audio_channel_layout: dimensions.audio_channel_layout || null,
      audio_bit_rate: dimensions.audio_bit_rate ?? null
    });
  } catch (error) {
    console.error('Error getting video dimensions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get video dimensions',
      details: error.message
    });
  }
});

/**
 * GET /api/probe-media?url=... - Probe arbitrary HTTP(S) media with ffprobe
 */
router.get('/probe-media', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url || !(typeof url === 'string') || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ success: false, error: 'Invalid or missing url parameter' });
    }

    // no-op log removed

    const meta = await getVideoDimensions(url);

    res.json({
      success: true,
      url,
      width: meta.width,
      height: meta.height,
      quality: meta.quality,
      resolution: meta.resolution,
      dimensions: `${meta.width}x${meta.height}`,
      fps: meta.fps ?? null,
      codec: meta.codec || null,
      bit_rate: meta.bit_rate ?? null,
      audio_codec: meta.audio_codec || null,
      audio_channels: meta.audio_channels ?? null,
      audio_sample_rate: meta.audio_sample_rate ?? null,
      audio_channel_layout: meta.audio_channel_layout || null,
      audio_bit_rate: meta.audio_bit_rate ?? null
    });
  } catch (error) {
    console.error('[PROBE-MEDIA] Error:', error);
    res.status(500).json({ success: false, error: 'Failed to probe media', details: error.message });
  }
});

/**
 * POST /api/split-existing-file - Split a file that already exists on the server
 * @deprecated This endpoint is deprecated. Use simplified processing instead.
 */
router.post('/split-existing-file', async (req, res) => {
  res.status(410).json({
    error: 'Video splitting is deprecated. Please enable "Use Simplified Processing" in settings for better performance.',
    deprecated: true
  });
});

/**
 * POST /api/upload-and-split-video - Upload and split a media file (video or audio) using streaming
 * @deprecated This endpoint is deprecated. Use simplified processing instead.
 */
router.post('/upload-and-split-video', streamingUpload.single('file'), async (req, res) => {
  res.status(410).json({
    error: 'Video splitting is deprecated. Please enable "Use Simplified Processing" in settings for better performance.',
    deprecated: true
  });
});

/**

    // Optimize videos only if requested (not audio files)
    if (!isAudio && optimizeVideos) {
      try {

        const optimizedFilename = `optimized_${timestamp}.mp4`;
        const optimizedPath = path.join(VIDEOS_DIR, optimizedFilename);

        optimizedResult = await optimizeVideo(processPath, optimizedPath, {
          resolution: optimizedResolution,
          fps: 1 // Gemini only processes 1 FPS
        });

        // Use the optimized video for splitting
        processPath = optimizedPath;

      } catch (error) {
        console.error('Error optimizing video:', error);

      }
    }

    // Split the media file into segments
    const result = await splitMediaIntoSegments(
      processPath,
      segmentDuration,
      VIDEOS_DIR,
      `segment_${timestamp}`,
      {
        fastSplit,
        mediaType
      }
    );

    // Return the list of segment files
    res.json({
      success: true,
      originalMedia: `/videos/${filename}`,
      mediaType: mediaType,
      batchId: result.batchId,
      segments: result.segments.map(segment => `/videos/${path.basename(segment.path)}`),
      message: `${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} uploaded and split successfully`,
      // Include optimized video information if available and actually optimized
      optimized: optimizedResult ? {
        video: `/videos/${path.basename(optimizedResult.path)}`,
        resolution: optimizedResult.resolution,
        fps: optimizedResult.fps,
        width: optimizedResult.width,
        height: optimizedResult.height,
        wasOptimized: optimizedResult.optimized !== false
      } : null
    });
  } catch (error) {
    const errorMediaType = req.headers['content-type']?.startsWith('audio/') ? 'audio' : 'video';
    console.error(`Error processing ${errorMediaType} upload:`, error);
    res.status(500).json({
      success: false,
      error: error.message || `Failed to process ${errorMediaType}`
    });
  }
});

/**
 * POST /api/split-video - Split a media file (video or audio) into segments using streaming
 * @deprecated This endpoint is deprecated. Use simplified processing instead.
 */
router.post('/split-video', streamingUpload.single('file'), async (req, res) => {
  res.status(410).json({
    error: 'Video splitting is deprecated. Please enable "Use Simplified Processing" in settings for better performance.',
    deprecated: true
  });
});

/**



    // Get segment duration from query params or use default (10 minutes = 600 seconds)
    const segmentDuration = parseInt(req.query.segmentDuration || '600');
    const fastSplit = req.query.fastSplit === 'true';
    // Parse optimizeVideos parameter - default to false to avoid duplication
    // Check explicitly for 'true' string to ensure we don't optimize unless explicitly requested
    const optimizeVideos = req.query.optimizeVideos === 'true';

    const optimizedResolution = req.query.optimizedResolution || '360p';

    let processPath = mediaPath;
    let optimizedResult = null;

    // Optimize videos only if requested (not audio files)
    if (!isAudio && optimizeVideos) {
      try {


        // Ensure we don't have double extensions in the optimized filename
        const cleanMediaId = mediaId.replace(/\.(mp[34]|webm|mov|avi|wmv|flv|mkv)$/i, '');
        const optimizedFilename = `optimized_${cleanMediaId}.mp4`;
        const optimizedPath = path.join(VIDEOS_DIR, optimizedFilename);


        optimizedResult = await optimizeVideo(processPath, optimizedPath, {
          resolution: optimizedResolution,
          fps: 1 // Gemini only processes 1 FPS
        });

        // Double-check that the optimization was successful
        if (!optimizedResult) {
          console.error(`[SPLIT-VIDEO] Optimization failed: optimizedResult is null or undefined`);
          throw new Error('Video optimization failed');
        }

        // Only use the optimized video if it actually exists
        if (fs.existsSync(optimizedPath)) {
          processPath = optimizedPath;

        } else {

          // Keep using the original video path
        }
      } catch (error) {
        console.error('[SPLIT-VIDEO] Error optimizing video:', error);

      }
    }

    // Split the media file into segments
    const result = await splitMediaIntoSegments(
      processPath,
      segmentDuration,
      VIDEOS_DIR,
      `${mediaId}_part`,
      {
        fastSplit,
        mediaType
      }
    );

    // Return the list of segment files with actual durations
    res.json({
      success: true,
      originalMedia: `/videos/${filename}`,
      mediaId: mediaId,
      mediaType: mediaType,
      segments: result.segments.map(segment => ({
        path: `/videos/${path.basename(segment.path)}`,
        // Include actual duration and start time in the URL as query parameters
        url: `${SERVER_URL}/videos/${path.basename(segment.path)}?startTime=${segment.startTime}&duration=${segment.duration}`,
        name: path.basename(segment.path),
        // Include actual duration and start time in the segment object
        startTime: segment.startTime,
        duration: segment.duration,
        // Include theoretical values for reference
        theoreticalStartTime: segment.theoreticalStartTime,
        theoreticalDuration: segment.theoreticalDuration
      })),
      message: `${mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} split successfully`,
      // Include optimized video information if available and actually optimized
      optimized: optimizedResult ? {
        video: `/videos/${path.basename(optimizedResult.path)}`,
        resolution: optimizedResult.resolution,
        fps: optimizedResult.fps,
        width: optimizedResult.width,
        height: optimizedResult.height,
        wasOptimized: optimizedResult.optimized !== false
      } : null
    });
  } catch (error) {
    const errorMediaType = req.headers['content-type']?.startsWith('audio/') ? 'audio' : 'video';
    console.error(`[SPLIT-VIDEO] Error splitting ${errorMediaType}:`, error);
    res.status(500).json({
      success: false,
      error: error.message || `Failed to split ${errorMediaType}`
    });
  }
});

/**
 * POST /api/optimize-existing-file - Optimize a file that already exists on the server
 */
router.post('/optimize-existing-file', async (req, res) => {
  try {
    const { filename, resolution = '360p', fps = 1, useVideoAnalysis = true } = req.body;

    if (!filename) {
      return res.status(400).json({ error: 'Filename is required' });
    }

    const filePath = path.join(VIDEOS_DIR, filename);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    console.log(`[OPTIMIZE-EXISTING] Optimizing existing file: ${filename}`);

    // Determine media type from file extension
    const extension = path.extname(filename).toLowerCase();
    const isAudio = ['.mp3', '.wav', '.aac', '.ogg', '.flac'].includes(extension);

    // Generate timestamp for optimized files
    const timestamp = Date.now();

    // Always use mp4 for processed files
    const optimizedFilename = `optimized_${timestamp}.mp4`;
    const analysisFilename = `analysis_500frames_${timestamp}.mp4`;
    const optimizedPath = path.join(VIDEOS_DIR, optimizedFilename);
    const analysisPath = path.join(VIDEOS_DIR, analysisFilename);

    let videoPath = filePath;
    let optimizedResult = null;
    let analysisResult = null;

    // If it's an audio file, convert it to video first
    if (isAudio) {
      const convertedFilename = `converted_${timestamp}.mp4`;
      const convertedPath = path.join(VIDEOS_DIR, convertedFilename);

      const conversionResult = await convertAudioToVideo(filePath, convertedPath);
      if (conversionResult && fs.existsSync(convertedPath)) {
        videoPath = convertedPath;
      }
    }

    // Optimize the video
    optimizedResult = await optimizeVideo(videoPath, optimizedPath, {
      resolution: resolution,
      fps: fps
    });

    if (!optimizedResult) {
      throw new Error('Video optimization failed');
    }

    // Create analysis video if requested and optimization was successful
    if (useVideoAnalysis && optimizedResult && fs.existsSync(optimizedPath)) {
      try {
        analysisResult = await createAnalysisVideo(optimizedPath, analysisPath);
      } catch (error) {
        console.warn(`[OPTIMIZE-EXISTING] Analysis video creation failed: ${error.message}`);
        // Continue without analysis video
      }
    }

    // Return the result
    res.json({
      success: true,
      originalVideo: `/videos/${filename}`,
      optimizedVideo: `/videos/${optimizedFilename}`,
      resolution: optimizedResult.resolution,
      fps: optimizedResult.fps,
      width: optimizedResult.width,
      height: optimizedResult.height,
      wasOptimized: optimizedResult.optimized !== false,
      analysis: analysisResult ? (analysisResult.isOriginal ? {
        // If the video has fewer than 500 frames, we use the optimized video
        video: `/videos/${optimizedFilename}`,
        frameCount: analysisResult.frameCount,
        duration: analysisResult.duration,
        message: 'Using optimized video for analysis (fewer than 500 frames)'
      } : {
        video: `/videos/${analysisFilename}`,
        frameCount: analysisResult.frameCount,
        duration: analysisResult.duration,
        originalFrameCount: analysisResult.originalFrameCount,
        frameInterval: analysisResult.frameInterval,
        message: `Created 500-frame analysis video from ${analysisResult.originalFrameCount} original frames`
      }) : null,
      message: 'Video optimized successfully from existing file'
    });
  } catch (error) {
    console.error('[OPTIMIZE-EXISTING] Error optimizing existing file:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to optimize existing file'
    });
  }
});

/**
 * POST /api/create-analysis-video - Create a 500-frame analysis video without optimization
 */
router.post('/create-analysis-video', streamingUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const timestamp = Date.now();
    const originalPath = req.file.path;
    const originalFilename = req.file.filename;

    // Create analysis video filename
    const analysisFilename = `analysis_${timestamp}.mp4`;
    const analysisPath = path.join(VIDEOS_DIR, analysisFilename);

    console.log('[CREATE-ANALYSIS-VIDEO] Creating analysis video from:', originalPath);

    // Create analysis video with 500 frames
    const analysisResult = await createAnalysisVideo(originalPath, analysisPath);

    if (analysisResult.isOriginal) {
      console.log('[CREATE-ANALYSIS-VIDEO] Using original video for analysis (fewer than 500 frames)');
    } else {
      console.log(`[CREATE-ANALYSIS-VIDEO] Created analysis video with ${analysisResult.frameCount} frames from ${analysisResult.originalFrameCount} original frames`);
    }

    // Return the result
    res.json({
      success: true,
      originalVideo: `/videos/${originalFilename}`,
      analysis: analysisResult.isOriginal ? {
        video: `/videos/${originalFilename}`,
        frameCount: analysisResult.frameCount,
        message: 'Using original video for analysis (fewer than 500 frames)'
      } : {
        video: `/videos/${analysisFilename}`,
        frameCount: analysisResult.frameCount,
        originalFrameCount: analysisResult.originalFrameCount,
        frameInterval: analysisResult.frameInterval,
        message: `Created 500-frame analysis video from ${analysisResult.originalFrameCount} original frames`
      }
    });

  } catch (error) {
    console.error('[CREATE-ANALYSIS-VIDEO] Error:', error);
    res.status(500).json({
      error: 'Failed to create analysis video',
      details: error.message
    });
  }
});

/**
 * POST /api/optimize-video - Optimize a video by scaling it to a lower resolution and reducing the frame rate using streaming
 * @deprecated This endpoint is deprecated. Use simplified processing instead.
 */
router.post('/optimize-video', streamingUpload.single('file'), async (req, res) => {
  res.status(410).json({
    error: 'Video optimization is deprecated. Please enable "Use Simplified Processing" in settings for better performance.',
    deprecated: true
  });
});

/**
    const optimizedFilename = `optimized_${timestamp}.mp4`;
    const analysisFilename = `analysis_500frames_${timestamp}.mp4`;
    const optimizedPath = path.join(VIDEOS_DIR, optimizedFilename);
    const analysisPath = path.join(VIDEOS_DIR, analysisFilename);

    // File is already saved to disk by multer streaming



    // If it's an audio file, convert it to video first
    let videoPath = originalPath;

    if (isAudio) {
      try {

        const videoFilename = `converted_${timestamp}.mp4`;
        videoPath = path.join(VIDEOS_DIR, videoFilename);

        await convertAudioToVideo(originalPath, videoPath);

      } catch (error) {
        console.error('[OPTIMIZE-VIDEO] Error converting audio to video:', error);
        return res.status(500).json({
          success: false,
          error: 'Failed to convert audio to video'
        });
      }
    }

    // Optimize the video


    const result = await optimizeVideo(videoPath, optimizedPath, {
      resolution,
      fps
    });

    // Determine which video to use for analysis (optimized or original)
    const wasOptimized = result.optimized !== false;
    const videoForAnalysis = wasOptimized ? optimizedPath : videoPath;

    // Create an analysis video with 500 frames only if video analysis is enabled
    let analysisResult = null;
    if (useVideoAnalysis) {
      analysisResult = await createAnalysisVideo(videoForAnalysis, analysisPath);

      if (analysisResult.isOriginal) {
        console.log('[OPTIMIZE-VIDEO] Using optimized video for analysis (fewer than 500 frames)');
      } else {
        console.log(`[OPTIMIZE-VIDEO] Created analysis video with ${analysisResult.frameCount} frames from ${analysisResult.originalFrameCount} original frames`);
      }
    } else {
      console.log('[OPTIMIZE-VIDEO] Video analysis disabled, skipping analysis video creation');
    }

    // Return the optimized and analysis video information
    // Use the optimized video path based on whether optimization was performed
    const optimizedVideoPath = wasOptimized ? `/videos/${optimizedFilename}` : `/videos/${originalFilename}`;

    res.json({
      success: true,
      originalMedia: `/videos/${originalFilename}`,
      // Report the original media type to the client
      mediaType: isAudio ? 'audio' : 'video',
      optimizedVideo: optimizedVideoPath,
      resolution: result.resolution,
      fps: result.fps,
      width: result.width,
      height: result.height,
      duration: result.duration,
      message: wasOptimized
        ? `${isAudio ? 'Audio' : 'Video'} optimized successfully to ${result.resolution} at ${result.fps}fps`
        : `${isAudio ? 'Audio' : 'Video'} resolution (${result.width}x${result.height}) is already ${result.height}p or lower. No optimization needed.`,
      // Include analysis video information only if analysis was performed
      analysis: analysisResult ? (analysisResult.isOriginal ? {
        // If the video has fewer than 500 frames, we use the optimized video (or original if not optimized)
        video: optimizedVideoPath,
        frameCount: analysisResult.frameCount,
        message: 'Using video for analysis (fewer than 500 frames)'
      } : {
        video: `/videos/${analysisFilename}`,
        frameCount: analysisResult.frameCount,
        originalFrameCount: analysisResult.originalFrameCount,
        frameInterval: analysisResult.frameInterval,
        message: `Created 500-frame analysis video from ${analysisResult.originalFrameCount} original frames`
      }) : null
    });
  } catch (error) {
    const errorMediaType = req.headers['content-type']?.startsWith('audio/') ? 'audio' : 'video';
    console.error(`[OPTIMIZE-VIDEO] Error optimizing ${errorMediaType}:`, error);
    res.status(500).json({
      success: false,
      error: error.message || `Failed to optimize ${errorMediaType}`
    });
  }
});

/**
 * POST /api/extract-audio - Extract audio from a video file path
 */
router.post('/extract-audio', async (req, res) => {
  try {
    const { videoPath } = req.body;
    // Get filename from query parameter or body
    const filename = req.query.filename || req.body.filename || 'audio';

    if (!videoPath) {
      return res.status(400).json({ error: 'Video path is required' });
    }

    // Determine if the path is a URL or a local path
    const isUrl = videoPath.startsWith('http');

    // Skip blob URLs - they should use the /extract-audio-from-blob endpoint
    if (videoPath.startsWith('blob:')) {
      return res.status(400).json({ error: 'Blob URLs are not supported by this endpoint. Use /extract-audio-from-blob instead.' });
    }

    // Resolve the actual file path
    let actualVideoPath;



    if (isUrl) {
      // Extract the filename from the URL
      const urlParts = videoPath.split('/');
      const filename = urlParts[urlParts.length - 1];
      actualVideoPath = path.join(VIDEOS_DIR, filename);

    } else {
      // If it's a relative path like /videos/filename.mp4
      const relativePath = videoPath.startsWith('/') ? videoPath.substring(1) : videoPath;
      const pathParts = relativePath.split('/');
      const filename = pathParts[pathParts.length - 1];
      actualVideoPath = path.join(VIDEOS_DIR, filename);

    }

    // If the file doesn't exist, try to extract the filename from the path and look for it directly
    if (!fs.existsSync(actualVideoPath)) {


      // Try to get just the filename without query parameters
      const filenameWithoutQuery = videoPath.split('?')[0].split('/').pop();
      const alternativePath = path.join(VIDEOS_DIR, filenameWithoutQuery);


      if (fs.existsSync(alternativePath)) {
        actualVideoPath = alternativePath;

      } else {
        // List all files in the videos directory to help with debugging

        const files = fs.readdirSync(VIDEOS_DIR);

      }
    }

    // Check if the video file exists
    if (!fs.existsSync(actualVideoPath)) {
      return res.status(404).json({ error: 'Video file not found' });
    }

    // Generate a unique filename for the audio
    const timestamp = Date.now();
    const audioFilename = `audio_${timestamp}.mp3`;
    const audioPath = path.join(VIDEOS_DIR, audioFilename);

    // Use ffmpeg to extract audio
    const { spawn } = require('child_process');
    const ffmpegProcess = spawn(getFfmpegPath(), [
      '-i', actualVideoPath,
      '-vn',  // No video
      '-acodec', 'libmp3lame',  // MP3 codec
      '-q:a', '2',  // Quality (0-9, lower is better)
      '-y',  // Overwrite output file
      audioPath
    ]);

    // Handle process completion
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        // Success


        // Set the Content-Disposition header to force download with the provided filename
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.mp3"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Stream the file directly instead of returning a URL
        const fileStream = fs.createReadStream(audioPath);
        fileStream.pipe(res);
      } else {
        // Error
        console.error(`Error extracting audio: ffmpeg process exited with code ${code}`);
        res.status(500).json({
          success: false,
          error: 'Failed to extract audio'
        });
      }
    });

    // Handle process error
    ffmpegProcess.on('error', (err) => {
      console.error('Error spawning ffmpeg process:', err);
      res.status(500).json({
        success: false,
        error: 'Failed to start audio extraction process'
      });
    });
  } catch (error) {
    console.error('Error extracting audio:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to extract audio'
    });
  }
});

/**
 * POST /api/extract-audio-from-blob - Extract audio from a video file using streaming
 * This endpoint accepts the actual video data as a file upload
 */
router.post('/extract-audio-from-blob', streamingUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Get filename from query parameter
    const filename = req.query.filename || 'audio';

    // File is already saved to disk by multer streaming
    const videoPath = req.file.path;

    // Generate unique filename for the output audio
    const timestamp = Date.now();
    const audioFilename = `audio_${timestamp}.mp3`;
    const audioPath = path.join(VIDEOS_DIR, audioFilename);


    // Use ffmpeg to extract audio
    const { spawn } = require('child_process');
    const ffmpegProcess = spawn(getFfmpegPath(), [
      '-i', videoPath,
      '-vn',  // No video
      '-acodec', 'libmp3lame',  // MP3 codec
      '-q:a', '2',  // Quality (0-9, lower is better)
      '-y',  // Overwrite output file
      audioPath
    ]);

    // Handle process completion
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        // Success


        // Clean up the temporary video file
        try {
          fs.unlinkSync(videoPath);

        } catch (err) {
          console.error(`Error deleting temporary video file: ${err.message}`);
        }

        // Set the Content-Disposition header to force download with the provided filename
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.mp3"`);
        res.setHeader('Content-Type', 'audio/mpeg');

        // Stream the file directly instead of returning a URL
        const fileStream = fs.createReadStream(audioPath);
        fileStream.pipe(res);
      } else {
        // Error
        console.error(`Error extracting audio: ffmpeg process exited with code ${code}`);

        // Clean up the temporary video file
        try {
          fs.unlinkSync(videoPath);

        } catch (err) {
          console.error(`Error deleting temporary video file: ${err.message}`);
        }

        res.status(500).json({
          success: false,
          error: 'Failed to extract audio'
        });
      }
    });

    // Handle process error
    ffmpegProcess.on('error', (err) => {
      console.error('Error spawning ffmpeg process:', err);

      // Clean up the temporary video file
      try {
        fs.unlinkSync(videoPath);

      } catch (deleteErr) {
        console.error(`Error deleting temporary video file: ${deleteErr.message}`);
      }

      res.status(500).json({
        success: false,
        error: 'Failed to start audio extraction process'
      });
    });
  } catch (error) {
    console.error('Error extracting audio from blob:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to extract audio from blob'
    });
  }
});

/**
 * GET /api/converted-audio-exists/:audioHash - Check if a converted audio file exists
 */
router.get('/converted-audio-exists/:audioHash', (req, res) => {
  const { audioHash } = req.params;

  // Look for any files that match the pattern converted_<audioHash>_*.mp4
  const files = fs.readdirSync(VIDEOS_DIR);
  const convertedFile = files.find(file => file.startsWith(`converted_${audioHash}_`) && file.endsWith('.mp4'));

  if (convertedFile) {
    const videoPath = path.join(VIDEOS_DIR, convertedFile);
    const stats = fs.statSync(videoPath);

    // Get video metadata using ffprobe (using implementation from narration controller)
    const { getMediaDuration } = require('../controllers/narration/audioFile/batchProcessor');

    // Get the duration asynchronously and then respond
    getMediaDuration(videoPath)
      .then(duration => {
        res.json({
          exists: true,
          video: `/videos/${convertedFile}`,
          width: 256,  // Default values for converted audio files
          height: 144,
          fps: 15,
          duration: duration,
          resolution: '144p',
          size: stats.size,
          createdAt: stats.birthtime
        });
      })
      .catch(error => {
        console.error(`[CONVERTED-AUDIO-EXISTS] Error getting duration for ${videoPath}:`, error);
        // Still return that the file exists, just without duration
        res.json({
          exists: true,
          video: `/videos/${convertedFile}`,
          width: 256,
          height: 144,
          fps: 15,
          resolution: '144p',
          size: stats.size,
          createdAt: stats.birthtime
        });
      });
  } else {
    res.json({ exists: false });
  }
});

/**
 * POST /api/convert-audio-to-video - Convert an audio file to a video file using streaming
 */
router.post('/convert-audio-to-video', streamingUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // File is already saved to disk by multer streaming
    const audioPath = req.file.path;
    const contentType = req.file.mimetype || 'audio/mp3';

    // Generate a unique filename for the video file
    const timestamp = Date.now();
    const fileExtension = contentType.split('/')[1] || 'mp3';

    // Generate a hash of the audio file for caching purposes
    const crypto = require('crypto');
    const audioBuffer = fs.readFileSync(audioPath);
    const audioHash = crypto.createHash('md5').update(audioBuffer).digest('hex').substring(0, 10);

    // Check if we already have a converted file for this audio
    const files = fs.readdirSync(VIDEOS_DIR);
    const existingConvertedFile = files.find(file => file.startsWith(`converted_${audioHash}_`) && file.endsWith('.mp4'));

    if (existingConvertedFile) {

      const videoPath = path.join(VIDEOS_DIR, existingConvertedFile);

      try {
        // Get video metadata (using implementation from narration controller)
        const { getMediaDuration } = require('../controllers/narration/audioFile/batchProcessor');
        const duration = await getMediaDuration(videoPath);

        // Return the existing converted file
        return res.json({
          success: true,
          video: `/videos/${existingConvertedFile}`,
          width: 256,
          height: 144,
          fps: 15,
          duration: duration,
          resolution: '144p',
          message: 'Using cached converted video',
          cached: true
        });
      } catch (error) {
        console.error(`[CONVERT-AUDIO] Error getting metadata for existing converted file: ${error.message}`);
        // Continue with new conversion as fallback
      }
    }

    const videoFilename = `converted_${audioHash}_${timestamp}.mp4`;
    const videoPath = path.join(VIDEOS_DIR, videoFilename);

    // Audio file is already saved to disk by multer streaming at audioPath



    // Convert the audio to video

    const result = await convertAudioToVideo(audioPath, videoPath);


    // Delete the original audio file - we don't need it anymore
    try {
      fs.unlinkSync(audioPath);

    } catch (deleteError) {
      console.error(`[CONVERT-AUDIO] Error deleting audio file: ${deleteError.message}`);
    }

    // Return the path to the video file
    res.json({
      success: true,
      video: `/videos/${videoFilename}`,
      width: result.width,
      height: result.height,
      fps: result.fps,
      duration: result.duration,
      resolution: '144p',  // Explicitly set resolution to 144p
      message: 'Audio converted to video successfully'
    });
  } catch (error) {
    console.error('[CONVERT-AUDIO] Error converting audio to video:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to convert audio to video'
    });
  }
});


/**
 * POST /api/extract-video-segment - Extract a segment using ffmpeg with stream copy
 */
router.post('/extract-video-segment', streamingUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const start = parseFloat(req.query.start || req.body.start);
    const end = parseFloat(req.query.end || req.body.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return res.status(400).json({ success: false, error: 'Invalid start/end range' });
    }

    const duration = end - start;
    const ffmpegPath = getFfmpegPath();
    const timestamp = Date.now();
    const outName = `extracted_${timestamp}.mp4`;
    const outPath = path.join(VIDEOS_DIR, outName);

    console.log(`[EXTRACT] Cutting segment ${start}s-${end}s from ${req.file.path} -> ${outPath}`);

    const ff = spawn(ffmpegPath, [
      '-ss', String(start),
      '-i', req.file.path,
      '-t', String(duration),
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y',
      outPath
    ]);

    let err = '';
    ff.stderr.on('data', d => { err += d.toString(); });
    ff.on('close', (code) => {
      try { fs.unlinkSync(req.file.path); } catch {}
      if (code !== 0) {
        console.error('[EXTRACT] ffmpeg failed:', err);
        return res.status(500).json({ success: false, error: 'FFmpeg failed to extract segment' });
      }
      return res.json({ success: true, url: `/videos/${outName}` });
    });
  } catch (e) {
    console.error('[EXTRACT] Error extracting video segment:', e);
    res.status(500).json({ success: false, error: e.message || 'Failed to extract video segment' });
  }
});

/**
 * POST /api/delete-videos - Delete cached video files by URL list
 */
router.post('/delete-videos', async (req, res) => {
  try {
    const urls = (req.body && req.body.urls) || [];
    if (!Array.isArray(urls)) {
      return res.status(400).json({ success: false, error: 'urls must be an array' });
    }
    let deleted = 0;
    let errors = [];
    for (const url of urls) {
      try {
        if (!url) continue;
        // Extract filename (supports absolute or relative)
        const filename = url.split('?')[0].split('/').pop();
        if (!filename) continue;
        const filePath = path.join(VIDEOS_DIR, filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch (e) {
        errors.push({ url, message: e.message });
      }
    }
    res.json({ success: true, deleted, errors });
  } catch (e) {
    console.error('[DELETE-VIDEOS] Error deleting videos:', e);
    res.status(500).json({ success: false, error: e.message || 'Failed to delete videos' });
  }
});


module.exports = router;
