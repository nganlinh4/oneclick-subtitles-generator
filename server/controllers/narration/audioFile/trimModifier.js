/**
 * Module for trimming audio files using ffmpeg
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Import directory paths
const { OUTPUT_AUDIO_DIR } = require('../directoryManager');

/**
 * Minimal ffprobe helper to get duration in seconds
 */
const runFfprobe = (filePath) => new Promise((resolve, reject) => {
  try {
    const args = ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1', filePath];
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
  } catch (e) {
    reject(e);
  }
});

// Shared codec args util
const { getCodecArgs } = require('./audioUtils');

/**
 * Ensure we have a sole immutable backup_<filename> created from the first generated audio.
 * Always use this backup file as the source for any subsequent trim/speed adjustments.
 */
const ensureBackupAndGetSource = (filename) => {
  const audioPath = path.join(OUTPUT_AUDIO_DIR, filename);
  const dir = path.dirname(filename);
  const base = path.basename(filename);

  // Preferred source for all edits: backup_<filename>
  const backupFilename = `${dir}/backup_${base}`;
  const backupPath = path.join(OUTPUT_AUDIO_DIR, backupFilename);

  if (!fs.existsSync(backupPath) && fs.existsSync(audioPath)) {
    // First-time: create the backup from the current audio file
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(audioPath, backupPath);
  }

  // Use backup if exists, otherwise fall back to current audio (shouldn't happen often)
  return fs.existsSync(backupPath)
    ? { sourceFile: backupPath, audioPath }
    : { sourceFile: audioPath, audioPath };
};



/**
 * Batch trim multiple audio files
 * Expects body: { items: Array<{ filename: string, start: number, end: number }> }
 * Streams progress similar to batchModifyAudioSpeed
 */
const batchModifyAudioTrim = async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing required parameter: items[]' });
    }

    // Stream headers
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const total = items.length;
    let processed = 0;

    res.write(`data: ${JSON.stringify({ success: true, status: 'progress', total, processed })}\n\n`);

    // Sequential processing for simplicity
    for (const item of items) {
      try {
        const { filename, start, end } = item;
        if (!filename || typeof start !== 'number' || typeof end !== 'number' || !(end > start) || start < 0) {
          processed++;
          res.write(`data: ${JSON.stringify({ success: true, status: 'processing', total, processed, filename, message: 'Invalid params' })}\n\n`);
          continue;
        }

        const { sourceFile, audioPath } = ensureBackupAndGetSource(filename);
        if (!fs.existsSync(sourceFile)) {
          processed++;
          res.write(`data: ${JSON.stringify({ success: true, status: 'processing', total, processed, filename, message: 'File not found' })}\n\n`);
          continue;
        }

        const filters = [];
        filters.push(`atrim=start=${start}:end=${end}`);
        filters.push('asetpts=N/SR/TB');
        const codecArgs = getCodecArgs(audioPath);
        const ffmpegArgs = [
          '-i', sourceFile,
          '-vn',
          '-af', filters.join(','),
          ...codecArgs,
          '-y',
          audioPath
        ];

        await new Promise((resolve) => {
          const ff = spawn('ffmpeg', ffmpegArgs);
          ff.on('close', (code) => {
            processed++;
            if (code === 0) {
              res.write(`data: ${JSON.stringify({ success: true, status: 'processing', total, processed, filename, message: 'Trim applied' })}\n\n`);
            } else {
              res.write(`data: ${JSON.stringify({ success: true, status: 'processing', total, processed, filename, message: `ffmpeg exited ${code}` })}\n\n`);
            }
            resolve();
          });
          ff.on('error', () => {
            processed++;
            res.write(`data: ${JSON.stringify({ success: true, status: 'processing', total, processed, filename, message: 'Spawn error' })}\n\n`);
            resolve();
          });
        });
      } catch (e) {
        processed++;
        res.write(`data: ${JSON.stringify({ success: true, status: 'processing', total, processed, message: e.message })}\n\n`);
      }
    }

    res.end(`data: ${JSON.stringify({ success: true, status: 'completed', total, processed, message: 'Audio trim modification complete' })}\n\n`);
  } catch (error) {
    console.error('batchModifyAudioTrim error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error.message });
    } else {
      res.end(`data: ${JSON.stringify({ success: false, status: 'error', error: error.message })}\n\n`);
    }
  }
};


/**
 * Combined trim + speed modification in a single ffmpeg command.
 * Expects body: { filename: string, speedFactor?: number, normalizedStart: number, normalizedEnd: number }
 * normalizedStart/normalizedEnd must be in [0,1] and are mapped to the backup source duration.
 * Implementation applies trim first in the filter graph (atrim+asetpts) and then speed (atempo), ensuring UI times map to original backup.
 */
const modifyAudioTrimAndSpeedCombined = async (req, res) => {
  try {
    const { filename, speedFactor, normalizedStart, normalizedEnd } = req.body || {};
    if (!filename) {
      return res.status(400).json({ success: false, error: 'Missing required parameter: filename' });
    }

    const { sourceFile, audioPath } = ensureBackupAndGetSource(filename);
    if (!fs.existsSync(sourceFile)) {
      return res.status(404).json({ success: false, error: `Audio file not found: ${filename}` });
    }

    // Require normalized boundaries only
    if (typeof normalizedStart !== 'number' || typeof normalizedEnd !== 'number') {
      return res.status(400).json({ success: false, error: 'normalizedStart and normalizedEnd are required (0..1)' });
    }

    const srcDuration = await runFfprobe(sourceFile).catch(() => null);
    if (!(typeof srcDuration === 'number' && srcDuration > 0)) {
      return res.status(500).json({ success: false, error: 'Failed to read source duration' });
    }

    const ns = Math.max(0, Math.min(1, normalizedStart));
    const ne = Math.max(0, Math.min(1, normalizedEnd));
    const trimStart = ns * srcDuration;
    const trimEnd = ne * srcDuration;

    if (!(trimStart >= 0 && trimEnd > trimStart)) {
      return res.status(400).json({ success: false, error: 'Invalid normalized trim range' });
    }

    // Build audio filter graph: trim then speed
    const filters = [];
    filters.push(`atrim=start=${trimStart}:end=${trimEnd}`);
    filters.push('asetpts=N/SR/TB');

    if (typeof speedFactor === 'number' && !isNaN(speedFactor)) {
      const speed = Number(speedFactor);
      if (speed >= 0.5 && speed <= 2.0) {
        filters.push(`atempo=${speed}`);
      } else if (speed > 2.0 && speed <= 4.0) {
        const half = Math.sqrt(speed);
        filters.push(`atempo=${half}`);
        filters.push(`atempo=${half}`);
      } else if (speed < 0.5 && speed >= 0.25) {
        const half = Math.sqrt(speed);
        filters.push(`atempo=${half}`);
        filters.push(`atempo=${half}`);
      } else {
        return res.status(400).json({ success: false, error: 'Speed factor must be between 0.25 and 4.0' });
      }
    }

    const ffmpegArgs = ['-i', sourceFile, '-vn', '-af', filters.join(','), ...getCodecArgs(audioPath), '-y', audioPath];

    const ff = spawn('ffmpeg', ffmpegArgs);
    let stderrData = '';
    ff.stderr.on('data', (d) => { stderrData += d.toString(); });

    ff.on('close', (code) => {
      if (code === 0) {
        res.json({ success: true, filename, start: trimStart, end: trimEnd, speedFactor, message: 'Edit applied' });
      } else {
        console.error('ffmpeg combined edit error:', stderrData);
        res.status(500).json({ success: false, error: `ffmpeg exited with code ${code}` });
      }
    });
  } catch (error) {
    console.error('modifyAudioTrimAndSpeedCombined error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Batch combined trim + speed modification with SSE progress
 * Body: { items: [{ filename, normalizedStart, normalizedEnd, speedFactor }] }
 */
const batchModifyAudioTrimAndSpeedCombined = async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing required parameter: items[]' });
    }

    // Stream headers
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    console.log('[BatchCombined] Start', { total: items.length });

    const total = items.length;
    let processed = 0;
    const results = [];
    const errors = [];

    res.write(`data: ${JSON.stringify({ success: true, status: 'progress', total, processed, message: 'Starting combined edits' })}\n\n`);

    // Sequential processing
    for (const it of items) {
      const { filename, normalizedStart, normalizedEnd, speedFactor } = it || {};
      const current = filename || '';
      try {
        if (!filename || typeof normalizedStart !== 'number' || typeof normalizedEnd !== 'number') {
          processed++;
          errors.push({ filename: current, error: 'Invalid params' });
          console.log('[BatchCombined] Invalid params', { current, processed, total });
          res.write(`data: ${JSON.stringify({ success: true, status: 'progress', total, processed, current, message: 'Invalid params' })}\n\n`);
          continue;
        }

        const { sourceFile, audioPath } = ensureBackupAndGetSource(filename);
        if (!fs.existsSync(sourceFile)) {
          processed++;
          errors.push({ filename: current, error: 'File not found' });
          console.warn('[BatchCombined] File not found', { current, processed, total });
          res.write(`data: ${JSON.stringify({ success: true, status: 'progress', total, processed, current, message: 'File not found' })}\n\n`);
          continue;
        }

        const srcDuration = await runFfprobe(sourceFile).catch(() => null);
        if (!(typeof srcDuration === 'number' && srcDuration > 0)) {
          processed++;
          errors.push({ filename: current, error: 'Failed to read duration' });
          console.warn('[BatchCombined] Failed to read duration', { current, processed, total });
          res.write(`data: ${JSON.stringify({ success: true, status: 'progress', total, processed, current, message: 'Failed to read duration' })}\n\n`);
          continue;
        }

        const ns = Math.max(0, Math.min(1, normalizedStart));
        const ne = Math.max(0, Math.min(1, normalizedEnd));
        const trimStart = ns * srcDuration;
        const trimEnd = ne * srcDuration;
        if (!(trimStart >= 0 && trimEnd > trimStart)) {
          processed++;
          errors.push({ filename: current, error: 'Invalid normalized trim range' });
          console.warn('[BatchCombined] Invalid trim range', { current, processed, total, trimStart, trimEnd });
          res.write(`data: ${JSON.stringify({ success: true, status: 'progress', total, processed, current, message: 'Invalid trim range' })}\n\n`);
          continue;
        }

        const filters = [];
        filters.push(`atrim=start=${trimStart}:end=${trimEnd}`);
        filters.push('asetpts=N/SR/TB');

        if (typeof speedFactor === 'number' && !isNaN(speedFactor)) {
          const speed = Number(speedFactor);
          if (speed >= 0.5 && speed <= 2.0) {
            filters.push(`atempo=${speed}`);
          } else if (speed > 2.0 && speed <= 4.0) {
            const half = Math.sqrt(speed);
            filters.push(`atempo=${half}`);
            filters.push(`atempo=${half}`);
          } else if (speed < 0.5 && speed >= 0.25) {
            const half = Math.sqrt(speed);
            filters.push(`atempo=${half}`);
            filters.push(`atempo=${half}`);
          } else {
            processed++;
            errors.push({ filename: current, error: 'Invalid speed factor' });
            console.warn('[BatchCombined] Invalid speed factor', { current, processed, total, speedFactor });
            res.write(`data: ${JSON.stringify({ success: true, status: 'progress', total, processed, current, message: 'Invalid speed factor' })}\n\n`);
            continue;
          }
        }

        const ffmpegArgs = ['-i', sourceFile, '-vn', '-af', filters.join(','), ...getCodecArgs(audioPath), '-y', audioPath];

        await new Promise((resolve) => {
          const ff = spawn('ffmpeg', ffmpegArgs);
          ff.on('close', (code) => {
            processed++;
            if (code === 0) {
              results.push({ filename: current, success: true });
              res.write(`data: ${JSON.stringify({ success: true, status: 'progress', total, processed, current, message: 'Edit applied' })}\n\n`);
            } else {
              errors.push({ filename: current, error: `ffmpeg exited ${code}` });
              res.write(`data: ${JSON.stringify({ success: true, status: 'progress', total, processed, current, message: `ffmpeg exited ${code}` })}\n\n`);
            }
            resolve();
          });
          ff.on('error', (e) => {
            processed++;
            errors.push({ filename: current, error: e?.message || 'spawn error' });
            console.error('[BatchCombined] Spawn error', { current, processed, total, error: e?.message });
            res.write(`data: ${JSON.stringify({ success: true, status: 'progress', total, processed, current, message: 'Spawn error' })}\n\n`);
            resolve();
          });
        });
      } catch (e) {
        processed++;
        const msg = e?.message || String(e);
        errors.push({ filename: current, error: msg });
        console.error('[BatchCombined] Item error', { current, processed, total, error: msg });
        res.write(`data: ${JSON.stringify({ success: true, status: 'progress', total, processed, current, message: msg })}\n\n`);
      }
    }

    console.log('[BatchCombined] Completed', { total, processed, resultsCount: results.length, errorsCount: errors.length });
    res.end(`data: ${JSON.stringify({ success: true, status: 'completed', total, processed, results, errors, message: 'Batch combined edits complete' })}\n\n`);
  } catch (error) {
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: error.message });
    }
    res.end(`data: ${JSON.stringify({ success: false, status: 'error', error: error.message })}\n\n`);
  }
};


module.exports = {
  batchModifyAudioTrim,
  modifyAudioTrimAndSpeedCombined,
  batchModifyAudioTrimAndSpeedCombined,
};

