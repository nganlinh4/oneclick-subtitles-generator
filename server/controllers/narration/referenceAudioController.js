/**
 * Controller for reference audio recording and uploading
 */

const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { safeMoveFileSync } = require('../../utils/fileOperations');
const { spawn } = require('child_process');
const fs = require('fs');

// Import directory paths
const { REFERENCE_AUDIO_DIR } = require('./directoryManager');

/**
 * Add 1 second of silence to the end of an audio file using ffmpeg
 * This is required for F5-TTS to avoid truncation issues
 * @param {string} inputPath - Path to the input audio file
 * @param {string} outputPath - Path to save the processed audio file
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
const addSilenceToAudio = (inputPath, outputPath) => {
  return new Promise((resolve, reject) => {
    console.log(`Adding 1s silence to audio: ${inputPath} -> ${outputPath}`);

    // ffmpeg command to add 1 second of silence at the end
    // -f lavfi -t 1 -i anullsrc=channel_layout=stereo:sample_rate=44100 creates 1s of silence
    // [0:a][1:a]concat=n=2:v=0:a=1 concatenates the original audio with the silence
    const ffmpegArgs = [
      '-i', inputPath,
      '-f', 'lavfi', '-t', '1', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1',
      '-y', // Overwrite output file if it exists
      outputPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    let stderr = '';

    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(`Successfully added silence to audio: ${outputPath}`);
        resolve(true);
      } else {
        console.error(`FFmpeg failed with code ${code}`);
        console.error(`FFmpeg stderr: ${stderr}`);
        reject(new Error(`FFmpeg failed with code ${code}: ${stderr}`));
      }
    });

    ffmpeg.on('error', (error) => {
      console.error(`FFmpeg spawn error: ${error.message}`);
      reject(error);
    });
  });
};

/**
 * Record reference audio
 */
const recordReference = async (req, res) => {


  if (!req.file) {
    console.error('No file uploaded');
    return res.status(400).json({ error: 'No audio data' });
  }



  try {
    // Generate a unique filename for temporary file
    const unique_id = uuidv4();
    const temp_filename = `temp_recorded_${unique_id}.wav`;
    const temp_filepath = path.join(REFERENCE_AUDIO_DIR, temp_filename);

    // Copy the recorded file to temporary location
    safeMoveFileSync(req.file.path, temp_filepath);

    // Generate final filename for processed audio
    const filename = `recorded_${unique_id}.wav`;
    const filepath = path.join(REFERENCE_AUDIO_DIR, filename);

    // Add 1 second of silence to the end of the audio for F5-TTS compatibility
    try {
      await addSilenceToAudio(temp_filepath, filepath);

      // Remove the temporary file after successful processing
      fs.unlinkSync(temp_filepath);
      console.log(`Removed temporary file: ${temp_filepath}`);
    } catch (ffmpegError) {
      console.error('FFmpeg preprocessing failed:', ffmpegError.message);

      // Fallback: use the original file without preprocessing
      console.log('Falling back to original audio without silence padding');
      safeMoveFileSync(temp_filepath, filepath);
    }

    // Get reference text if provided
    const reference_text = req.body.reference_text || '';

    // We're now handling transcription directly in the frontend


    // Return success response
    res.json({
      success: true,
      filepath: filepath,
      filename: filename,
      reference_text: reference_text,
      transcribe: false // Indicate that transcription is handled in the frontend
    });
  } catch (error) {
    console.error('Error processing uploaded file:', error);
    res.status(500).json({ error: 'Error processing uploaded file' });
  }
};

/**
 * Upload reference audio
 */
const uploadReference = async (req, res) => {


  if (!req.file) {
    console.error('No file uploaded');
    return res.status(400).json({ error: 'No file part' });
  }



  try {
    // Generate a unique filename for temporary file
    const unique_id = uuidv4();
    const temp_filename = `temp_uploaded_${unique_id}.wav`;
    const temp_filepath = path.join(REFERENCE_AUDIO_DIR, temp_filename);

    // Copy the uploaded file to temporary location
    safeMoveFileSync(req.file.path, temp_filepath);

    // Generate final filename for processed audio
    const filename = `uploaded_${unique_id}.wav`;
    const filepath = path.join(REFERENCE_AUDIO_DIR, filename);

    // Add 1 second of silence to the end of the audio for F5-TTS compatibility
    try {
      await addSilenceToAudio(temp_filepath, filepath);

      // Remove the temporary file after successful processing
      fs.unlinkSync(temp_filepath);
      console.log(`Removed temporary file: ${temp_filepath}`);
    } catch (ffmpegError) {
      console.error('FFmpeg preprocessing failed:', ffmpegError.message);

      // Fallback: use the original file without preprocessing
      console.log('Falling back to original audio without silence padding');
      safeMoveFileSync(temp_filepath, filepath);
    }

    // Get reference text if provided
    const reference_text = req.body.reference_text || '';

    // We're now handling transcription directly in the frontend


    // Return success response
    res.json({
      success: true,
      filepath: filepath,
      filename: filename,
      reference_text: reference_text,
      transcribe: false // Indicate that transcription is handled in the frontend
    });
  } catch (error) {
    console.error('Error processing uploaded file:', error);
    res.status(500).json({ error: 'Error processing uploaded file' });
  }
};

/**
 * Get list of example audio files
 */
const getExampleAudioList = async (_req, res) => {
  try {
    const exampleAudioFiles = [
      {
        filename: 'basic_ref_en.wav',
        displayName: 'basic_ref_en.wav',
        language: 'English',
        description: 'English reference audio'
      },
      {
        filename: 'basic_ref_zh.wav',
        displayName: 'basic_ref_zh.wav',
        language: 'Chinese',
        description: 'Chinese reference audio'
      },
      {
        filename: 'viet_female_south.mp3',
        displayName: 'viet_female_south.mp3',
        language: 'Vietnamese',
        description: 'Vietnamese female south reference audio'
      }
    ];

    res.json({
      success: true,
      files: exampleAudioFiles
    });
  } catch (error) {
    console.error('Error getting example audio list:', error);
    res.status(500).json({ error: 'Error getting example audio list' });
  }
};

/**
 * Serve example audio files from F5-TTS examples directory
 */
const serveExampleAudio = async (req, res) => {
  try {
    const { filename } = req.params;

    // Validate filename to prevent directory traversal
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    // Define the path to example audio directory (main app)
    const exampleAudioPath = path.join(__dirname, '../../../server/example-audio');
    let filePath = path.join(exampleAudioPath, filename);

    // Check if file exists in main app directory
    if (!fs.existsSync(filePath)) {
      // Fallback to F5-TTS directory for existing files
      const f5ttsExamplesPath = path.join(__dirname, '../../../F5-TTS/src/f5_tts/infer/examples/basic');
      filePath = path.join(f5ttsExamplesPath, filename);

      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Example audio file not found' });
      }
    }

    // Determine content type based on file extension
    let contentType = 'audio/wav'; // default
    if (filename.endsWith('.mp3')) {
      contentType = 'audio/mpeg';
    }

    // Serve the file
    res.sendFile(filePath, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
      }
    });
  } catch (error) {
    console.error('Error serving example audio:', error);
    res.status(500).json({ error: 'Error serving example audio file' });
  }
};

/**
 * Upload example audio as reference (simulates real upload)
 */
const uploadExampleAudio = async (req, res) => {
  try {
    const { filename } = req.body;

    // Validate filename
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    // Define the path to example audio directory (main app)
    const exampleAudioPath = path.join(__dirname, '../../../server/example-audio');
    let sourcePath = path.join(exampleAudioPath, filename);

    // Check if source file exists in main app directory
    if (!fs.existsSync(sourcePath)) {
      // Fallback to F5-TTS directory for existing files
      const f5ttsExamplesPath = path.join(__dirname, '../../../F5-TTS/src/f5_tts/infer/examples/basic');
      sourcePath = path.join(f5ttsExamplesPath, filename);

      if (!fs.existsSync(sourcePath)) {
        return res.status(404).json({ error: 'Example audio file not found' });
      }
    }

    // Generate a unique filename for the copied file
    const unique_id = uuidv4();
    const newFilename = `example_${unique_id}.wav`;
    const destinationPath = path.join(REFERENCE_AUDIO_DIR, newFilename);

    // Copy the example file to reference directory
    fs.copyFileSync(sourcePath, destinationPath);

    // Set reference text based on filename
    let reference_text = '';
    if (filename.includes('_en.')) {
      reference_text = 'Some call me nature, others call me mother nature.';
    } else if (filename.includes('_zh.')) {
      reference_text = '对不起，我不会说中文。';
    } else if (filename.includes('viet_')) {
      reference_text = 'Trời ơi hôm nay thiệt là mệt luôn á, tao đi học mà gặp bà cô khó tính, tao chưa kịp học gì hết mà bị la trước lớp quê ơi là quê muốn xỉu luôn á.';
    }

    // Return success response (same format as regular upload)
    res.json({
      success: true,
      filepath: destinationPath,
      filename: newFilename,
      reference_text: reference_text,
      transcribe: false
    });
  } catch (error) {
    console.error('Error uploading example audio:', error);
    res.status(500).json({ error: 'Error uploading example audio' });
  }
};

module.exports = {
  recordReference,
  uploadReference,
  getExampleAudioList,
  serveExampleAudio,
  uploadExampleAudio
};
