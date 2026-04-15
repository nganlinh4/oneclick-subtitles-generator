/**
 * Camb AI controller for oneclick-subtitles-generator (Node/Express side).
 *
 * Uses the real @camb-ai/sdk shape:
 *   - Export is `CambClient`, not `CambAI`.
 *   - Languages are numeric ids — resolve via `client.languages.getSourceLanguages()`
 *     / `getTargetLanguages()` and `startsWith` match on `short_name`.
 *   - Transcription, TTS, and dubbing are task-based: create → poll status → fetch result.
 *   - The streaming `tts-stream` endpoint REQUIRES `voice_id` and (for mars-flash)
 *     an `output_configuration: { format: 'wav', sample_rate: 22050 }` to get real WAV.
 *
 * Auth: CAMB_API_KEY env var.
 */
'use strict';

const fs = require('fs');

let CambClient = null;
try {
  ({ CambClient } = require('@camb-ai/sdk'));
} catch (_) {
  CambClient = null;
}

let _client = null;
function getClient() {
  if (!CambClient) throw Object.assign(new Error('@camb-ai/sdk not installed'), { statusCode: 503 });
  const apiKey = process.env.CAMB_API_KEY;
  if (!apiKey) throw Object.assign(new Error('CAMB_API_KEY not set'), { statusCode: 503 });
  if (!_client) _client = new CambClient({ apiKey });
  return _client;
}

let _srcLangs = null;
let _tgtLangs = null;

function _findLangId(list, code) {
  if (!code || !Array.isArray(list)) return null;
  const low = String(code).toLowerCase();
  const base = low.split(/[-_]/)[0];
  const sn = (l) => (l.short_name || '').toLowerCase();
  return (
    list.find((l) => sn(l) === low)?.id ??
    list.find((l) => sn(l).startsWith(base))?.id ??
    list.find((l) => (l.language || '').toLowerCase().startsWith(base))?.id ??
    null
  );
}

async function resolveSourceLang(code) {
  const c = getClient();
  if (!_srcLangs) _srcLangs = await c.languages.getSourceLanguages();
  return _findLangId(_srcLangs, code);
}

async function resolveTargetLang(code) {
  const c = getClient();
  if (!_tgtLangs) _tgtLangs = await c.languages.getTargetLanguages();
  return _findLangId(_tgtLangs, code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollTask(statusFn, taskId, { intervalMs = 2000, timeoutMs = 900000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await statusFn({ task_id: taskId });
    const status = res?.status;
    if (status === 'SUCCESS') return res.run_id;
    if (status === 'ERROR' || status === 'FAILURE') {
      throw new Error(`Camb task ${taskId} failed: ${JSON.stringify(res?.exception_reason || res?.message || status)}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(`Camb task ${taskId} timed out after ${timeoutMs}ms`);
}

function fmtTs(sec) {
  const ms = Math.max(0, Math.round(Number(sec) * 1000));
  const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const mmm = String(ms % 1000).padStart(3, '0');
  return `${hh}:${mm}:${ss},${mmm}`;
}
function transcriptToSrt(segments) {
  return segments
    .map((s, i) => `${i + 1}\n${fmtTs(s.start)} --> ${fmtTs(s.end)}\n${(s.text || '').trim()}\n`)
    .join('\n');
}

async function transcribeFile(audioPath, language = 'en') {
  const client = getClient();
  const langId = (await resolveSourceLang(language)) ?? 1;
  const stream = fs.createReadStream(audioPath);
  const created = await client.transcription.createTranscription({ media_file: stream, language: langId });
  const taskId = created?.task_id;
  if (!taskId) throw new Error('Camb createTranscription returned no task_id');
  const runId = await pollTask(
    (req) => client.transcription.getTranscriptionTaskStatus(req),
    taskId,
    { intervalMs: 3000 },
  );
  const result = await client.transcription.getTranscriptionResult({ run_id: runId });
  const segs = (result?.transcript || []).map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: s.text || '',
    speaker: s.speaker || '',
  }));
  return {
    text: segs.map((s) => s.text).filter(Boolean).join(' '),
    srt: transcriptToSrt(segs),
    segments: segs,
    language,
  };
}

const DEFAULT_VOICE_ID = Number(process.env.CAMB_DEFAULT_VOICE_ID) || 156549;

async function ttsStream({
  text,
  language = 'en-us',
  speechModel = 'mars-flash',
  voiceId = DEFAULT_VOICE_ID,
} = {}) {
  if (!text || !text.trim()) throw new Error('text is required');
  const apiKey = process.env.CAMB_API_KEY;
  if (!apiKey) throw Object.assign(new Error('CAMB_API_KEY not set'), { statusCode: 503 });
  const body = {
    text,
    language,
    speech_model: speechModel,
    voice_id: voiceId,
    output_configuration: { format: 'wav', sample_rate: 22050 },
  };
  const res = await fetch('https://client.camb.ai/apis/tts-stream', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Camb tts-stream ${res.status}: ${detail}`);
    err.statusCode = res.status;
    throw err;
  }
  return Buffer.from(await res.arrayBuffer());
}

async function dubVideoUrl({ videoUrl, sourceLanguage = 'en', targetLanguage = 'zh' } = {}) {
  if (!videoUrl || !/^https?:\/\//.test(videoUrl)) {
    throw new Error('Camb dubbing requires a public http(s) video_url');
  }
  const client = getClient();
  const srcId = (await resolveSourceLang(sourceLanguage)) ?? 1;
  const tgtId = (await resolveTargetLang(targetLanguage)) ?? 139;
  const created = await client.dub.endToEndDubbing({
    video_url: videoUrl, source_language: srcId, target_language: tgtId,
  });
  const taskId = created?.task_id;
  if (!taskId) throw new Error('Camb endToEndDubbing returned no task_id');
  const runId = await pollTask(
    (req) => client.dub.getEndToEndDubbingStatus(req),
    taskId,
    { intervalMs: 5000, timeoutMs: 1800000 },
  );
  const info = await client.dub.getDubbedRunInfo({ run_id: runId });
  return { runId, info };
}

const getStatus = async (_req, res) => {
  res.json({
    available: !!CambClient && !!process.env.CAMB_API_KEY,
    sdk_installed: !!CambClient,
    api_key_set: !!process.env.CAMB_API_KEY,
  });
};

const transcribe = async (req, res) => {
  try {
    const audioPath = req.body?.audioPath || req.file?.path;
    if (!audioPath) return res.status(400).json({ error: 'audioPath or uploaded file required' });
    const language = req.body?.language || 'en';
    res.json(await transcribeFile(audioPath, language));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
};

const generateNarration = async (req, res) => {
  try {
    const { text, language, voice_id: voiceId, speech_model: speechModel } = req.body || {};
    const wav = await ttsStream({ text, language, speechModel, voiceId });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', wav.length);
    res.send(wav);
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
};

const dub = async (req, res) => {
  try {
    const { video_url: videoUrl, source_language, target_language } = req.body || {};
    res.json(await dubVideoUrl({
      videoUrl, sourceLanguage: source_language, targetLanguage: target_language,
    }));
  } catch (e) {
    res.status(e.statusCode || 500).json({ error: e.message });
  }
};

const getVoices = async (req, res) => {
  try {
    const apiKey = process.env.CAMB_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'CAMB_API_KEY not set' });
    const r = await fetch('https://client.camb.ai/apis/list-voices', { headers: { 'x-api-key': apiKey } });
    if (!r.ok) return res.status(r.status).send(await r.text());
    const body = await r.json();
    const language = req.query?.language;
    const filtered = language
      ? body.filter((v) => String(v.language || '').toLowerCase().includes(String(language).toLowerCase()))
      : body;
    res.json({ count: filtered.length, voices: filtered.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports = {
  getStatus,
  getVoices,
  generateNarration,
  transcribe,
  dub,
  // test-friendly named exports
  transcribeFile,
  ttsStream,
  dubVideoUrl,
};
