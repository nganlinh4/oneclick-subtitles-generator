#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const catalog = require('../server/engines/asrCatalog');
const { getEngineVenvTarget } = require('../server/engines/venvPaths');

const engineId = process.argv[2];
const row = catalog.byId(engineId);
if (!row) {
  console.error(`Usage: npm run smoke:asr -- <${catalog.ids().join('|')}> [audio-file]`);
  process.exit(2);
}

const audioPath = path.resolve(process.argv[3] || 'server/example-audio/basic_ref_en.wav');
const venv = getEngineVenvTarget(engineId);
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const port = row.port + 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(child) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`engine exited during startup with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch (_) { /* still loading */ }
    await sleep(1000);
  }
  throw new Error('engine did not become healthy within 240 seconds');
}

async function main() {
  for (const required of [python, catalog.entryFile(row), audioPath, catalog.modelDir(row.id)]) {
    if (!fs.existsSync(required)) throw new Error(`required smoke-test path is missing: ${required}`);
  }

  const stderr = [];
  process.env[row.portEnv] = String(port);
  const child = spawn(python, [catalog.entryFile(row)], {
    cwd: catalog.projectRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ASR_PORT: String(port),
      ASR_MODEL_DIR: catalog.modelDir(row.id),
      ASR_RUNTIME: row.runtime,
      ...(row.alignerModelScopeId ? { ASR_ALIGNER_DIR: catalog.alignerDir() } : {}),
    },
  });
  child.stderr.on('data', (chunk) => {
    stderr.push(chunk.toString());
    if (stderr.length > 200) stderr.shift();
  });

  let proxyServer = null;
  try {
    const health = await waitForHealth(child);
    // Exercise the same Express proxy route the browser uses, not just the Python sidecar directly.
    const app = require('../app');
    proxyServer = await new Promise((resolve, reject) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
      server.once('error', reject);
    });
    const proxyPort = proxyServer.address().port;
    const proxyHealth = await fetch(`http://127.0.0.1:${proxyPort}/api/asr/${engineId}/health`);
    if (!proxyHealth.ok) throw new Error(`proxy health check failed with ${proxyHealth.status}`);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/api/asr/${engineId}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio_base64: fs.readFileSync(audioPath).toString('base64'),
        filename: path.basename(audioPath),
        segment_strategy: 'sentence',
        max_chars: 60,
        max_words: 7,
        pause_threshold: 0.8,
        language: 'en',
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(`transcription failed (${response.status}): ${JSON.stringify(body)}`);
    if (!body.transcription || !Array.isArray(body.segments) || body.segments.length === 0) {
      throw new Error(`transcription returned no usable subtitles: ${JSON.stringify(body)}`);
    }
    console.log(JSON.stringify({
      engine: engineId,
      health,
      proxy: 'ok',
      transcription: body.transcription,
      segments: body.segments.length,
      durationSeconds: body.duration_seconds,
    }, null, 2));
  } catch (error) {
    const logs = stderr.join('').trim();
    throw new Error(`${error.message}${logs ? `\nEngine stderr:\n${logs}` : ''}`);
  } finally {
    if (proxyServer) {
      const closed = new Promise((resolve) => proxyServer.close(resolve));
      if (typeof proxyServer.closeAllConnections === 'function') proxyServer.closeAllConnections();
      await closed;
    }
    if (child.exitCode === null) {
      await new Promise((resolve) => {
        const fallback = setTimeout(resolve, 5000);
        child.once('exit', () => { clearTimeout(fallback); resolve(); });
        child.kill();
      });
    }
    delete process.env[row.portEnv];
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
