/**
 * YouTube downloader using yt-dlp command line tool
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { safeMoveFile } = require('../../utils/fileOperations');

/**
 * Download YouTube video using yt-dlp command line tool
 * @param {string} videoURL - YouTube video URL
 * @param {string} outputPath - Path to save the video
 * @param {string} quality - Desired video quality (e.g., '144p', '360p', '720p')
 * @param {function(number): void} [onProgress] - Optional callback for progress updates (0-100)
 * @returns {Promise<boolean>} - Success status
 */
async function downloadWithYtdlp(videoURL, outputPath, quality = '360p', onProgress) {
  return new Promise((resolve, reject) => {


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



    // Create a temporary directory for the download
    const tempDir = path.dirname(outputPath);
    const tempFilename = `${path.basename(outputPath, '.mp4')}.ytdlp.mp4`;
    const tempPath = path.join(tempDir, tempFilename);

    // Determine the yt-dlp executable path
    // First try to use the one in the virtual environment
    const isWindows = os.platform() === 'win32';
    const venvPath = path.join(process.cwd(), '.venv');
    const venvBinDir = isWindows ? 'Scripts' : 'bin';
    const ytdlpInVenv = path.join(process.cwd(), '.venv', venvBinDir, isWindows ? 'yt-dlp.exe' : 'yt-dlp');

    // Check if yt-dlp exists in the virtual environment
    const ytdlpExists = fs.existsSync(ytdlpInVenv);
    const ytdlpCommand = ytdlpExists ? ytdlpInVenv : 'yt-dlp';



    // Build the yt-dlp command arguments
    const args = [
      videoURL,
      '-f', `bestvideo[height<=${resolution}]+bestaudio/best[height<=${resolution}]`,
      '-o', tempPath,
      '--no-playlist',
      '--merge-output-format', 'mp4',
      '--progress', // Add progress reporting
      '--progress-template', '%(progress.percentage)s' // Template for progress output
    ];



    // Spawn the yt-dlp process
    const ytdlpProcess = spawn(ytdlpCommand, args);

    let stdoutData = '';
    let stderrData = '';

    ytdlpProcess.stdout.on('data', (data) => {
      const output = data.toString();
      stdoutData += output;

      // Parse progress information
      // With the template, output will be just the percentage, e.g., "10.5"
      const percentage = parseFloat(output.trim());
      if (typeof onProgress === 'function' && !isNaN(percentage)) {
        onProgress(percentage);
      }
    });

    ytdlpProcess.stderr.on('data', (data) => {
      const output = data.toString();
      stderrData += output;
      console.error(`[yt-dlp error] ${output.trim()}`);
    });

    ytdlpProcess.on('close', (code) => {
      if (code === 0) {
        // Success - move the file to the final location
        try {
          // Check if the file exists
          if (fs.existsSync(tempPath)) {
            // Use safeMoveFile to avoid EPERM errors on Windows
            // This uses copy-then-delete instead of rename
            safeMoveFile(tempPath, outputPath)
              .then(() => {

                resolve(true);
              })
              .catch((err) => {
                console.error(`Error moving yt-dlp downloaded file: ${err.message}`);
                reject(err);
              });
          } else {
            console.error(`yt-dlp process completed but file not found: ${tempPath}`);
            reject(new Error('yt-dlp process completed but file not found'));
          }
        } catch (error) {
          console.error(`Error moving yt-dlp downloaded file: ${error.message}`);
          reject(error);
        }
      } else {
        console.error(`yt-dlp process exited with code ${code}`);
        reject(new Error(`yt-dlp process failed with code ${code}: ${stderrData}`));
      }
    });

    ytdlpProcess.on('error', (error) => {
      console.error(`Error spawning yt-dlp process: ${error.message}`);

      // If the error is ENOENT (command not found), provide a more helpful message
      if (error.code === 'ENOENT') {
        console.error(`yt-dlp command not found. Make sure yt-dlp is installed in the virtual environment.`);
        reject(new Error('yt-dlp command not found. Please install yt-dlp using "uv pip install yt-dlp"'));
      } else {
        reject(error);
      }
    });
  });
}

module.exports = {
  downloadWithYtdlp
};
