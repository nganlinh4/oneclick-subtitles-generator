/**
 * Generic proxy for the catalog's GPU ASR engines — one router for all of them (CLAUDE.md: a single
 * way), keyed by the `:engine` param resolved against asrCatalog. Mirrors parakeetRoutes.js: forwards
 * the real readiness signal (503 when the model isn't loaded) and proxies base64 transcription to the
 * engine's FastAPI service. Mounted under /api in app.js, so the frontend calls:
 *   GET  /api/asr/<engineId>/health
 *   POST /api/asr/<engineId>/transcribe
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const catalog = require('../engines/asrCatalog');

const baseUrlFor = (engineId) => {
  const row = catalog.byId(engineId);
  if (!row) return null;
  const port = parseInt(process.env[row.portEnv], 10) || row.port;
  return `http://127.0.0.1:${port}`;
};

router.get('/asr/:engine/health', async (req, res) => {
  const base = baseUrlFor(req.params.engine);
  if (!base) return res.status(404).json({ success: false, error: `Unknown ASR engine: ${req.params.engine}` });
  try {
    const resp = await axios.get(`${base}/health`, { timeout: 5000, validateStatus: () => true });
    const ready = resp.status >= 200 && resp.status < 300;
    res.status(resp.status).json({ success: ready, service: resp.data });
  } catch (err) {
    res.status(503).json({ success: false, error: err.message || `Failed to reach ${req.params.engine} service` });
  }
});

router.post('/asr/:engine/transcribe', async (req, res) => {
  const base = baseUrlFor(req.params.engine);
  if (!base) return res.status(404).json({ success: false, error: `Unknown ASR engine: ${req.params.engine}` });
  try {
    const { audio_base64, filename, segment_strategy = 'sentence', max_chars = 60, max_words = 7, pause_threshold = 0.8, language } = req.body || {};
    if (!audio_base64 || typeof audio_base64 !== 'string') {
      return res.status(400).json({ success: false, error: 'audio_base64 is required' });
    }
    const payload = {
      audio_base64,
      filename: filename || 'segment.wav',
      segment_strategy,
      max_chars: Math.max(10, Math.min(parseInt(max_chars || 60, 10), 200)),
      max_words: Math.max(-1, Math.min(parseInt(max_words || 7, 10), 50)),
      pause_threshold: Math.max(0.1, Math.min(parseFloat(pause_threshold || 0.8), 5.0)),
    };
    // Optional forced language — accept only a valid ISO 639-1 code (optionally with a region), then
    // pass the 2-letter code the engine expects. Anything else is dropped (engine auto-detects).
    if (typeof language === 'string' && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(language.trim())) {
      payload.language = language.trim().slice(0, 2).toLowerCase();
    }
    const resp = await axios.post(`${base}/transcribe_base64`, payload, { timeout: 1000 * 60 * 10 });
    res.json({ success: true, ...resp.data });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = err.response?.data || { error: err.message };
    res.status(status).json({ success: false, ...detail });
  }
});

module.exports = router;
