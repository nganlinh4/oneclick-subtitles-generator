/**
 * Shared utilities for FFmpeg operations
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Get the path to ffmpeg executable
 * First checks for ffmpeg in common installation paths, then in PATH
 * @returns {string} - Path to ffmpeg executable
 */
function getFfmpegPath() {
  // Common installation paths for Windows
  const commonPaths = [
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'ffmpeg.exe'),
    path.join(process.env.USERPROFILE || '', 'ffmpeg', 'bin', 'ffmpeg.exe')
  ];

  // Check common paths first (Windows)
  if (process.platform === 'win32') {
    for (const commonPath of commonPaths) {
      if (fs.existsSync(commonPath)) {
        return commonPath;
      }
    }
    
    // Check for chocolatey installation
    const chocoPath = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'chocolatey', 'bin', 'ffmpeg.exe');
    if (fs.existsSync(chocoPath)) {
      return chocoPath;
    }
  }

  // If not found in common paths, use the one in PATH
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/**
 * Get the path to ffprobe executable
 * First checks for ffprobe in common installation paths, then in PATH
 * @returns {string} - Path to ffprobe executable
 */
function getFfprobePath() {
  // Common installation paths for Windows
  const commonPaths = [
    'C:\\ffmpeg\\bin\\ffprobe.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffprobe.exe',
    'C:\\Program Files (x86)\\ffmpeg\\bin\\ffprobe.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'ffprobe.exe'),
    path.join(process.env.USERPROFILE || '', 'ffmpeg', 'bin', 'ffprobe.exe')
  ];

  // Check common paths first (Windows)
  if (process.platform === 'win32') {
    for (const commonPath of commonPaths) {
      if (fs.existsSync(commonPath)) {
        return commonPath;
      }
    }
    
    // Check for chocolatey installation
    const chocoPath = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'chocolatey', 'bin', 'ffprobe.exe');
    if (fs.existsSync(chocoPath)) {
      return chocoPath;
    }
  }

  // If not found in common paths, use the one in PATH
  return process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
}

/**
 * Test if ffmpeg is available and working
 * @returns {Promise<boolean>} - True if ffmpeg is available
 */
async function testFfmpegAvailability() {
  return new Promise((resolve) => {
    const ffmpegPath = getFfmpegPath();
    const testProcess = spawn(ffmpegPath, ['-version']);
    
    testProcess.on('close', (code) => {
      resolve(code === 0);
    });
    
    testProcess.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Test if ffprobe is available and working
 * @returns {Promise<boolean>} - True if ffprobe is available
 */
async function testFfprobeAvailability() {
  return new Promise((resolve) => {
    const ffprobePath = getFfprobePath();
    const testProcess = spawn(ffprobePath, ['-version']);
    
    testProcess.on('close', (code) => {
      resolve(code === 0);
    });
    
    testProcess.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Get diagnostic information about ffmpeg/ffprobe availability
 * @returns {Promise<Object>} - Diagnostic information
 */
async function getDiagnosticInfo() {
  const ffmpegPath = getFfmpegPath();
  const ffprobePath = getFfprobePath();
  
  const [ffmpegAvailable, ffprobeAvailable] = await Promise.all([
    testFfmpegAvailability(),
    testFfprobeAvailability()
  ]);

  return {
    ffmpegPath,
    ffprobePath,
    ffmpegAvailable,
    ffprobeAvailable,
    platform: process.platform,
    pathEnv: process.env.PATH
  };
}

module.exports = {
  getFfmpegPath,
  getFfprobePath,
  testFfmpegAvailability,
  testFfprobeAvailability,
  getDiagnosticInfo
};
