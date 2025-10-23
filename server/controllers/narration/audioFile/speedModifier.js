/**
 * Module for modifying audio speed using ffmpeg
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Import directory paths
const { OUTPUT_AUDIO_DIR } = require('../directoryManager');

/**
 * Modify the speed of an audio file
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const modifyAudioSpeed = async (req, res) => {
  try {
    // Get the filename and speed factor from the request body
    const { filename, speedFactor } = req.body;

    if (!filename || !speedFactor) {
      return res.status(400).json({ error: 'Missing required parameters (filename, speedFactor)' });
    }

    // Validate speed factor (between 0.5 and 2.0)
    const speed = parseFloat(speedFactor);
    if (isNaN(speed) || speed < 0.5 || speed > 2.0) {
      return res.status(400).json({ error: 'Speed factor must be between 0.5 and 2.0' });
    }

    // Get the full path to the audio file
    const audioPath = path.join(OUTPUT_AUDIO_DIR, filename);

    // Check if the file exists
    if (!fs.existsSync(audioPath)) {
      return res.status(404).json({ error: `Audio file not found: ${filename}` });
    }

    // Create a backup of the original file if it doesn't exist already
    const backupFilename = `${path.dirname(filename)}/backup_${path.basename(filename)}`;
    const backupPath = path.join(OUTPUT_AUDIO_DIR, backupFilename);

    if (!fs.existsSync(backupPath)) {
      // Copy the original file to the backup location
      fs.copyFileSync(audioPath, backupPath);
    }

    // Use the backup file as the source to preserve quality
    const sourceFile = fs.existsSync(backupPath) ? backupPath : audioPath;

    // Construct ffmpeg command to modify audio speed
    // atempo filter allows speed adjustment between 0.5 and 2.0
    // For values outside this range, we can chain multiple atempo filters
    let filterComplex = '';

    if (speed >= 0.5 && speed <= 2.0) {
      // Simple case: single atempo filter
      filterComplex = `atempo=${speed}`;
    } else if (speed > 2.0 && speed <= 4.0) {
      // Chain two atempo filters for speeds between 2.0 and 4.0
      const halfSpeed = Math.sqrt(speed);
      filterComplex = `atempo=${halfSpeed},atempo=${halfSpeed}`;
    } else if (speed < 0.5 && speed >= 0.25) {
      // Chain two atempo filters for speeds between 0.25 and 0.5
      const halfSpeed = Math.sqrt(speed);
      filterComplex = `atempo=${halfSpeed},atempo=${halfSpeed}`;
    } else {
      return res.status(400).json({ error: 'Speed factor must be between 0.25 and 4.0' });
    }

    // Determine the appropriate codec based on file extension
    const fileExtension = path.extname(audioPath).toLowerCase();
    let codecArgs;

    if (fileExtension === '.mp3') {
      // For MP3 files, use libmp3lame codec
      codecArgs = ['-c:a', 'libmp3lame', '-b:a', '192k'];
    } else if (fileExtension === '.wav') {
      // For WAV files, use pcm_s16le codec
      codecArgs = ['-c:a', 'pcm_s16le', '-ar', '44100'];
    } else {
      // For other formats, let ffmpeg auto-detect
      codecArgs = ['-c:a', 'copy'];
    }

    // Build the ffmpeg command arguments
    const ffmpegArgs = [
      '-i', sourceFile,
      '-filter:a', filterComplex,
      ...codecArgs,         // Use appropriate codec
      '-y',                 // Overwrite output file
      audioPath             // Output to the original file location
    ];

    // Execute the ffmpeg command
    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    let stdoutData = '';
    let stderrData = '';

    ffmpegProcess.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    ffmpegProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        // Success
        res.json({
          success: true,
          message: `Successfully modified audio speed to ${speed}x`,
          filename: filename
        });
      } else {
        // Error
        console.error(`Error modifying audio speed: ${stderrData}`);
        res.status(500).json({
          success: false,
          error: `Error modifying audio speed: ffmpeg process exited with code ${code}`
        });
      }
    });
  } catch (error) {
    console.error(`Error in modifyAudioSpeed: ${error.message}`);
    res.status(500).json({
      success: false,
      error: `Server error: ${error.message}`
    });
  }
};

/**
 * Batch modify the speed of multiple audio files
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
const batchModifyAudioSpeed = async (req, res) => {
  try {
    // Get the filenames and speed factor from the request body
    const { filenames, speedFactor } = req.body;

    if (!filenames || !Array.isArray(filenames) || filenames.length === 0 || !speedFactor) {
      return res.status(400).json({ error: 'Missing required parameters (filenames array, speedFactor)' });
    }

    // Validate speed factor (between 0.5 and 2.0)
    const speed = parseFloat(speedFactor);
    if (isNaN(speed) || speed < 0.5 || speed > 2.0) {
      return res.status(400).json({ error: 'Speed factor must be between 0.5 and 2.0' });
    }

    // Set up response headers for streaming (Server-Sent Events format)
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial response
    res.write(`data: ${JSON.stringify({
      success: true,
      status: 'progress',
      total: filenames.length,
      current: 0,
      message: 'Starting audio speed modification'
    })}\n\n`);

    // Process each file
    const results = [];
    const errors = [];
    let processedCount = 0;

    // Process files sequentially to avoid overwhelming the system
    for (const [index, filename] of filenames.entries()) {
      try {
        // Get the full path to the audio file
        const audioPath = path.join(OUTPUT_AUDIO_DIR, filename);

        // Check if the file exists
        if (!fs.existsSync(audioPath)) {
          errors.push({ filename, error: 'File not found' });
          processedCount++;

          // Send progress update (SSE)
          res.write(`data: ${JSON.stringify({
            success: true,
            status: 'progress',
            total: filenames.length,
            processed: processedCount,
            current: filename,
            message: `File not found: ${filename}`
          })}\n\n`);

          continue;
        }

        // Create a backup of the original file if it doesn't exist already
        const backupFilename = `${path.dirname(filename)}/backup_${path.basename(filename)}`;
        const backupPath = path.join(OUTPUT_AUDIO_DIR, backupFilename);

        if (!fs.existsSync(backupPath)) {
          // Copy the original file to the backup location
          fs.copyFileSync(audioPath, backupPath);
        }

        // Use the backup file as the source to preserve quality
        const sourceFile = fs.existsSync(backupPath) ? backupPath : audioPath;

        // Construct ffmpeg filter complex
        let filterComplex = '';

        if (speed >= 0.5 && speed <= 2.0) {
          filterComplex = `atempo=${speed}`;
        } else if (speed > 2.0 && speed <= 4.0) {
          const halfSpeed = Math.sqrt(speed);
          filterComplex = `atempo=${halfSpeed},atempo=${halfSpeed}`;
        } else if (speed < 0.5 && speed >= 0.25) {
          const halfSpeed = Math.sqrt(speed);
          filterComplex = `atempo=${halfSpeed},atempo=${halfSpeed}`;
        } else {
          errors.push({ filename, error: 'Speed factor must be between 0.25 and 4.0' });
          processedCount++;

          // Send progress update
          res.write(`data: ${JSON.stringify({
            success: true,
            status: 'progress',
            total: filenames.length,
            current: processedCount,
            filename: filename,
            message: `Invalid speed factor for ${filename}`
          })}\n\n`);

          continue;
        }

        // Determine the appropriate codec based on file extension
        const fileExtension = path.extname(audioPath).toLowerCase();
        let codecArgs;

        if (fileExtension === '.mp3') {
          // For MP3 files, use libmp3lame codec
          codecArgs = ['-c:a', 'libmp3lame', '-b:a', '192k'];
        } else if (fileExtension === '.wav') {
          // For WAV files, use pcm_s16le codec
          codecArgs = ['-c:a', 'pcm_s16le', '-ar', '44100'];
        } else {
          // For other formats, let ffmpeg auto-detect
          codecArgs = ['-c:a', 'copy'];
        }

        // Build the ffmpeg command arguments
        const ffmpegArgs = [
          '-i', sourceFile,
          '-filter:a', filterComplex,
          ...codecArgs,         // Use appropriate codec
          '-y',
          audioPath
        ];

        // Send progress update before starting ffmpeg
        res.write(`data: ${JSON.stringify({
          success: true,
          status: 'progress',
          total: filenames.length,
          current: processedCount,
          filename: filename,
          message: `Processing file ${index + 1}/${filenames.length}: ${filename}`
        })}\n\n`);

        // Execute the ffmpeg command and wait for it to complete
        await new Promise((resolve, reject) => {
          const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

          ffmpegProcess.on('close', (code) => {
            if (code === 0) {
              // Success: no longer creating backup_for_trim; single backup_ is sufficient

              results.push({ filename, success: true });
              processedCount++;

              // Send progress update (SSE)
              res.write(`data: ${JSON.stringify({
                success: true,
                status: 'progress',
                total: filenames.length,
                processed: processedCount,
                current: filename,
                message: `Successfully processed ${filename}`
              })}\n\n`);

              resolve();
            } else {
              errors.push({ filename, error: `ffmpeg process exited with code ${code}` });
              processedCount++;

              // Send progress update (SSE)
              res.write(`data: ${JSON.stringify({
                success: true,
                status: 'progress',
                total: filenames.length,
                processed: processedCount,
                current: filename,
                message: `Error processing ${filename}: ffmpeg exited with code ${code}`
              })}\n\n`);

              resolve(); // Still resolve to continue with other files
            }
          });

          ffmpegProcess.on('error', (err) => {
            errors.push({ filename, error: err.message });
            processedCount++;

            // Send progress update (SSE)
            res.write(`data: ${JSON.stringify({
              success: true,
              status: 'progress',
              total: filenames.length,
              processed: processedCount,
              current: filename,
              message: `Error processing ${filename}: ${err.message}`
            })}\n\n`);

            resolve(); // Still resolve to continue with other files
          });
        });
      } catch (error) {
        errors.push({ filename, error: error.message });
        processedCount++;

        // Send progress update (SSE)
        res.write(`data: ${JSON.stringify({
          success: true,
          status: 'progress',
          total: filenames.length,
          processed: processedCount,
          current: filename,
          message: `Error processing ${filename}: ${error.message}`
        })}\n\n`);
      }
    }

    // Send final results
    res.end(`data: ${JSON.stringify({
      success: true,
      status: 'completed',
      total: filenames.length,
      current: processedCount,
      results,
      errors,
      message: 'Audio speed modification complete'
    })}\n\n`);
  } catch (error) {
    console.error(`Error in batchModifyAudioSpeed: ${error.message}`);

    // If headers haven't been sent yet, send a regular error response
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: `Server error: ${error.message}`
      });
    } else {
      // If we've already started streaming, end with an error
      res.end(`data: ${JSON.stringify({
        success: false,
        status: 'error',
        error: `Server error: ${error.message}`
      })}\n\n`);
    }
  }
};

module.exports = {
  modifyAudioSpeed,
  batchModifyAudioSpeed
};
