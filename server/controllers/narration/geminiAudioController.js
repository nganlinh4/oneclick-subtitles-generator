/**
 * Controller for audio processing (Gemini and F5-TTS)
 */

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Import directory paths and functions
const { OUTPUT_AUDIO_DIR, ensureSubtitleDirectory } = require('./directoryManager');

/**
 * Save audio data to disk (common function for both Gemini and F5-TTS)
 * @param {Object} options - Options for saving audio
 * @param {string} options.audioData - Base64 encoded audio data
 * @param {string|number} options.subtitle_id - Subtitle ID
 * @param {number} options.sampleRate - Sample rate of the audio
 * @param {string} options.mimeType - MIME type of the audio
 * @param {string} options.prefix - Prefix for the filename (e.g., 'gemini' or 'f5tts')
 * @returns {Promise<Object>} - Result object with filename and success status
 */
const saveAudioToFile = async (options) => {
  const { audioData, subtitle_id, sampleRate = 24000, mimeType, prefix = '' } = options;

  if (!audioData || !subtitle_id) {
    throw new Error('Missing required data (audioData or subtitle_id)');
  }

  // Ensure the subtitle directory exists
  const subtitleDir = ensureSubtitleDirectory(subtitle_id);

  // Always use 1.wav to override existing narrations for the same video/subtitle set
  // This ensures align-narration always finds the latest narration
  const fileNumber = 1;

  // Generate a filename with optional prefix (but always use 1 as the number)
  const filename = prefix ? `${prefix}_${fileNumber}.wav` : `${fileNumber}.wav`;

  // Full path includes the subtitle directory - use forward slashes for URLs
  const fullFilename = `subtitle_${subtitle_id}/${filename}`;
  const filepath = path.join(subtitleDir, filename);

  // Log if we're overriding an existing file
  if (fs.existsSync(filepath)) {
    console.log(`Overriding existing narration: ${filepath}`);

    // Clear backup audio file created by speed control to prevent dangerous risks
    const backupFilename = `backup_${filename}`;
    const backupPath = path.join(subtitleDir, backupFilename);
    if (fs.existsSync(backupPath)) {
      try {
        fs.unlinkSync(backupPath);
        console.log(`Cleared backup file: ${backupPath}`);
      } catch (backupError) {
        console.warn(`Failed to clear backup file ${backupPath}: ${backupError.message}`);
      }
    }
  }

  // Decode the base64 audio data
  const audioBuffer = Buffer.from(audioData, 'base64');

  // Create file stream
  const fileStream = fs.createWriteStream(filepath);

  // Ensure we're using the correct sample rate
  const actualSampleRate = sampleRate || 24000;

  // Check if the data is already in WAV format
  if (mimeType === 'audio/wav') {
    console.log(`[DEBUG] Writing WAV data directly for subtitle ${subtitle_id}, length: ${audioBuffer.length} bytes`);

    // Check if the WAV header is valid
    if (audioBuffer.length >= 44) {
      const headerStr = audioBuffer.slice(0, 4).toString('utf8');
      console.log(`[DEBUG] WAV header check: ${headerStr}`);

      if (headerStr !== 'RIFF') {
        console.warn(`[DEBUG] WAV data does not start with RIFF header for subtitle ${subtitle_id}`);

        // If the header is invalid, add a proper WAV header
        const wavHeader = createWavHeader(audioBuffer.length, actualSampleRate);
        fileStream.write(wavHeader);
        fileStream.write(audioBuffer);
      } else {
        // Write the WAV file directly
        fileStream.write(audioBuffer);
      }
    } else {
      console.warn(`[DEBUG] WAV data too short for subtitle ${subtitle_id}: ${audioBuffer.length} bytes`);

      // Add a proper WAV header
      const wavHeader = createWavHeader(audioBuffer.length, actualSampleRate);
      fileStream.write(wavHeader);
      fileStream.write(audioBuffer);
    }
  } else {
    // If not in WAV format, assume it's PCM and add WAV header
    console.log(`[DEBUG] Adding WAV header to PCM data for subtitle ${subtitle_id}, length: ${audioBuffer.length} bytes, sample rate: ${actualSampleRate}`);

    // Create WAV header with the correct format
    const wavHeader = createWavHeader(audioBuffer.length, actualSampleRate);

    // Write the WAV file with header
    fileStream.write(wavHeader);
    fileStream.write(audioBuffer);
  }

  // End the file stream
  fileStream.end();

  // Return a promise that resolves when the file is fully written
  return new Promise((resolve, reject) => {
    fileStream.on('finish', () => {
      // Verify the file exists and has content
      try {
        const stats = fs.statSync(filepath);
        console.log(`[DEBUG] Verified file saved: ${filepath}, size: ${stats.size} bytes`);

        // Check if the file is a valid WAV file
        if (stats.size >= 44) { // WAV header is 44 bytes
          const header = Buffer.alloc(12);
          const fd = fs.openSync(filepath, 'r');
          fs.readSync(fd, header, 0, 12, 0);
          fs.closeSync(fd);

          const headerStr = header.toString('utf8', 0, 4);
          console.log(`[DEBUG] WAV header check for saved file: ${headerStr}`);

          if (headerStr !== 'RIFF') {
            console.warn(`[DEBUG] WARNING: Saved file does not have a valid RIFF header: ${filepath}`);

            // Try to fix the file by adding a proper WAV header
            try {
              const fileData = fs.readFileSync(filepath);
              const wavHeader = createWavHeader(fileData.length, actualSampleRate);
              const fixedData = Buffer.concat([wavHeader, fileData]);
              fs.writeFileSync(filepath, fixedData);
              console.log(`[DEBUG] Fixed WAV header for file: ${filepath}`);
            } catch (fixError) {
              console.error(`[DEBUG] Error fixing WAV header: ${fixError.message}`);
            }
          }
        } else {
          console.warn(`[DEBUG] WARNING: Saved file is too small to be a valid WAV file: ${filepath}, size: ${stats.size} bytes`);
        }

        // Return success with the filename
        resolve({
          success: true,
          filename: fullFilename, // Return the path relative to OUTPUT_AUDIO_DIR
          subtitle_id: subtitle_id,
          sampleRate: actualSampleRate
        });
      } catch (statError) {
        console.error(`Error verifying file: ${statError.message}`);
        reject(new Error(`Error verifying audio file: ${statError.message}`));
      }
    });

    fileStream.on('error', (writeError) => {
      console.error(`Error writing file: ${writeError.message}`);
      reject(new Error(`Error writing audio file: ${writeError.message}`));
    });
  });
};

/**
 * Save Gemini audio data to disk (HTTP endpoint handler)
 */
const saveGeminiAudio = async (req, res) => {
  try {
    const { audioData, subtitle_id, sampleRate, mimeType } = req.body;

    if (!audioData || !subtitle_id) {
      console.error('Missing required data');
      return res.status(400).json({ error: 'Missing required data (audioData or subtitle_id)' });
    }

    try {
      const result = await saveAudioToFile({
        audioData,
        subtitle_id,
        sampleRate,
        mimeType,
        prefix: '' // Use empty prefix like F5-TTS and Chatterbox for consistent naming
      });

      res.json(result);
    } catch (error) {
      console.error(`Error saving Gemini audio: ${error.message}`);
      res.status(500).json({ error: `Error saving Gemini audio: ${error.message}` });
    }
  } catch (error) {
    console.error('Error processing Gemini audio:', error);
    res.status(500).json({ error: 'Error processing Gemini audio' });
  }
};

/**
 * Save F5-TTS audio data to disk (HTTP endpoint handler)
 */
const saveF5TTSAudio = async (req, res) => {
  try {
    const { audioData, subtitle_id, sampleRate, mimeType } = req.body;

    if (!audioData || !subtitle_id) {
      console.error('Missing required data');
      return res.status(400).json({ error: 'Missing required data (audioData or subtitle_id)' });
    }

    try {
      // Use empty prefix to generate filenames like "1.wav" instead of "f5tts_1.wav"
      // This matches the expected pattern in alignAudio.js
      const result = await saveAudioToFile({
        audioData,
        subtitle_id,
        sampleRate,
        mimeType,
        prefix: '' // Empty prefix for consistent naming with what's expected
      });

      res.json(result);
    } catch (error) {
      console.error(`Error saving F5-TTS audio: ${error.message}`);
      res.status(500).json({ error: `Error saving F5-TTS audio: ${error.message}` });
    }
  } catch (error) {
    console.error('Error processing F5-TTS audio:', error);
    res.status(500).json({ error: 'Error processing F5-TTS audio' });
  }
};

/**
 * Save Chatterbox audio data to disk (HTTP endpoint handler)
 */
const saveChatterboxAudio = async (req, res) => {
  try {
    const { audioData, subtitle_id, sampleRate, mimeType } = req.body;

    if (!audioData || !subtitle_id) {
      console.error('Missing required data');
      return res.status(400).json({ error: 'Missing required data (audioData or subtitle_id)' });
    }

    try {
      const result = await saveAudioToFile({
        audioData,
        subtitle_id,
        sampleRate,
        mimeType,
        prefix: '' // Use empty prefix like F5-TTS to generate "1.wav" and enable cache loading
      });

      res.json(result);
    } catch (error) {
      console.error(`Error saving Chatterbox audio: ${error.message}`);
      res.status(500).json({ error: `Error saving Chatterbox audio: ${error.message}` });
    }
  } catch (error) {
    console.error('Error processing Chatterbox audio:', error);
    res.status(500).json({ error: 'Error processing Chatterbox audio' });
  }
};

/**
 * Create a WAV header for PCM audio data
 * @param {number} dataLength - Length of the PCM data in bytes
 * @param {number} sampleRate - Sample rate of the audio (default: 24000)
 * @returns {Buffer} - WAV header as a Buffer
 */
const createWavHeader = (dataLength, sampleRate = 24000) => {
  // Gemini returns 16-bit PCM data, mono channel
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  // Create WAV header (44 bytes)
  const header = Buffer.alloc(44);

  // "RIFF" chunk descriptor
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4); // Chunk size (file size - 8)
  header.write('WAVE', 8);

  // "fmt " sub-chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1 size (16 for PCM)
  header.writeUInt16LE(1, 20); // Audio format (1 for PCM)
  header.writeUInt16LE(numChannels, 22); // Number of channels
  header.writeUInt32LE(sampleRate, 24); // Sample rate
  header.writeUInt32LE(byteRate, 28); // Byte rate
  header.writeUInt16LE(blockAlign, 32); // Block align
  header.writeUInt16LE(bitsPerSample, 34); // Bits per sample

  // "data" sub-chunk
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40); // Subchunk2 size (data size)

  console.log(`[DEBUG] Created WAV header for ${dataLength} bytes of PCM data, sample rate: ${sampleRate}`);

  return header;
};

module.exports = {
  saveGeminiAudio,
  saveF5TTSAudio,
  saveChatterboxAudio,
  createWavHeader,
  saveAudioToFile
};
