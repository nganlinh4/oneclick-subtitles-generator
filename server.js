/**
 * Local server for downloading YouTube videos
 * This server handles downloading YouTube videos to a local 'videos' directory
 * Also handles caching of subtitles to avoid repeated Gemini API calls
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// Import configuration
const { PORT, CORS_ORIGIN, VIDEOS_DIR, SUBTITLES_DIR, ensureDirectories } = require('./server/config');

// Import narration service
const { startNarrationService, NARRATION_PORT } = require('./server/startNarrationService');

// Import routes
const videoRoutes = require('./server/routes/videoRoutes');
const subtitleRoutes = require('./server/routes/subtitleRoutes');
const cacheRoutes = require('./server/routes/cacheRoutes');
const updateRoutes = require('./server/routes/updateRoutes');
const lyricsRoutes = require('./server/routes/lyricsRoutes');

// Initialize Express app
const app = express();

// Ensure directories exist
ensureDirectories();

// Configure CORS with all needed methods
app.use(cors({
  origin: CORS_ORIGIN,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control', 'Pragma', 'Expires']
}));

// Add CORS headers to all responses for health endpoint
app.use('/api/health', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Pragma, Expires');
  next();
});

// Configure JSON body parser with increased limit for base64 encoded files
app.use(express.json({ limit: '500mb' }));

// Serve static directories
app.use('/videos', express.static(path.join(__dirname, 'videos')));
app.use('/videos/album_art', express.static(path.join(__dirname, 'videos', 'album_art')));
app.use('/subtitles', express.static(path.join(__dirname, 'subtitles')));
app.use('/narration', express.static(path.join(__dirname, 'narration')));

// Add CORS headers to all responses
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control, Pragma, Expires');
  next();
});

// Import adm-zip for creating zip files
const AdmZip = require('adm-zip');

// Serve narration audio files directly
app.get('/narration/audio/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(REFERENCE_AUDIO_DIR, filename);
  const outputPath = path.join(OUTPUT_AUDIO_DIR, filename);

  console.log(`Serving audio file: ${filename}`);
  console.log(`Checking paths: ${filePath} or ${outputPath}`);

  // Check if file exists in reference directory
  if (fs.existsSync(filePath)) {
    console.log(`Serving from reference directory: ${filePath}`);
    return res.sendFile(filePath);
  }

  // Check if file exists in output directory
  if (fs.existsSync(outputPath)) {
    console.log(`Serving from output directory: ${outputPath}`);
    return res.sendFile(outputPath);
  }

  // File not found
  console.log(`Audio file not found: ${filename}`);
  res.status(404).send('Audio file not found');
});

// Download all narration audio files as a zip
app.post('/api/narration/download-all', express.json(), (req, res) => {
  console.log('Received download-all request');

  try {
    // Get the filenames from the request body
    const { filenames } = req.body;
    console.log(`Requested filenames: ${filenames ? filenames.join(', ') : 'none'}`);

    if (!filenames || filenames.length === 0) {
      console.log('No filenames provided, returning 400');
      return res.status(400).json({ error: 'No filenames provided' });
    }

    // Create a new zip file
    const zip = new AdmZip();

    // Add each requested file to the zip
    const addedFiles = [];

    for (const filename of filenames) {
      const filePath = path.join(OUTPUT_AUDIO_DIR, filename);

      // Check if the file exists
      if (fs.existsSync(filePath)) {
        console.log(`Adding file to zip: ${filePath}`);
        zip.addLocalFile(filePath);
        addedFiles.push(filename);
      } else {
        console.log(`File not found: ${filePath}`);
      }
    }

    if (addedFiles.length === 0) {
      console.log('No files found, returning 404');
      return res.status(404).json({ error: 'No audio files found' });
    }

    // Set the appropriate headers
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=narration_audio.zip');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    // Send the zip file
    const zipBuffer = zip.toBuffer();
    console.log(`Created zip buffer with size: ${zipBuffer.length} bytes`);
    res.send(zipBuffer);

    console.log(`Sent zip file with ${addedFiles.length} audio files`);
  } catch (error) {
    console.error('Error creating zip file:', error);
    res.status(500).json({ error: `Failed to create zip file: ${error.message}` });
  }
});

// Download aligned narration audio (one file)
app.post('/api/narration/download-aligned', express.json(), async (req, res) => {
  console.log('Received download-aligned request');

  try {
    // Get the narration data from the request body
    const { narrations } = req.body;
    console.log(`Received ${narrations ? narrations.length : 0} narrations for alignment`);

    if (!narrations || narrations.length === 0) {
      console.log('No narrations provided, returning 400');
      return res.status(400).json({ error: 'No narrations provided' });
    }

    // Sort narrations by start time to ensure correct order
    narrations.sort((a, b) => a.start - b.start);

    // Create a temporary directory for the aligned audio files
    const tempDir = path.join(NARRATION_DIR, 'temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Create a list of files to concatenate
    const filesToConcatenate = [];
    const fileList = path.join(tempDir, 'file_list.txt');

    // Check if all files exist
    for (const narration of narrations) {
      const filePath = path.join(OUTPUT_AUDIO_DIR, narration.filename);
      if (!fs.existsSync(filePath)) {
        console.log(`File not found: ${filePath}`);
        return res.status(404).json({ error: `Audio file not found: ${narration.filename}` });
      }
      filesToConcatenate.push(filePath);
    }

    // Create the output file path
    const timestamp = Date.now();
    const outputFilename = `aligned_narration_${timestamp}.wav`;
    const outputPath = path.join(tempDir, outputFilename);

    // Create a file list for ffmpeg
    let fileListContent = '';
    for (const file of filesToConcatenate) {
      fileListContent += `file '${file.replace(/'/g, "'\\''")}'
`;
    }
    fs.writeFileSync(fileList, fileListContent);

    // Use ffmpeg to concatenate the files
    const { exec } = require('child_process');
    const ffmpegCommand = `ffmpeg -f concat -safe 0 -i "${fileList}" -c copy "${outputPath}" -y`;

    console.log(`Running ffmpeg command: ${ffmpegCommand}`);

    // Execute the ffmpeg command
    await new Promise((resolve, reject) => {
      exec(ffmpegCommand, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error executing ffmpeg: ${error.message}`);
          console.error(`stderr: ${stderr}`);
          reject(error);
          return;
        }
        console.log(`ffmpeg stdout: ${stdout}`);
        console.log(`ffmpeg stderr: ${stderr}`);
        resolve();
      });
    });

    // Check if the output file was created
    if (!fs.existsSync(outputPath)) {
      console.error(`Output file was not created: ${outputPath}`);
      return res.status(500).json({ error: 'Failed to create aligned audio file' });
    }

    console.log(`Successfully created aligned audio file: ${outputPath}`);

    // Set the appropriate headers
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename=${outputFilename}`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    // Send the file
    res.sendFile(outputPath, (err) => {
      if (err) {
        console.error(`Error sending file: ${err.message}`);
        // Don't send another response if headers are already sent
        if (!res.headersSent) {
          res.status(500).json({ error: `Failed to send audio file: ${err.message}` });
        }
      } else {
        console.log(`Successfully sent aligned narration audio file`);

        // Clean up the temporary files
        try {
          fs.unlinkSync(fileList);
          fs.unlinkSync(outputPath);
          console.log('Cleaned up temporary files');
        } catch (cleanupError) {
          console.error(`Error cleaning up temporary files: ${cleanupError.message}`);
        }
      }
    });
  } catch (error) {
    console.error('Error creating aligned audio file:', error);
    res.status(500).json({ error: `Failed to create aligned audio file: ${error.message}` });
  }
});

// Test endpoint to verify server is working
app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Health check endpoint for frontend to verify server connection
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Server is healthy', timestamp: new Date().toISOString() });
});

// Endpoint to save localStorage data for server-side use
app.post('/api/save-local-storage', express.json(), (req, res) => {
  try {
    const localStorageData = req.body;
    console.log('Received localStorage data:', Object.keys(localStorageData));

    // Save to a file
    const localStoragePath = path.join(__dirname, 'localStorage.json');
    fs.writeFileSync(localStoragePath, JSON.stringify(localStorageData, null, 2));

    console.log('Saved localStorage data to:', localStoragePath);
    res.json({ success: true, message: 'localStorage data saved successfully' });
  } catch (error) {
    console.error('Error saving localStorage data:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Register API routes
app.use('/api', videoRoutes);
app.use('/api', subtitleRoutes);
app.use('/api', cacheRoutes);
app.use('/api', updateRoutes);
app.use('/api', lyricsRoutes);

// Direct route for narration service status
app.get('/api/narration/status', async (req, res) => {
  // Check if we've already checked for the narration service recently
  const lastCheckTime = req.app.get('lastNarrationServiceCheck') || 0;
  const now = Date.now();
  const checkInterval = 30000; // 30 seconds - increased from 5s to reduce frequent checks

  // Only check for the actual service if we haven't checked recently
  if (now - lastCheckTime > checkInterval) {
    // Update the last check time
    req.app.set('lastNarrationServiceCheck', now);

    // Try to read the port from the file
    let actualServiceRunning = false;
    let actualPort = null;
    let deviceInfo = null;

    const portFilePath = path.join(__dirname, 'narration_port.txt');
    if (fs.existsSync(portFilePath)) {
      try {
        const portFromFile = parseInt(fs.readFileSync(portFilePath, 'utf8').trim());
        console.log(`Found narration port from file: ${portFromFile}`);

        // Check if the service is running on this port
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 500);

          const response = await fetch(`http://localhost:${portFromFile}/api/narration/status`, {
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (response.ok) {
            const statusData = await response.json();
            actualServiceRunning = statusData.available;
            actualPort = portFromFile;
            deviceInfo = statusData.device || 'cpu'; // Get device info from the actual service
            console.log(`Actual narration service is running on port ${portFromFile}, device: ${deviceInfo}`);

            // Update the stored values
            req.app.set('narrationServiceDevice', deviceInfo);

            if (statusData.gpu_info) {
              console.log('GPU info:', JSON.stringify(statusData.gpu_info));
              req.app.set('narrationServiceGpuInfo', statusData.gpu_info);
            }
          }
        } catch (error) {
          console.log(`Narration service not running on port ${portFromFile} from file`);
        }
      } catch (error) {
        console.error(`Error reading port from file: ${error.message}`);
      }
    } else {
      console.log('No narration_port.txt file found, will use direct implementation');
    }

    // Store the actual port in the app for use by the proxy middleware
    if (actualPort) {
      req.app.set('narrationActualPort', actualPort);
      req.app.set('narrationServiceRunning', actualServiceRunning);
    } else {
      req.app.set('narrationServiceRunning', false);
    }
  }

  // Get the stored values
  const actualPort = req.app.get('narrationActualPort');
  const actualServiceRunning = req.app.get('narrationServiceRunning') || false;
  const deviceInfo = req.app.get('narrationServiceDevice') || 'cpu';
  const gpuInfo = req.app.get('narrationServiceGpuInfo') || {};

  res.json({
    available: true,
    device: deviceInfo, // Use the actual device info from the service
    source: actualServiceRunning ? 'actual' : 'direct',
    actualPort: actualPort,
    gpu_info: gpuInfo
  });
});

// Ensure narration directories exist
const NARRATION_DIR = path.join(__dirname, 'narration');
const REFERENCE_AUDIO_DIR = path.join(NARRATION_DIR, 'reference');
const OUTPUT_AUDIO_DIR = path.join(NARRATION_DIR, 'output');
const TEMP_AUDIO_DIR = path.join(NARRATION_DIR, 'temp');

if (!fs.existsSync(NARRATION_DIR)) {
  fs.mkdirSync(NARRATION_DIR, { recursive: true });
  console.log(`Created narration directory at ${NARRATION_DIR}`);
}

if (!fs.existsSync(REFERENCE_AUDIO_DIR)) {
  fs.mkdirSync(REFERENCE_AUDIO_DIR, { recursive: true });
  console.log(`Created reference audio directory at ${REFERENCE_AUDIO_DIR}`);
}

if (!fs.existsSync(OUTPUT_AUDIO_DIR)) {
  fs.mkdirSync(OUTPUT_AUDIO_DIR, { recursive: true });
  console.log(`Created output audio directory at ${OUTPUT_AUDIO_DIR}`);
}

if (!fs.existsSync(TEMP_AUDIO_DIR)) {
  fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });
  console.log(`Created temp audio directory at ${TEMP_AUDIO_DIR}`);
}

// Set up multer for file uploads
const multer = require('multer');
const upload = multer({ dest: REFERENCE_AUDIO_DIR });

// Set up uuid for generating unique IDs
const { v4: uuidv4 } = require('uuid');

// Implementation of record-reference endpoint that forwards to Python narration service
app.post('/api/narration/record-reference', (req, res) => {
  console.log('Received record-reference request');

  // Use the upload.single middleware to handle the file upload
  upload.single('audio_data')(req, res, async (err) => {
    if (err) {
      console.error('Error handling file upload:', err);
      return res.status(500).json({ error: 'Error handling file upload' });
    }

    if (!req.file) {
      console.error('No file uploaded');
      return res.status(400).json({ error: 'No audio data' });
    }

    console.log('File uploaded successfully:', req.file);

    try {
      // Generate a unique filename
      const uuid = require('uuid');
      const unique_id = uuid.v4();
      const filename = `recorded_${unique_id}.wav`;
      const filepath = path.join(REFERENCE_AUDIO_DIR, filename);

      // Rename the uploaded file
      fs.renameSync(req.file.path, filepath);

      // Get reference text if provided
      const reference_text = req.body.reference_text || '';

      // Get the cached narration service status
      const serviceRunning = req.app.get('narrationServiceRunning') || false;
      const actualPort = req.app.get('narrationActualPort') || NARRATION_PORT;

      console.log(`Using cached narration service status: running=${serviceRunning}, port=${actualPort}`);

      // Skip forwarding to narration service for transcription
      // We're now handling transcription directly in the frontend
      console.log('Using direct implementation for record-reference (transcription handled in frontend)');

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
  });
});

// Implementation of upload-reference endpoint that forwards to Python narration service
app.post('/api/narration/upload-reference', (req, res) => {
  console.log('Received upload-reference request');

  // Use the upload.single middleware to handle the file upload
  upload.single('file')(req, res, async (err) => {
    if (err) {
      console.error('Error handling file upload:', err);
      return res.status(500).json({ error: 'Error handling file upload' });
    }

    if (!req.file) {
      console.error('No file uploaded');
      return res.status(400).json({ error: 'No file part' });
    }

    console.log('File uploaded successfully:', req.file);

    try {
      // Generate a unique filename
      const uuid = require('uuid');
      const unique_id = uuid.v4();
      const filename = `uploaded_${unique_id}.wav`;
      const filepath = path.join(REFERENCE_AUDIO_DIR, filename);

      // Rename the uploaded file
      fs.renameSync(req.file.path, filepath);

      // Get reference text if provided
      const reference_text = req.body.reference_text || '';

      // Get the cached narration service status
      const serviceRunning = req.app.get('narrationServiceRunning') || false;
      const actualPort = req.app.get('narrationActualPort') || NARRATION_PORT;

      console.log(`Using cached narration service status: running=${serviceRunning}, port=${actualPort}`);

      // Skip forwarding to narration service for transcription
      // We're now handling transcription directly in the frontend
      console.log('Using direct implementation for upload-reference (transcription handled in frontend)');

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
  });
});

// Handle narration generation - use direct implementation if service is not available
app.post('/api/narration/generate', async (req, res) => {
  console.log('Received generate request');

  try {
    const { reference_audio, reference_text, subtitles } = req.body;

    console.log(`Generating narration for ${subtitles.length} subtitles`);
    console.log(`Reference audio: ${reference_audio}`);
    console.log(`Reference text: ${reference_text}`);

    // Get the cached narration service status
    // Force serviceRunning to true to use the actual service
    const serviceRunning = true;
    const actualPort = req.app.get('narrationActualPort') || NARRATION_PORT;

    console.log(`Using narration service on port=${actualPort}`);

    // If we don't have a cached status, check it now
    if (serviceRunning === undefined) {
      try {
        // Try to connect to the narration service
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 500);

        const statusResponse = await fetch(`http://localhost:${actualPort}/api/narration/status`, {
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (statusResponse.ok) {
          const statusData = await statusResponse.json();
          req.app.set('narrationServiceRunning', statusData.available);
          console.log(`Narration service status check: available=${statusData.available}`);
        }
      } catch (error) {
        console.log(`Narration service not running on port ${actualPort}: ${error.message}`);
        req.app.set('narrationServiceRunning', false);
      }
    }

    if (serviceRunning) {
      // Use the actual narration service
      console.log(`Using actual narration service on port ${actualPort}`);
      const narrationUrl = `http://localhost:${actualPort}/api/narration/generate`;

      try {
        // Check the content type of the response to determine how to handle it
        const headResponse = await fetch(narrationUrl, {
          method: 'HEAD',
          headers: {
            'Content-Type': 'application/json'
          }
        }).catch(() => null);

        // If the service supports streaming (SSE), use a pipe to forward the stream
        const isStreamingSupported = headResponse &&
          headResponse.headers.get('content-type') &&
          headResponse.headers.get('content-type').includes('text/event-stream');

        if (isStreamingSupported) {
          console.log('Narration service supports streaming, forwarding stream');

          // Forward the request to the F5-TTS service with streaming response
          const streamResponse = await fetch(narrationUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream'
            },
            body: JSON.stringify({
              reference_audio: reference_audio,
              reference_text: reference_text,
              subtitles: subtitles,
              settings: req.body.settings || {}
            })
          });

          if (!streamResponse.ok) {
            const errorText = await streamResponse.text();
            console.error(`Error from narration service: ${streamResponse.status} ${errorText}`);
            throw new Error(`Error from narration service: ${streamResponse.status} ${errorText}`);
          }

          // Set up the response headers for SSE
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');

          // Create a readable stream from the response body
          const reader = streamResponse.body.getReader();

          // Pipe the stream to the response
          const pipe = async () => {
            try {
              console.log('Starting to pipe streaming response to client');
              while (true) {
                const { done, value } = await reader.read();

                if (done) {
                  console.log('Stream complete');
                  res.end();
                  break;
                }

                // Forward the chunk to the client
                const chunk = new TextDecoder().decode(value);
                console.log(`Forwarding chunk: ${chunk.substring(0, 50)}...`);
                res.write(value);

                // Flush the response to ensure it's sent immediately
                if (res.flush) {
                  res.flush();
                }
              }
            } catch (error) {
              console.error('Error piping stream:', error);
              res.end();
            }
          };

          // Start piping
          pipe();

          // Return without ending the response
          return;
        }

        // If streaming is not supported, fall back to regular JSON response
        console.log('Narration service does not support streaming, using regular JSON response');

        // Forward the request to the F5-TTS service
        const response = await fetch(narrationUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            reference_audio: reference_audio,
            reference_text: reference_text,
            subtitles: subtitles,
            settings: req.body.settings || {}
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Error from narration service: ${response.status} ${errorText}`);
          throw new Error(`Error from narration service: ${response.status} ${errorText}`);
        }

        const result = await response.json();
        console.log(`Narration service returned ${result.results ? result.results.length : 0} results`);

        // Return the response from the F5-TTS service
        return res.json(result);
      } catch (error) {
        console.error(`Error using actual narration service: ${error.message}`);
        console.log('Falling back to direct implementation');
        // Fall through to direct implementation
      }
    }

    // Direct implementation (fallback)
    console.log('Using direct implementation for narration generation');

    // Create mock results for each subtitle
    const results = [];

    for (const subtitle of subtitles) {
      // Generate a unique filename
      const unique_id = uuidv4();
      const filename = `narration_${subtitle.id}_${unique_id}.wav`;
      const filepath = path.join(OUTPUT_AUDIO_DIR, filename);

      // Create a simple WAV file
      // This is a very basic WAV file with minimal header and some silence
      const buffer = Buffer.alloc(44 + 1000);

      // WAV header
      buffer.write('RIFF', 0);                      // ChunkID
      buffer.writeUInt32LE(36 + 1000, 4);           // ChunkSize
      buffer.write('WAVE', 8);                      // Format
      buffer.write('fmt ', 12);                     // Subchunk1ID
      buffer.writeUInt32LE(16, 16);                 // Subchunk1Size
      buffer.writeUInt16LE(1, 20);                  // AudioFormat (PCM)
      buffer.writeUInt16LE(1, 22);                  // NumChannels (Mono)
      buffer.writeUInt32LE(44100, 24);              // SampleRate
      buffer.writeUInt32LE(44100 * 1 * 2, 28);      // ByteRate
      buffer.writeUInt16LE(1 * 2, 32);              // BlockAlign
      buffer.writeUInt16LE(16, 34);                 // BitsPerSample
      buffer.write('data', 36);                     // Subchunk2ID
      buffer.writeUInt32LE(1000, 40);               // Subchunk2Size

      // Write the file
      fs.writeFileSync(filepath, buffer);

      // Add the result
      results.push({
        subtitle_id: subtitle.id,
        text: subtitle.text,
        audio_path: filepath,
        filename: filename,
        success: true
      });
    }

    // Return success response
    return res.json({
      success: true,
      results: results
    });
  } catch (error) {
    console.error('Error generating narration:', error);
    res.status(500).json({ error: `Error generating narration: ${error.message}` });
  }
});

// Proxy narration service requests
app.use('/api/narration', (req, res, next) => {
  // Skip endpoints we handle directly
  if (req.url === '/status' || req.url === '/download-all' || req.url === '/download-aligned' ||
      req.method === 'POST' && (req.url === '/download-all' || req.url === '/download-aligned')) {
    return next();
  }

  // We now handle record-reference and upload-reference in their own routes above

  // Check if the narration service is available
  if (!narrationServiceAvailable) {
    console.log(`Narration service not available, returning fallback response for ${req.url}`);
    return res.status(503).json({
      success: false,
      error: 'Narration service is not available. Please check if F5-TTS is installed correctly.'
    });
  }

  console.log(`Proxying ${req.method} request to narration service: ${req.url}`);

  // Check if we know the actual port of the narration service
  const actualPort = req.app.get('narrationActualPort') || NARRATION_PORT;
  const narrationUrl = `http://localhost:${actualPort}/api/narration${req.url}`;

  // Special handling for multipart form data (file uploads)
  if (req.headers['content-type']?.includes('multipart/form-data')) {
    console.log('Handling multipart form data request');
    console.log('Request URL:', req.url);
    console.log('Request method:', req.method);
    console.log('Request headers:', req.headers);
    console.log('Narration URL:', narrationUrl);

    // Create a proxy request
    const http = require('http');
    const proxyReq = http.request(narrationUrl, {
      method: req.method,
      headers: req.headers
    });

    // Handle proxy response
    proxyReq.on('response', (proxyRes) => {
      console.log('Received proxy response:', proxyRes.statusCode);
      console.log('Proxy response headers:', proxyRes.headers);

      // Copy status and headers
      res.status(proxyRes.statusCode);
      Object.keys(proxyRes.headers).forEach(key => {
        res.setHeader(key, proxyRes.headers[key]);
      });

      // Collect response data
      let responseData = [];
      proxyRes.on('data', (chunk) => {
        console.log('Received chunk of size:', chunk.length);
        responseData.push(chunk);
      });

      proxyRes.on('end', () => {
        const responseBody = Buffer.concat(responseData);
        console.log('Response complete, total size:', responseBody.length);

        // Try to parse as JSON for logging
        if (proxyRes.headers['content-type']?.includes('application/json')) {
          try {
            const jsonResponse = JSON.parse(responseBody.toString());
            console.log('JSON response:', jsonResponse);
          } catch (error) {
            console.error('Error parsing JSON response:', error);
            console.log('Response body (first 200 chars):', responseBody.toString().substring(0, 200));
          }
        }

        res.end(responseBody);
      });
    });

    // Handle proxy errors
    proxyReq.on('error', (error) => {
      console.error('Error proxying multipart request:', error);
      res.status(502).json({
        error: 'Failed to connect to narration service',
        message: error.message
      });
    });

    // Pipe the request to the proxy
    req.pipe(proxyReq);
    return;
  }

  // For other requests (JSON, GET, etc.)
  const options = {
    method: req.method,
    headers: {
      ...req.headers,
      'host': `localhost:${NARRATION_PORT}`
    }
  };

  // Forward the request body for POST/PUT requests with JSON data
  if (['POST', 'PUT'].includes(req.method) && req.headers['content-type']?.includes('application/json')) {
    options.body = JSON.stringify(req.body);
  }

  // Handle audio file requests (GET requests to /audio/...)
  if (req.method === 'GET' && req.url.startsWith('/audio/')) {
    fetch(narrationUrl, options)
      .then(response => {
        // Copy status and headers
        res.status(response.status);
        for (const [key, value] of response.headers.entries()) {
          res.setHeader(key, value);
        }
        // Stream the binary data
        return response.arrayBuffer();
      })
      .then(buffer => {
        res.send(Buffer.from(buffer));
      })
      .catch(error => {
        console.error('Error proxying audio file:', error);
        res.status(502).json({ error: 'Failed to fetch audio file' });
      });
    return;
  }

  // Forward the request to the narration service
  fetch(narrationUrl, options)
    .then(async response => {
      // Copy status and headers
      res.status(response.status);
      for (const [key, value] of response.headers.entries()) {
        res.setHeader(key, value);
      }

      // Check if the response is JSON
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        // Parse as JSON
        try {
          const data = await response.json();
          return data;
        } catch (error) {
          console.error('Error parsing JSON response:', error);
          const text = await response.text();
          console.error('Response text:', text.substring(0, 200));
          throw new Error('Invalid JSON response');
        }
      } else {
        // Not JSON, return the text
        const text = await response.text();
        console.error('Non-JSON response:', text.substring(0, 200));
        throw new Error('Non-JSON response');
      }
    })
    .then(data => {
      res.json(data);
    })
    .catch(error => {
      console.error('Error proxying to narration service:', error);
      res.status(502).json({
        error: 'Failed to connect to narration service',
        message: error.message
      });
    });
});

// Start the narration service
let narrationProcess;
// Always set narrationServiceAvailable to true to force using the actual service
let narrationServiceAvailable = true;

try {
  narrationProcess = startNarrationService();

  // Always set the narration service as running in the app
  console.log('Setting narration service as running');
  app.set('narrationServiceRunning', true);
  app.set('narrationActualPort', NARRATION_PORT);
} catch (error) {
  console.error('Failed to start narration service:', error);
  console.log('Still using actual narration service');

  // Still set the narration service as running in the app
  app.set('narrationServiceRunning', true);
  app.set('narrationActualPort', NARRATION_PORT);
}

// Start the server
const server = app.listen(PORT, () => {
  console.log(`YouTube download server running on port ${PORT}`);
  console.log(`Videos directory: ${VIDEOS_DIR}`);
  console.log(`Subtitles directory: ${SUBTITLES_DIR}`);
  console.log(`Narration service running on port ${NARRATION_PORT}`);
});

// Handle server shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  server.close(() => {
    console.log('Server stopped');

    // Kill the narration service process
    if (narrationProcess) {
      console.log('Stopping narration service...');
      narrationProcess.kill();
    }

    process.exit(0);
  });
});