const express = require('express');
const router = express.Router();
const axios = require('axios');

// Base URL for the Parakeet FastAPI service
const PARAKEET_BASE_URL = process.env.PARAKEET_BASE_URL || 'http://127.0.0.1:3038';

// Simple health check proxy
router.get('/parakeet/health', async (req, res) => {
  try {
    const resp = await axios.get(`${PARAKEET_BASE_URL}/`);
    res.json({ success: true, service: resp.data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Failed to reach Parakeet service' });
  }
});

// Transcribe a pre-sliced audio segment provided as base64 WAV/MP3/etc.
router.post('/parakeet/transcribe', async (req, res) => {
  try {
    const { audio_base64, filename, segment_strategy = 'sentence', max_chars = 60, max_words = 7, pause_threshold = 0.8 } = req.body || {};

    if (!audio_base64 || typeof audio_base64 !== 'string') {
      return res.status(400).json({ success: false, error: 'audio_base64 is required' });
    }

    const payload = {
      audio_base64,
      filename: filename || 'segment.wav',
      segment_strategy,
      max_chars: Math.max(10, Math.min(parseInt(max_chars || 60, 10), 200)),
      max_words: Math.max(-1, Math.min(parseInt(max_words || 7, 10), 50)),
      pause_threshold: Math.max(0.1, Math.min(parseFloat(pause_threshold || 0.8), 5.0))
    };

    const resp = await axios.post(`${PARAKEET_BASE_URL}/transcribe_base64`, payload, {
      timeout: 1000 * 60 * 10 // up to 10 minutes for long segments
    });

    res.json({ success: true, ...resp.data });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data || { error: err.message };
    res.status(status).json({ success: false, ...detail });
  }
});

module.exports = router;
