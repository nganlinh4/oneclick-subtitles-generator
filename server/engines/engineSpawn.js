/**
 * Per-engine Python service spawner. One uniform pattern (uv run --python <engine venv> python
 * <entry>) mirroring scripts/start-all.js, but each engine runs from its OWN venv (getEngineVenv),
 * so the per-engine split holds at runtime. Used by the engine manager for on-demand / warm start.
 *
 * Packaged Electron keeps its own bundled-venv launch path (separate track) — this is the dev/.bat path.
 */

const { spawn } = require('child_process');
const { getEngineVenv, projectRoot } = require('./venvPaths');
const { PORTS } = require('../config');

let trackProcess = () => {};
try { ({ trackProcess } = require('../utils/portManager')); } catch (e) { /* optional */ }

// How to launch each engine's service. F5-TTS and Parakeet read their port from the env; Chatterbox
// takes it as a CLI arg (matching their existing launchers).
const ENTRIES = {
  f5tts: { entry: 'server/narrationApp.py', port: PORTS.NARRATION, portEnv: 'NARRATION_PORT', args: [] },
  chatterbox: { entry: 'chatterbox-fastapi/start_api.py', port: PORTS.CHATTERBOX, args: ['--host', '0.0.0.0', '--port', String(PORTS.CHATTERBOX)] },
  parakeet: { entry: 'parakeet_wrapper/app.py', port: PORTS.PARAKEET, portEnv: 'PARAKEET_PORT', args: [] },
  // On-demand GPU ASR engines, derived from the catalog. Each carries `extraEnv` (model dir + runtime)
  // so the shared FastAPI service needs no hardcoded paths.
  ...require('./asrCatalog').spawnEntries(),
};

/**
 * Spawn an engine's Python service from its own venv. Returns the child process (with .on('error')
 * attached so a missing interpreter rejects instead of crashing the server), or null for unknown ids.
 */
function spawnEngine(id) {
  const def = ENTRIES[id];
  if (!def) return null;

  const venv = getEngineVenv(id);
  const args = ['run', '--python', venv, 'python', def.entry, ...def.args];
  const env = {
    ...process.env,
    CUDA_VISIBLE_DEVICES: process.env.CUDA_VISIBLE_DEVICES || '0',
    PYTORCH_CUDA_ALLOC_CONF: process.env.PYTORCH_CUDA_ALLOC_CONF || 'max_split_size_mb:512',
    // UTF-8 mode so the service's ✅/non-ASCII log output doesn't crash on a cp949 (Korean) console.
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    ...(def.portEnv ? { [def.portEnv]: String(def.port) } : {}),
    // ASR engines pass their model dir + runtime to the service via extraEnv.
    ...(def.extraEnv || {}),
  };

  const stdio = process.env.VERBOSE === 'true' ? 'inherit' : 'ignore';
  const child = spawn('uv', args, { env, stdio, cwd: projectRoot });
  child.on('error', (error) => {
    console.error(`❌ Failed to start engine "${id}":`, error.message);
  });
  if (child.pid) trackProcess(def.port, child.pid, `engine:${id}`);
  return child;
}

module.exports = { spawnEngine, ENTRIES };
