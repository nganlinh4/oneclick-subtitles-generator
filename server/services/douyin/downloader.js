/**
 * Douyin video downloader module
 */

const path = require('path');
const fs = require('fs');
const { spawn, exec, execSync } = require('child_process');
const { VIDEOS_DIR } = require('../../config');
const { promisify } = require('util');
const execPromise = promisify(exec);
const douyinPuppeteer = require('./douyin_puppeteer');
const { getYtDlpPath, getYtDlpArgs, getOptimizedYtDlpArgs } = require('../shared/ytdlpUtils');
const {
  setDownloadProgress,
  updateProgressFromYtdlpOutput
} = require('../shared/progressTracker');
const {
  lockDownload,
  unlockDownload,
  updateProcessRef
} = require('../shared/globalDownloadManager');



/**
 * Check if yt-dlp is installed and get its version
 * @returns {Promise<string>} - yt-dlp version
 */
async function checkYtDlpVersion() {
  const ytDlpPath = getYtDlpPath();

  try {
    const { stdout } = await execPromise(`"${ytDlpPath}" --version`);

    return stdout.trim();
  } catch (error) {
    console.error('Error checking yt-dlp version:', error.message);
    console.warn('yt-dlp is not installed or not in PATH. Will attempt to use alternative methods.');
    return 'not-installed';
  }
}

/**
 * Normalize Douyin URL to ensure it's in the correct format
 * @param {string} url - The Douyin URL to normalize
 * @returns {string} - Normalized URL
 */
function normalizeDouyinUrl(url) {
  // If it's a short URL (v.douyin.com), make sure it has https:// prefix
  if (url.includes('v.douyin.com') && !url.startsWith('http')) {
    return `https://${url}`;
  }

  // If it's a full URL (www.douyin.com), make sure it has https:// prefix
  if (url.includes('douyin.com') && !url.startsWith('http')) {
    return `https://${url}`;
  }

  // Remove trailing slashes for consistency
  let normalizedUrl = url;
  while (normalizedUrl.endsWith('/')) {
    normalizedUrl = normalizedUrl.slice(0, -1);
  }

  // Special handling for short URLs to ensure they work properly
  if (normalizedUrl.includes('v.douyin.com')) {
    // Make sure the URL ends with a slash for short URLs
    if (!normalizedUrl.endsWith('/')) {
      normalizedUrl = `${normalizedUrl}/`;
    }


  }

  return normalizedUrl;
}

/**
 * Download Douyin video using yt-dlp
 * @param {string} videoId - Douyin video ID
 * @param {string} videoURL - Douyin video URL
 * @param {string} quality - Desired video quality (e.g., '144p', '360p', '720p')
 * @param {boolean} useCookies - Whether to use browser cookies for authentication
 * @returns {Promise<Object>} - Result object with success status and path
 */
async function downloadDouyinVideoYtDlp(videoId, videoURL, quality = '360p', useCookies = false) {
  const outputPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

  // Normalize the URL
  const normalizedUrl = normalizeDouyinUrl(videoURL);



  try {
    // Check if yt-dlp is installed
    const ytdlpVersion = await checkYtDlpVersion();

  } catch (error) {
    console.error('yt-dlp check failed:', error.message);
    throw error;
  }

  // Convert quality string to resolution for yt-dlp
  let resolution;
  switch (quality) {
    case '144p': resolution = '144'; break;
    case '240p': resolution = '240'; break;
    case '360p': resolution = '360'; break;
    case '480p': resolution = '480'; break;
    case '720p': resolution = '720'; break;
    case '1080p': resolution = '1080'; break;
    default: resolution = '360'; // Default to 360p
  }

  // Create a promise to handle the download process
  return new Promise((resolve, reject) => {
    // Get the path to yt-dlp
    const ytDlpPath = getYtDlpPath();

    // Use yt-dlp with quality-limited options for consistency and conditional cookie support
    const args = [
      ...getYtDlpArgs(useCookies),
      '--verbose',
      '--format', `best[height<=${resolution}]`,
      '--output', outputPath,
      '--force-overwrites',
      '--no-check-certificate',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      '--referer', 'https://www.douyin.com/',
      '--add-header', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
      normalizedUrl
    ];

    console.log(`[douyin] Running yt-dlp with args:`, args);
    const ytdlpProcess = spawn(ytDlpPath, args);

    let errorOutput = '';
    let stdoutData = '';

    ytdlpProcess.stdout.on('data', (data) => {
      const dataStr = data.toString();
      stdoutData += dataStr;

    });

    ytdlpProcess.stderr.on('data', (data) => {
      const dataStr = data.toString();
      errorOutput += dataStr;
      console.error(`yt-dlp stderr: ${dataStr}`);
    });

    ytdlpProcess.on('close', (code) => {
      if (code === 0) {
        // Check if the file was created successfully
        if (fs.existsSync(outputPath)) {

          resolve({
            success: true,
            path: outputPath,
            message: 'Video downloaded successfully with yt-dlp',
            method: 'yt-dlp'
          });
        } else {
          console.error(`Download completed but video file was not found at ${outputPath}`);
          reject(new Error('Download completed but video file was not found'));
        }
      } else {
        console.error(`yt-dlp process exited with code ${code}`);
        console.error(`Error output: ${errorOutput}`);
        console.error(`Standard output: ${stdoutData}`);

        // Try to provide more helpful error messages
        if (errorOutput.includes('HTTP Error 403: Forbidden')) {
          reject(new Error('Access to this Douyin video is forbidden. The video might be private or region-restricted.'));
        } else if (errorOutput.includes('Video unavailable')) {
          reject(new Error('This Douyin video is unavailable. It may have been deleted or made private.'));
        } else if (errorOutput.includes('Unable to extract')) {
          reject(new Error('Unable to extract video information. The URL might be invalid or the video might be unavailable.'));
        } else {
          reject(new Error(`yt-dlp process exited with code ${code}: ${errorOutput}`));
        }
      }
    });

    ytdlpProcess.on('error', (error) => {
      console.error(`Failed to start yt-dlp process: ${error.message}`);
      reject(new Error(`Failed to start yt-dlp process: ${error.message}`));
    });
  });
}

/**
 * Fallback method to download Douyin video using a different approach
 * @param {string} videoId - Douyin video ID
 * @param {string} videoURL - Douyin video URL
 * @param {string} quality - Desired video quality (e.g., '144p', '360p', '720p')
 * @param {boolean} useCookies - Whether to use browser cookies for authentication
 * @returns {Promise<Object>} - Result object with success status and path
 */
async function downloadDouyinVideoFallback(videoId, videoURL, quality = '360p', useCookies = false) {
  const outputPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

  // Normalize the URL
  const normalizedUrl = normalizeDouyinUrl(videoURL);



  // Convert quality string to resolution for yt-dlp fallback
  let resolution;
  switch (quality) {
    case '144p': resolution = '144'; break;
    case '240p': resolution = '240'; break;
    case '360p': resolution = '360'; break;
    case '480p': resolution = '480'; break;
    case '720p': resolution = '720'; break;
    case '1080p': resolution = '1080'; break;
    default: resolution = '360'; // Default to 360p
  }

  return new Promise((resolve, reject) => {
    // Get the path to yt-dlp
    const ytDlpPath = getYtDlpPath();

    // Use yt-dlp with different options for the fallback method but respect quality limit and conditional cookie support
    const args = [
      ...getYtDlpArgs(useCookies),
      '--verbose',
      '--no-check-certificate',
      '--force-overwrites',
      '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
      '--referer', 'https://www.douyin.com/',
      '--add-header', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
      '--add-header', 'Cookie: douyin.com',
      '--format', `bestvideo[height<=${resolution}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${resolution}][ext=mp4]/best[height<=${resolution}]`,
      '--merge-output-format', 'mp4',
      '--output', outputPath,
      normalizedUrl
    ];

    console.log(`[douyin-fallback] Running yt-dlp with args:`, args);
    const ytdlpProcess = spawn(ytDlpPath, args);

    let errorOutput = '';
    let stdoutData = '';

    ytdlpProcess.stdout.on('data', (data) => {
      const dataStr = data.toString();
      stdoutData += dataStr;

    });

    ytdlpProcess.stderr.on('data', (data) => {
      const dataStr = data.toString();
      errorOutput += dataStr;
      console.error(`Fallback yt-dlp stderr: ${dataStr}`);
    });

    ytdlpProcess.on('close', (code) => {
      if (code === 0) {
        // Check if the file was created successfully
        if (fs.existsSync(outputPath)) {

          resolve({
            success: true,
            path: outputPath,
            message: 'Video downloaded successfully with fallback method',
            method: 'fallback'
          });
        } else {
          console.error(`Fallback download completed but video file was not found at ${outputPath}`);
          reject(new Error('Fallback download completed but video file was not found'));
        }
      } else {
        console.error(`Fallback yt-dlp process exited with code ${code}`);
        console.error(`Fallback error output: ${errorOutput}`);
        reject(new Error(`Fallback download failed with code ${code}: ${errorOutput}`));
      }
    });

    ytdlpProcess.on('error', (error) => {
      console.error(`Failed to start fallback yt-dlp process: ${error.message}`);
      reject(new Error(`Failed to start fallback yt-dlp process: ${error.message}`));
    });
  });
}

/**
 * Second fallback method specifically for short URLs
 * @param {string} videoId - Douyin video ID
 * @param {string} videoURL - Douyin video URL
 * @param {string} quality - Desired video quality (e.g., '144p', '360p', '720p')
 * @param {boolean} useCookies - Whether to use browser cookies for authentication
 * @returns {Promise<Object>} - Result object with success status and path
 */
async function downloadDouyinVideoShortUrlFallback(videoId, videoURL, quality = '360p', useCookies = false) {
  const outputPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

  // Normalize the URL but ensure it has a trailing slash for short URLs
  let normalizedUrl = normalizeDouyinUrl(videoURL);

  // Make sure it's a short URL
  if (!normalizedUrl.includes('v.douyin.com')) {
    throw new Error('This fallback method is only for short URLs');
  }



  // Convert quality string to resolution for yt-dlp short URL fallback
  let resolution;
  switch (quality) {
    case '144p': resolution = '144'; break;
    case '240p': resolution = '240'; break;
    case '360p': resolution = '360'; break;
    case '480p': resolution = '480'; break;
    case '720p': resolution = '720'; break;
    case '1080p': resolution = '1080'; break;
    default: resolution = '360'; // Default to 360p
  }

  return new Promise((resolve, reject) => {
    // Get the path to yt-dlp
    const ytDlpPath = getYtDlpPath();

    // Use yt-dlp with special options for short URLs but respect quality limit and conditional cookie support
    const args = [
      ...getYtDlpArgs(useCookies),
      '--verbose',
      '--no-check-certificate',
      '--force-overwrites',
      '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
      '--referer', 'https://www.douyin.com/',
      '--add-header', 'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
      '--add-header', 'Cookie: douyin.com',
      '--format', `best[height<=${resolution}]`,
      '--output', outputPath,
      normalizedUrl
    ];

    console.log(`[douyin-short] Running yt-dlp with args:`, args);
    const ytdlpProcess = spawn(ytDlpPath, args);

    let errorOutput = '';
    let stdoutData = '';

    ytdlpProcess.stdout.on('data', (data) => {
      const dataStr = data.toString();
      stdoutData += dataStr;

    });

    ytdlpProcess.stderr.on('data', (data) => {
      const dataStr = data.toString();
      errorOutput += dataStr;
      console.error(`Short URL fallback stderr: ${dataStr}`);
    });

    ytdlpProcess.on('close', (code) => {
      if (code === 0) {
        // Check if the file was created successfully
        if (fs.existsSync(outputPath)) {

          resolve({
            success: true,
            path: outputPath,
            message: 'Video downloaded successfully with short URL fallback method',
            method: 'short-url-fallback'
          });
        } else {
          console.error(`Short URL fallback download completed but video file was not found at ${outputPath}`);
          reject(new Error('Short URL fallback download completed but video file was not found'));
        }
      } else {
        console.error(`Short URL fallback yt-dlp process exited with code ${code}`);
        console.error(`Short URL fallback error output: ${errorOutput}`);
        reject(new Error(`Short URL fallback download failed with code ${code}: ${errorOutput}`));
      }
    });

    ytdlpProcess.on('error', (error) => {
      console.error(`Failed to start short URL fallback yt-dlp process: ${error.message}`);
      reject(new Error(`Failed to start short URL fallback yt-dlp process: ${error.message}`));
    });
  });
}

/**
 * Final fallback method that uses a simpler approach
 * @param {string} videoId - Douyin video ID
 * @param {string} videoURL - Douyin video URL
 * @param {string} quality - Desired video quality (e.g., '144p', '360p', '720p')
 * @param {boolean} useCookies - Whether to use browser cookies for authentication
 * @returns {Promise<Object>} - Result object with success status and path
 */
async function downloadDouyinVideoSimpleFallback(videoId, videoURL, quality = '360p', useCookies = false) {
  const outputPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

  // Normalize the URL
  const normalizedUrl = normalizeDouyinUrl(videoURL);



  return new Promise((resolve, reject) => {
    // Get the path to yt-dlp
    const ytDlpPath = getYtDlpPath();

    // Use yt-dlp with minimal options for maximum compatibility and conditional cookie support
    const args = [
      ...getYtDlpArgs(useCookies),
      '--verbose',
      '--no-check-certificate',
      '--output', outputPath,
      normalizedUrl
    ];

    console.log(`[douyin-simple] Running yt-dlp with args:`, args);
    const ytdlpProcess = spawn(ytDlpPath, args);

    let errorOutput = '';
    let stdoutData = '';

    ytdlpProcess.stdout.on('data', (data) => {
      const dataStr = data.toString();
      stdoutData += dataStr;

    });

    ytdlpProcess.stderr.on('data', (data) => {
      const dataStr = data.toString();
      errorOutput += dataStr;
      console.error(`Simple fallback stderr: ${dataStr}`);
    });

    ytdlpProcess.on('close', (code) => {
      if (code === 0) {
        // Check if the file was created successfully
        if (fs.existsSync(outputPath)) {

          resolve({
            success: true,
            path: outputPath,
            message: 'Video downloaded successfully with simple fallback method',
            method: 'simple-fallback'
          });
        } else {
          console.error(`Simple fallback download completed but video file was not found at ${outputPath}`);
          reject(new Error('Simple fallback download completed but video file was not found'));
        }
      } else {
        console.error(`Simple fallback yt-dlp process exited with code ${code}`);
        console.error(`Simple fallback error output: ${errorOutput}`);
        reject(new Error(`Simple fallback download failed with code ${code}: ${errorOutput}`));
      }
    });

    ytdlpProcess.on('error', (error) => {
      console.error(`Failed to start simple fallback yt-dlp process: ${error.message}`);
      reject(new Error(`Failed to start simple fallback yt-dlp process: ${error.message}`));
    });
  });
}

/**
 * Download file with progress tracking and cancellation support
 * @param {string} url - File URL to download
 * @param {string} outputPath - Output file path
 * @param {string} videoId - Video ID for progress tracking
 * @param {AbortController} abortController - Abort controller for cancellation
 * @returns {Promise<void>}
 */
async function downloadFileWithProgress(url, outputPath, videoId, abortController = null) {
  const https = require('https');
  const http = require('http');

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https:') ? https : http;

    // Check if already aborted
    if (abortController && abortController.signal.aborted) {
      reject(new Error('Download was cancelled'));
      return;
    }

    const request = protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download file: HTTP ${response.statusCode}`));
        return;
      }

      const totalSize = parseInt(response.headers['content-length'], 10);
      let downloadedSize = 0;

      const fileStream = fs.createWriteStream(outputPath);

      // Handle abort signal
      if (abortController) {
        abortController.signal.addEventListener('abort', () => {
          console.log(`[DOUYIN] Download cancelled for ${videoId}`);
          request.destroy();
          response.destroy();
          fileStream.destroy();

          // Clean up partial file
          fs.unlink(outputPath, () => {});

          reject(new Error('Download was cancelled'));
        });
      }

      response.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize) {
          const progress = Math.round((downloadedSize / totalSize) * 70) + 30; // 30-100%
          setDownloadProgress(videoId, progress, 'downloading');
        }
      });

      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });

      fileStream.on('error', (error) => {
        fs.unlink(outputPath, () => {}); // Delete the file on error
        reject(error);
      });
    });

    request.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Puppeteer-based Douyin video downloader with cancellation support
 * @param {string} videoId - Douyin video ID
 * @param {string} videoURL - Douyin video URL
 * @param {Object} processRef - Process reference for cancellation
 * @returns {Promise<Object>} - Result object with success status and path
 */
async function downloadDouyinVideoPuppeteer(videoId, videoURL, processRef = {}) {
  const outputPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);

  // Normalize the URL
  const normalizedUrl = normalizeDouyinUrl(videoURL);

  try {
    // Create abort controller for HTTP download cancellation
    const abortController = new AbortController();
    processRef.abortController = abortController;

    // Extract video URL first (this will set processRef.browser)
    const videoUrl = await douyinPuppeteer.extractVideoUrl(normalizedUrl, processRef);

    // Check if cancelled after URL extraction
    if (processRef.cancelled) {
      throw new Error('Download was cancelled');
    }

    // Download the file with progress tracking and cancellation support
    await downloadFileWithProgress(videoUrl, outputPath, videoId, abortController);

    // Close browser after successful download
    if (processRef.browser) {
      await processRef.browser.close();
      processRef.browser = null;
    }

    // Check if the file was created successfully
    if (fs.existsSync(outputPath)) {
      return {
        success: true,
        path: outputPath,
        message: 'Video downloaded successfully with Puppeteer',
        method: 'puppeteer'
      };
    } else {
      throw new Error('Puppeteer download completed but video file was not found');
    }
  } catch (error) {
    console.error(`Puppeteer download failed: ${error.message}`);

    // Clean up browser on error
    if (processRef.browser) {
      try {
        await processRef.browser.close();
      } catch (e) {
        console.error('Error closing browser on failure:', e);
      }
      processRef.browser = null;
    }

    throw error;
  }
}

/**
 * Download Douyin video using Puppeteer method with cancellation support
 * @param {string} videoId - Douyin video ID
 * @param {string} videoURL - Douyin video URL
 * @param {string} quality - Desired video quality (e.g., '144p', '360p', '720p')
 * @param {boolean} useCookies - Whether to use browser cookies for authentication
 * @returns {Promise<Object>} - Result object with success status and path
 */
async function downloadDouyinVideoWithRetry(videoId, videoURL, quality = '360p', useCookies = false) {
  // Lock the download to prevent duplicates
  const lockAcquired = lockDownload(videoId, 'douyin-download');
  if (!lockAcquired) {
    throw new Error('Another download for this video is already in progress');
  }

  // Initialize progress
  setDownloadProgress(videoId, 0, 'downloading');

  // Create process reference for cancellation
  const processRef = {};

  try {
    console.log('[douyin] Using Puppeteer method...');

    // Update the process reference in the global manager
    updateProcessRef(videoId, processRef);

    // Update progress to indicate starting
    setDownloadProgress(videoId, 10, 'downloading');

    // Use the Puppeteer-based downloader with cancellation support
    const result = await downloadDouyinVideoPuppeteer(videoId, videoURL, processRef);

    // Mark as completed and set final progress
    setDownloadProgress(videoId, 100, 'completed');

    // Unlock the download
    unlockDownload(videoId, 'douyin-download', { cleanup: false });

    return result;
  } catch (error) {
    console.error(`Puppeteer download failed: ${error.message}`);

    // Unlock the download
    unlockDownload(videoId, 'douyin-download');

    // Handle cancellation gracefully - don't mark as error if cancelled
    if (error.message.includes('cancelled') ||
        error.message.includes('aborted') ||
        error.message.includes('Navigating frame was detached')) {
      console.log(`[DOUYIN] Download was cancelled for ${videoId}`);
      throw new Error('Download was cancelled by user');
    }

    // Mark as error only if not cancelled
    setDownloadProgress(videoId, 0, 'error');

    // Provide more specific error messages based on the error
    if (error.message.includes('No video URLs found')) {
      throw new Error('Could not find video on the Douyin page. The video might be private or deleted.');
    } else if (error.message.includes('Navigation timeout')) {
      throw new Error('Timed out while loading the Douyin page. Please try again later.');
    } else if (error.message.includes('net::ERR_CONNECTION_RESET') ||
               error.message.includes('net::ERR_CONNECTION_CLOSED')) {
      throw new Error('Connection was reset while accessing Douyin. This might be due to regional restrictions.');
    }

    throw new Error(`Douyin video download failed: ${error.message}`);
  }
}

module.exports = {
  downloadDouyinVideoPuppeteer,
  downloadDouyinVideoWithRetry,
  normalizeDouyinUrl
};
