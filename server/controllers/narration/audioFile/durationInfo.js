/**
 * Module for reading audio duration using ffprobe
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { OUTPUT_AUDIO_DIR } = require('../directoryManager');

const runFfprobe = (filePath) => new Promise((resolve, reject) => {
  const args = [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath
  ];
  const proc = spawn('ffprobe', args);
  let out = '';
  let err = '';
  proc.stdout.on('data', d => out += d.toString());
  proc.stderr.on('data', d => err += d.toString());
  proc.on('close', (code) => {
    if (code === 0) {
      const val = parseFloat(out.trim());
      if (!isNaN(val)) return resolve(val);
      return reject(new Error('Failed to parse duration'));
    }
    reject(new Error(err || `ffprobe exited with code ${code}`));
  });
});

/**
 * Get duration of a single audio file in output folder
 * Body: { filename }
 */
const getAudioDuration = async (req, res) => {
  try {
    const { filename } = req.body || {};
    if (!filename) return res.status(400).json({ success: false, error: 'Missing filename' });
    const audioPath = path.join(OUTPUT_AUDIO_DIR, filename);
    if (!fs.existsSync(audioPath)) return res.status(404).json({ success: false, error: 'File not found' });
    const duration = await runFfprobe(audioPath);
    res.json({ success: true, filename, duration });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Get duration for multiple files
 * Body: { filenames: string[] }
 */
const batchGetAudioDurations = async (req, res) => {
  try {
    const { filenames } = req.body || {};
    if (!Array.isArray(filenames) || filenames.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing filenames[]' });
    }
    const results = {};
    for (const fn of filenames) {
      try {
        const p = path.join(OUTPUT_AUDIO_DIR, fn);
        if (!fs.existsSync(p)) { results[fn] = null; continue; }
        const d = await runFfprobe(p);
        results[fn] = d;
      } catch (_) {
        results[fn] = null;
      }
    }
    res.json({ success: true, durations: results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  getAudioDuration,
  batchGetAudioDurations,
};

