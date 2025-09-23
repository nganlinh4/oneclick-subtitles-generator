/**
 * Universal Video Normalizer
 * Handles video format issues from all sources (Douyin, Bilibili, uploads, etc.)
 * Only fixes when necessary using quick methods when possible
 */

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const util = require('util');
const execPromise = util.promisify(exec);

/**
 * Check if a video has any compatibility issues
 * @param {string} videoPath - Path to the video file
 * @returns {Promise<Object>} - Analysis results with detected issues
 */
async function analyzeVideo(videoPath) {
  const ffprobeExe = require('../shared/ffmpegUtils').getFfprobePath();
  const ffprobeCmd = `"${ffprobeExe}" -v quiet -print_format json -show_streams -show_format "${videoPath}"`;
  
  try {
    const { stdout } = await execPromise(ffprobeCmd);
    const data = JSON.parse(stdout);
    
    const issues = [];
    let needsQuickFix = false;
    let needsFullConversion = false;
    
    const streams = data.streams || [];
    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStream = streams.find(s => s.codec_type === 'audio');
    const firstVideoIndex = streams.findIndex(s => s.codec_type === 'video');
    const firstAudioIndex = streams.findIndex(s => s.codec_type === 'audio');
    
    // 1. Check stream order (critical issue)
    if (firstAudioIndex !== -1 && firstVideoIndex !== -1 && firstAudioIndex < firstVideoIndex) {
      issues.push({
        type: 'stream_order',
        severity: 'high',
        description: 'Audio stream before video stream'
      });
      needsQuickFix = true;
    }
    
    // 2. Check for problematic audio codecs
    if (audioStream) {
      // HE-AAC variants (Douyin issue)
      if (audioStream.profile && audioStream.profile.includes('HE-AAC')) {
        issues.push({
          type: 'audio_codec',
          severity: 'high',
          description: `Problematic audio codec: ${audioStream.profile}`
        });
        needsQuickFix = true;
      }
      // Modern codecs - only convert if truly problematic
      // Opus is actually well-supported in modern browsers, so just warn
      else if (['vorbis', 'flac'].includes(audioStream.codec_name?.toLowerCase())) {
        issues.push({
          type: 'audio_codec',
          severity: 'medium',
          description: `Uncommon audio codec: ${audioStream.codec_name.toUpperCase()}`
        });
        needsFullConversion = true;
      } else if (audioStream.codec_name?.toLowerCase() === 'opus') {
        issues.push({
          type: 'audio_codec',
          severity: 'info',
          description: `Audio uses Opus codec (generally supported)`
        });
        // Don't force conversion for Opus
      }
    }
    
    // 3. Check for problematic video codecs
    if (videoStream) {
      // Only convert truly incompatible codecs, NOT HEVC/H.265 which is widely supported
      const problematicCodecs = ['av1', 'vp8', 'vp9'];
      const codecName = videoStream.codec_name?.toLowerCase();
      
      if (problematicCodecs.includes(codecName)) {
        issues.push({
          type: 'video_codec',
          severity: 'medium',
          description: `Incompatible video codec: ${videoStream.codec_name.toUpperCase()}`
        });
        needsFullConversion = true;
      }
      
      // Just log HEVC as info, don't force conversion
      if (codecName === 'hevc' || codecName === 'h265') {
        issues.push({
          type: 'video_codec',
          severity: 'info',
          description: `Video uses HEVC/H.265 codec (generally supported)`
        });
        // Don't set needsFullConversion for HEVC
      }
    }
    
    // 4. Check for problematic metadata (Douyin/TikTok)
    if (data.format?.tags) {
      const tags = data.format.tags;
      if ((tags.comment && tags.comment.includes('vid:')) || 
          (tags.information && tags.information.includes('bytedance'))) {
        issues.push({
          type: 'metadata',
          severity: 'low',
          description: 'Contains platform-specific metadata'
        });
        // Don't force fix for metadata alone
      }
    }
    
    // 5. Duration warning (informational only)
    const duration = parseFloat(data.format?.duration || 0);
    if (duration > 300) {
      issues.push({
        type: 'duration',
        severity: 'info',
        description: `Long video: ${Math.round(duration)} seconds`
      });
      // Don't force fix for duration
    }
    
    return {
      needsNormalization: needsQuickFix || needsFullConversion,
      needsQuickFix,
      needsFullConversion,
      issues,
      duration,
      videoCodec: videoStream?.codec_name,
      audioCodec: audioStream?.codec_name,
      videoProfile: videoStream?.profile,
      audioProfile: audioStream?.profile,
      resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : 'unknown',
      streams: streams.map(s => ({
        index: s.index,
        type: s.codec_type,
        codec: s.codec_name,
        profile: s.profile
      }))
    };
    
  } catch (error) {
    console.error('[UniversalNormalizer] Error analyzing video:', error);
    return {
      needsNormalization: false,
      error: error.message
    };
  }
}

/**
 * Quick fix for stream order and audio codec issues (like Douyin videos)
 * Very fast - only re-muxes and converts audio if needed
 * @param {string} inputPath - Input video path
 * @returns {Promise<string>} - Path to fixed video
 */
async function quickFixVideo(inputPath) {
  console.log('[UniversalNormalizer] Applying quick fix...');
  
  const dir = path.dirname(inputPath);
  const basename = path.basename(inputPath, '.mp4');
  const tempPath = path.join(dir, `${basename}_fixing.mp4`);
  
  // Quick fix command - reorder streams and fix audio codec only
  const ffmpegExe = require('../shared/ffmpegUtils').getFfmpegPath();
  const ffmpegCmd = [
    `"${ffmpegExe}"`,
    '-i', `"${inputPath}"`,
    '-y',
    
    // Map streams in correct order (video first, then audio)
    '-map', '0:v:0?',  // First video stream (optional)
    '-map', '0:a:0?',  // First audio stream (optional)
    
    // Copy video without re-encoding (fast!)
    '-c:v', 'copy',
    
    // Convert audio to standard AAC if needed
    '-c:a', 'aac',
    '-b:a', '128k',
    
    // Web optimization
    '-movflags', '+faststart',
    
    `"${tempPath}"`
  ].join(' ');
  
  try {
    await execPromise(ffmpegCmd, { maxBuffer: 10 * 1024 * 1024 });
    
    // Verify the temp file exists and has content
    const tempStats = await fs.stat(tempPath);
    if (tempStats.size < 1000) {
      throw new Error('Converted file is too small, likely corrupted');
    }
    
    // Make the replacement atomic to avoid corruption
    const backupPath = `${inputPath}.backup`;
    try {
      // Create backup first
      await fs.rename(inputPath, backupPath);
      // Move new file to original location
      await fs.rename(tempPath, inputPath);
      // Delete backup only after successful replacement
      await fs.unlink(backupPath);
      
      // Wait a bit to ensure file handles are fully released
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (replaceError) {
      // If replacement fails, restore backup
      try {
        await fs.rename(backupPath, inputPath);
      } catch {}
      throw replaceError;
    }
    
    console.log('[UniversalNormalizer] Quick fix completed');
    return inputPath;
    
  } catch (error) {
    // Clean up temp file if exists
    try { await fs.unlink(tempPath); } catch {}
    throw new Error(`Quick fix failed: ${error.message}`);
  }
}

/**
 * Full conversion for videos with truly incompatible codecs (AV1, VP8, VP9)
 * Less aggressive version - uses faster settings
 * @param {string} inputPath - Input video path
 * @returns {Promise<string>} - Path to converted video
 */
async function fullConvertVideo(inputPath) {
  console.log('[UniversalNormalizer] Full conversion required for codec compatibility...');
  
  const dir = path.dirname(inputPath);
  const basename = path.basename(inputPath, '.mp4');
  const tempPath = path.join(dir, `${basename}_converting.mp4`);
  
  const ffmpegExe = require('../shared/ffmpegUtils').getFfmpegPath();
  const ffmpegCmd = [
    `"${ffmpegExe}"`,
    '-i', `"${inputPath}"`,
    '-y',
    
    // Video settings - less aggressive, faster encoding
    '-c:v', 'libx264',
    '-profile:v', 'main',      // Main profile (good compatibility, better compression)
    '-level', '4.0',           // Higher level for better performance
    '-preset', 'faster',       // Faster encoding (was 'medium')
    '-crf', '23',              // Good quality
    '-pix_fmt', 'yuv420p',
    // Don't force framerate - keep original
    
    // Audio settings - less aggressive
    '-c:a', 'aac',
    '-b:a', '128k',           // Standard bitrate (was 192k)
    '-ar', '44100',           // Keep common sample rate (was 48000)
    '-ac', '2',               // Stereo
    
    // Container optimization
    '-movflags', '+faststart',
    '-max_muxing_queue_size', '9999',
    
    `"${tempPath}"`
  ].join(' ');
  
  try {
    console.log('[UniversalNormalizer] Converting video codecs...');
    await execPromise(ffmpegCmd, { maxBuffer: 10 * 1024 * 1024 });
    
    // Verify the temp file exists and has content
    const tempStats = await fs.stat(tempPath);
    if (tempStats.size < 1000) {
      throw new Error('Converted file is too small, likely corrupted');
    }
    
    // Make the replacement atomic to avoid corruption
    const backupPath = `${inputPath}.backup`;
    try {
      // Create backup first
      await fs.rename(inputPath, backupPath);
      // Move new file to original location
      await fs.rename(tempPath, inputPath);
      // Delete backup only after successful replacement
      await fs.unlink(backupPath);
      
      // Wait a bit to ensure file handles are fully released
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (replaceError) {
      // If replacement fails, restore backup
      try {
        await fs.rename(backupPath, inputPath);
      } catch {}
      throw replaceError;
    }
    
    const stats = await fs.stat(inputPath);
    console.log('[UniversalNormalizer] Full conversion completed:', {
      size: Math.round(stats.size / 1024 / 1024 * 100) / 100 + ' MB'
    });
    
    return inputPath;
    
  } catch (error) {
    // Clean up temp file if exists
    try { await fs.unlink(tempPath); } catch {}
    throw new Error(`Full conversion failed: ${error.message}`);
  }
}

/**
 * Main normalization function - automatically chooses the right fix
 * @param {string} videoPath - Path to video file
 * @param {boolean} forceNormalize - Force normalization even if not needed
 * @returns {Promise<Object>} - Normalization result
 */
async function normalizeVideo(videoPath, forceNormalize = false) {
  // TEMPORARY BYPASS FOR TESTING - Set to true to disable all normalization
  const BYPASS_NORMALIZATION = true;  // <<<< CHANGE THIS TO false TO RE-ENABLE
  
  if (BYPASS_NORMALIZATION) {
    console.log('[UniversalNormalizer] ⚠️ NORMALIZATION BYPASSED FOR TESTING');
    return {
      normalized: false,
      path: videoPath,
      analysis: { issues: [], needsNormalization: false },
      message: 'Normalization bypassed for testing'
    };
  }
  
  try {
    console.log('[UniversalNormalizer] Checking video:', path.basename(videoPath));
    
    // Analyze the video
    const analysis = await analyzeVideo(videoPath);
    
    // Log issues found
    if (analysis.issues.length > 0) {
      console.log('[UniversalNormalizer] Issues found:');
      analysis.issues.forEach(issue => {
        const icon = issue.severity === 'high' ? '🔴' : 
                    issue.severity === 'medium' ? '🟡' : 
                    issue.severity === 'low' ? '🟢' : 'ℹ️';
        console.log(`  ${icon} ${issue.description}`);
      });
    }
    
    // Check if normalization is needed
    if (!analysis.needsNormalization && !forceNormalize) {
      console.log('[UniversalNormalizer] ✅ Video is already compatible');
      return {
        normalized: false,
        path: videoPath,
        analysis,
        message: 'Video is already compatible'
      };
    }
    
    // Choose normalization method
    let normalizedPath;
    let method;
    
    if (analysis.needsQuickFix && !analysis.needsFullConversion) {
      // Use quick fix for stream order and audio codec issues
      console.log('[UniversalNormalizer] Using quick fix method (fast)');
      normalizedPath = await quickFixVideo(videoPath);
      method = 'quick_fix';
    } else {
      // Use full conversion for video codec issues
      console.log('[UniversalNormalizer] Using full conversion method (slower)');
      normalizedPath = await fullConvertVideo(videoPath);
      method = 'full_conversion';
    }
    
    console.log('[UniversalNormalizer] ✅ Video normalization completed');
    
    return {
      normalized: true,
      path: normalizedPath,
      method,
      analysis,
      message: 'Video normalized successfully'
    };
    
  } catch (error) {
    console.error('[UniversalNormalizer] Normalization failed:', error.message);
    return {
      normalized: false,
      path: videoPath,
      error: error.message,
      message: 'Normalization failed, using original video'
    };
  }
}

/**
 * Batch normalize multiple videos
 * @param {Array<string>} videoPaths - Array of video paths
 * @returns {Promise<Array>} - Array of normalization results
 */
async function normalizeVideoBatch(videoPaths) {
  const results = [];
  
  for (const videoPath of videoPaths) {
    const result = await normalizeVideo(videoPath);
    results.push(result);
  }
  
  return results;
}

module.exports = {
  analyzeVideo,
  normalizeVideo,
  normalizeVideoBatch,
  quickFixVideo,
  fullConvertVideo
};
