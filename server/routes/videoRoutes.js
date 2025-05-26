/**
 * API routes for media (video and audio) operations
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { VIDEOS_DIR, SERVER_URL } = require('../config');
const { downloadYouTubeVideo } = require('../services/youtube');
// No direct need for WebSocket here, but it's related to the system
const {
  splitVideoIntoSegments,
  splitMediaIntoSegments,
  optimizeVideo,
  createAnalysisVideo,
  convertAudioToVideo
} = require('../services/videoProcessingService');

/**
 * GET /api/video-exists/:videoId - Check if a video exists
 */
router.get('/video-exists/:videoId', (req, res) => {
  const { videoId } = req.params;
  const videoPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

  if (fs.existsSync(videoPath)) {
    const stats = fs.statSync(videoPath);
    res.json({
      exists: true,
      url: `/videos/${videoId}.mp4`,
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
  const { videoId } = req.body;
  const videoSocketMap = req.app.get('videoSocketMap'); // Retrieve videoSocketMap

  if (!videoId) {
    return res.status(400).json({ error: 'Video ID is required' });
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
    // Download the video using JavaScript libraries with audio prioritized
    // Pass videoSocketMap to downloadYouTubeVideo
    const result = await downloadYouTubeVideo(videoId, videoSocketMap);

    // Check if the file was created successfully
    if (fs.existsSync(videoPath)) {

      return res.json({
        success: true,
        message: result.message || 'Video downloaded successfully',
        url: `/videos/${videoId}.mp4`
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
      }
    } catch (e) {
      console.error('Error cleaning up incomplete file:', e);
    }

    return res.status(500).json({
      error: 'Failed to download video',
      details: error.message
    });
  }
});

/**
 * POST /api/upload-and-split-video - Upload and split a media file (video or audio)
 */
router.post('/upload-and-split-video', express.raw({ limit: '2gb', type: '*/*' }), async (req, res) => {
  try {
    // Determine if this is a video or audio file based on MIME type
    const contentType = req.headers['content-type'] || '';
    const isAudio = contentType.startsWith('audio/');
    const mediaType = isAudio ? 'audio' : 'video';

    // Generate a unique filename
    const timestamp = Date.now();
    const fileExtension = contentType.split('/')[1] || (isAudio ? 'mp3' : 'mp4');
    const filename = `upload_${timestamp}.${fileExtension}`;
    const mediaPath = path.join(VIDEOS_DIR, filename);

    // Save the uploaded media file
    fs.writeFileSync(mediaPath, req.body);


    // Get segment duration from query params or use default (10 minutes)
    const segmentDuration = parseInt(req.query.segmentDuration || '600');
    const fastSplit = req.query.fastSplit === 'true';
    const optimizeVideos = req.query.optimizeVideos === 'true';
    const optimizedResolution = req.query.optimizedResolution || '360p';

    let processPath = mediaPath;
    let optimizedResult = null;

    // Optimize video if requested and it's a video (not audio)
    if (optimizeVideos && !isAudio) {
      try {

        const optimizedFilename = `optimized_${timestamp}.mp4`;
        const optimizedPath = path.join(VIDEOS_DIR, optimizedFilename);

        optimizedResult = await optimizeVideo(processPath, optimizedPath, {
          resolution: optimizedResolution,
          fps: 15
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
 * POST /api/split-video - Split a media file (video or audio) into segments
 */
router.post('/split-video', express.raw({ limit: '2gb', type: '*/*' }), async (req, res) => {
  try {
    // Determine if this is a video or audio file based on MIME type
    const contentType = req.headers['content-type'] || '';
    const isAudio = contentType.startsWith('audio/');
    const mediaType = isAudio ? 'audio' : 'video';

    // Generate a unique filename for the original media file
    let mediaId = req.query.mediaId || req.query.videoId || `${mediaType}_${Date.now()}`;

    // Remove any file extension from mediaId to prevent double extensions
    mediaId = mediaId.replace(/\.(mp[34]|webm|mov|avi|wmv|flv|mkv)$/i, '');

    // Log the cleaned mediaId


    const fileExtension = contentType.split('/')[1] || (isAudio ? 'mp3' : 'mp4');
    const filename = `${mediaId}.${fileExtension}`;
    const mediaPath = path.join(VIDEOS_DIR, filename);

    // Check if the file size is reasonable
    if (req.body.length < 100 * 1024) { // Less than 100KB
      console.error(`[SPLIT-VIDEO] File is too small (${req.body.length} bytes), likely not a valid ${mediaType}`);
      return res.status(400).json({
        success: false,
        error: `File is too small (${req.body.length} bytes), likely not a valid ${mediaType}`
      });
    }

    // Save the uploaded media file
    fs.writeFileSync(mediaPath, req.body);



    // Get segment duration from query params or use default (10 minutes = 600 seconds)
    const segmentDuration = parseInt(req.query.segmentDuration || '600');
    const fastSplit = req.query.fastSplit === 'true';
    // Parse optimizeVideos parameter - default to false to avoid duplication
    // Check explicitly for 'true' string to ensure we don't optimize unless explicitly requested
    const optimizeVideos = req.query.optimizeVideos === 'true';

    const optimizedResolution = req.query.optimizedResolution || '360p';

    let processPath = mediaPath;
    let optimizedResult = null;

    // Optimize video if requested and it's a video (not audio)
    if (optimizeVideos && !isAudio) {
      try {


        // Ensure we don't have double extensions in the optimized filename
        const cleanMediaId = mediaId.replace(/\.(mp[34]|webm|mov|avi|wmv|flv|mkv)$/i, '');
        const optimizedFilename = `optimized_${cleanMediaId}.mp4`;
        const optimizedPath = path.join(VIDEOS_DIR, optimizedFilename);


        optimizedResult = await optimizeVideo(processPath, optimizedPath, {
          resolution: optimizedResolution,
          fps: 15
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
 * POST /api/optimize-video - Optimize a video by scaling it to a lower resolution and reducing the frame rate
 * Also creates an analysis video with 500 frames for Gemini analysis
 * Automatically converts audio files to video at the start
 */
router.post('/optimize-video', express.raw({ limit: '2gb', type: '*/*' }), async (req, res) => {
  try {
    // Get optimization options from query params
    const resolution = req.query.resolution || '360p';
    const fps = parseInt(req.query.fps || '15');

    // Determine if this is a video or audio file based on MIME type
    const contentType = req.headers['content-type'] || 'video/mp4';
    const isAudio = contentType.startsWith('audio/');
    const mediaType = isAudio ? 'audio' : 'video';

    // Generate a unique filename for the original file
    const timestamp = Date.now();
    const originalFileExtension = contentType.split('/')[1] || (isAudio ? 'mp3' : 'mp4');
    const originalFilename = `original_${timestamp}.${originalFileExtension}`;
    const originalPath = path.join(VIDEOS_DIR, originalFilename);

    // Always use mp4 for processed files
    const optimizedFilename = `optimized_${timestamp}.mp4`;
    const analysisFilename = `analysis_500frames_${timestamp}.mp4`;
    const optimizedPath = path.join(VIDEOS_DIR, optimizedFilename);
    const analysisPath = path.join(VIDEOS_DIR, analysisFilename);

    // Save the uploaded file
    fs.writeFileSync(originalPath, req.body);



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

    // Create an analysis video with 500 frames



    const analysisResult = await createAnalysisVideo(videoForAnalysis, analysisPath);

    if (analysisResult.isOriginal) {

    } else {


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
      // Include analysis video information
      analysis: analysisResult.isOriginal ? {
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
      }
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
    const ffmpegProcess = spawn('ffmpeg', [
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
 * POST /api/extract-audio-from-blob - Extract audio from a video blob
 * This endpoint accepts the actual video data as a binary file
 */
router.post('/extract-audio-from-blob', express.raw({ limit: '500mb', type: '*/*' }), async (req, res) => {
  try {


    // Get filename from query parameter
    const filename = req.query.filename || 'audio';

    // Generate unique filenames for the temporary video and the output audio
    const timestamp = Date.now();
    const videoFilename = `temp_video_${timestamp}.mp4`;
    const audioFilename = `audio_${timestamp}.mp3`;
    const videoPath = path.join(VIDEOS_DIR, videoFilename);
    const audioPath = path.join(VIDEOS_DIR, audioFilename);

    // Save the uploaded video data to a temporary file
    fs.writeFileSync(videoPath, req.body);


    // Use ffmpeg to extract audio
    const { spawn } = require('child_process');
    const ffmpegProcess = spawn('ffmpeg', [
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

    // Get video metadata using ffprobe
    const { getMediaDuration } = require('../services/videoProcessing/durationUtils');

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
 * POST /api/convert-audio-to-video - Convert an audio file to a video file
 */
router.post('/convert-audio-to-video', express.raw({ limit: '2gb', type: 'audio/*' }), async (req, res) => {
  try {
    // Get the content type to determine the audio format
    const contentType = req.headers['content-type'] || 'audio/mp3';

    // Generate a unique filename for the audio file
    const timestamp = Date.now();
    const fileExtension = contentType.split('/')[1] || 'mp3';

    // Generate a hash of the audio content for caching purposes
    const crypto = require('crypto');
    const audioHash = crypto.createHash('md5').update(req.body).digest('hex').substring(0, 10);

    // Check if we already have a converted file for this audio
    const files = fs.readdirSync(VIDEOS_DIR);
    const existingConvertedFile = files.find(file => file.startsWith(`converted_${audioHash}_`) && file.endsWith('.mp4'));

    if (existingConvertedFile) {

      const videoPath = path.join(VIDEOS_DIR, existingConvertedFile);

      try {
        // Get video metadata
        const { getMediaDuration } = require('../services/videoProcessing/durationUtils');
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

    const audioFilename = `audio_${timestamp}.${fileExtension}`;
    const videoFilename = `converted_${audioHash}_${timestamp}.mp4`;
    const audioPath = path.join(VIDEOS_DIR, audioFilename);
    const videoPath = path.join(VIDEOS_DIR, videoFilename);

    // Save the uploaded audio file
    fs.writeFileSync(audioPath, req.body);



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

module.exports = router;
