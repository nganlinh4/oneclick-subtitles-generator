/**
 * Routes for narration-related endpoints
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const narrationController = require('../controllers/narrationController');
const narrationServiceClient = require('../services/narrationServiceClient');
const edgeTTSController = require('../controllers/edgeTTSController');
const gttsController = require('../controllers/gttsController');

// Ensure narration directories exist
narrationController.ensureNarrationDirectories();

// Import narration directory from config
const { NARRATION_DIR } = require('../config');

// Set up multer for file uploads
const REFERENCE_AUDIO_DIR = path.join(NARRATION_DIR, 'reference');
const upload = multer({
  dest: REFERENCE_AUDIO_DIR,
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024 // 5GB limit
  }
});

// Serve narration audio files - use * to capture all path segments
router.get('/audio/*', (req, res) => {
  // Extract the filename from the URL path (req.path excludes query string)
  const filename = req.path.replace('/audio/', '');

  // Preserve the original request (headers, range, etc.) and add params
  req.params = { ...(req.params || {}), filename };

  // Call the controller with the real req so Range and headers are available
  narrationController.serveAudioFile(req, res);
});

// Serve reference audio files specifically (for Chatterbox API conversion)
router.get('/reference-audio/:filename', (req, res) => {
  // Call the controller with the filename parameter
  narrationController.serveAudioFile(req, res);
});

// Download all narration audio files as a zip
router.post('/download-all', express.json(), narrationController.downloadAllAudio);

// Download aligned narration audio (one file)
router.post('/download-aligned', express.json(), narrationController.downloadAlignedAudio);

// Record reference audio
router.post('/record-reference', upload.single('audio_data'), narrationController.recordReference);

// Upload reference audio
router.post('/upload-reference', upload.single('file'), narrationController.uploadReference);

// Generate narration
router.post('/generate', narrationController.generateNarration);

// Get narration service status
router.get('/status', narrationController.getNarrationStatus);

// Clear narration output files
router.post('/clear-output', narrationController.clearOutput);

// Clean up old subtitle directories for grouped narrations
router.post('/cleanup-old-directories', express.json(), (req, res) => {
  try {
    const { groupedSubtitles } = req.body;
    const { cleanupOldSubtitleDirectories } = require('../controllers/narration/directoryManager');
    cleanupOldSubtitleDirectories(groupedSubtitles);
    res.json({ success: true, message: 'Old subtitle directories cleaned up successfully' });
  } catch (error) {
    console.error('Error cleaning up old subtitle directories:', error);
    res.status(500).json({ success: false, error: 'Failed to clean up old subtitle directories' });
  }
});

// Save Gemini audio data to disk
router.post('/save-gemini-audio', express.json({ limit: '10mb' }), narrationController.saveGeminiAudio);

// Save F5-TTS audio data to disk
router.post('/save-f5tts-audio', express.json({ limit: '10mb' }), narrationController.saveF5TTSAudio);

// Save Chatterbox audio data to disk
router.post('/save-chatterbox-audio', express.json({ limit: '10mb' }), narrationController.saveChatterboxAudio);

// Modify audio speed
router.post('/modify-audio-speed', express.json(), narrationController.modifyAudioSpeed);

// Batch modify audio speed for multiple files
router.post('/batch-modify-audio-speed', express.json(), narrationController.batchModifyAudioSpeed);

// Combined modify trim + speed (single)
router.post('/modify-audio-trim-speed-combined', express.json(), narrationController.modifyAudioTrimAndSpeedCombined);

// Batch modify audio trim for multiple files
router.post('/batch-modify-audio-trim', express.json(), narrationController.batchModifyAudioTrim);

// Batch combined trim + speed for multiple files
router.post('/batch-modify-audio-trim-speed-combined', express.json(), narrationController.batchModifyAudioTrimAndSpeedCombined);

// Get audio duration (single)
router.post('/get-audio-duration', express.json(), narrationController.getAudioDuration);

// Batch get audio durations
router.post('/batch-get-audio-durations', express.json(), narrationController.batchGetAudioDurations);

// Get list of example audio files
router.get('/example-audio', narrationController.getExampleAudioList);

// Serve example audio files
router.get('/example-audio/:filename', narrationController.serveExampleAudio);

// Upload example audio as reference
router.post('/upload-example-audio', express.json(), narrationController.uploadExampleAudio);

// Edge TTS routes (handled directly by Node.js)
router.get('/edge-tts/voices', edgeTTSController.getVoices);
router.post('/edge-tts/generate', edgeTTSController.generateNarration);

// gTTS routes (handled directly by Node.js)
router.get('/gtts/languages', gttsController.getLanguages);
router.post('/gtts/generate', gttsController.generateNarration);

// Proxy all other narration requests to the Python service
router.use('/', async (req, res, next) => {
  // Skip endpoints we handle directly
  if (req.url === '/status' || req.url === '/download-all' || req.url === '/download-aligned' ||
      req.url === '/generate' || req.url === '/record-reference' || req.url === '/upload-reference' ||
      req.url === '/clear-output' || req.url === '/save-gemini-audio' ||
      req.url === '/save-f5tts-audio' || req.url === '/save-chatterbox-audio' || req.url === '/modify-audio-speed' ||
      req.url === '/batch-modify-audio-speed' || req.url === '/modify-audio-trim' || req.url === '/modify-audio-trim-speed-combined' || req.url === '/batch-modify-audio-trim' || req.url === '/batch-modify-audio-trim-speed-combined' || req.url === '/get-audio-duration' || req.url === '/batch-get-audio-durations' || req.url.startsWith('/audio/') ||
      req.url.startsWith('/edge-tts/') || req.url.startsWith('/gtts/')) {
    return next();
  }

  // Removed proxying log

  // Check if the narration service is available
  const serviceStatus = await narrationServiceClient.checkService();
  if (!serviceStatus.available) {
    // Removed service not available log
    return res.status(503).json({
      success: false,
      error: 'Narration service is not available. Please use npm run dev:cuda to start with Python narration service.'
    });
  }

  // Special handling for multipart form data (file uploads)
  if (req.headers['content-type']?.includes('multipart/form-data')) {
    // Removed multipart form data logging

    // Create a proxy request
    const http = require('http');
    const narrationUrl = `http://localhost:${narrationServiceClient.getNarrationPort()}/api/narration${req.url}`;
    const proxyReq = http.request(narrationUrl, {
      method: req.method,
      headers: req.headers
    });

    // Handle proxy response
    proxyReq.on('response', (proxyRes) => {
      // Removed proxy response logging

      // Copy status and headers
      res.status(proxyRes.statusCode);
      Object.keys(proxyRes.headers).forEach(key => {
        res.setHeader(key, proxyRes.headers[key]);
      });

      // Collect response data
      let responseData = [];
      proxyRes.on('data', (chunk) => {
        // Removed chunk size logging
        responseData.push(chunk);
      });

      proxyRes.on('end', () => {
        const responseBody = Buffer.concat(responseData);
        // Removed response complete logging

        // No JSON parsing for logging
        res.end(responseBody);
      });
    });

    // Handle proxy errors
    proxyReq.on('error', (error) => {
      // Removed proxy error logging
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
  try {
    const options = {
      method: req.method,
      headers: {
        ...req.headers,
        'host': `localhost:${narrationServiceClient.getNarrationPort()}`
      }
    };

    // Forward the request body for POST/PUT requests with JSON data
    if (['POST', 'PUT'].includes(req.method) && req.headers['content-type']?.includes('application/json')) {
      options.body = JSON.stringify(req.body);
    }

    // Handle audio file requests (GET requests to /audio/...)
    if (req.method === 'GET' && req.url.startsWith('/audio/')) {
      try {
        const audioData = await narrationServiceClient.fetchAudioFile(req.url.replace('/audio/', ''));

        // Set content type if available
        if (audioData.contentType) {
          res.setHeader('Content-Type', audioData.contentType);
        }

        // Send the audio data
        res.send(audioData.buffer);
      } catch (error) {
        // Removed audio file error logging
        res.status(502).json({ error: 'Failed to fetch audio file' });
      }
      return;
    }

    // Forward the request to the narration service
    const data = await narrationServiceClient.proxyRequest(req.url, options);

    // Send the response
    if (typeof data === 'string') {
      res.send(data);
    } else {
      res.json(data);
    }
  } catch (error) {
    // Removed proxying error logging
    res.status(502).json({
      error: 'Failed to connect to narration service',
      message: error.message
    });
  }
});

module.exports = router;
