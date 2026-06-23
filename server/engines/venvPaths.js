/**
 * Single source of truth for where each heavy engine's Python venv lives.
 *
 * Heavy engines install into `.venvs/<id>`. The shared `.venv` is only the light base environment
 * and a temporary launch fallback for pre-existing developer installs.
 */

const path = require('path');
const fs = require('fs');

// Known heavy engines. `base` holds the light always-available bits (flask, edge-tts, gtts, yt-dlp).
const ENGINE_IDS = ['base', 'f5tts', 'chatterbox', 'parakeet', ...require('./asrCatalog').ids()];

const projectRoot = path.resolve(__dirname, '..', '..');

// Packaged Electron ships a prebuilt venv under resources/python-venv/venv (no uv there); the dev
// and .bat installs use the project-root .venv. Mirrors electron/python-services.js resolution.
const isPackaged = () =>
  process.env.ELECTRON_RUN_AS_PACKAGED === '1'
  || (process.execPath || '').includes('One-Click Subtitles Generator.exe');

const resolveSharedVenv = () => {
  if (isPackaged()) {
    const resourcesPath = process.env.ELECTRON_RESOURCES_PATH || process.resourcesPath;
    return path.join(resourcesPath, 'python-venv', 'venv');
  }
  return path.join(projectRoot, '.venv');
};

/**
 * The venv an installer should CREATE/target. `base` (the light flask/edge-tts/gtts/yt-dlp bits, no
 * torch, no conflict risk) stays in the legacy shared `.venv` so the yt-dlp/edge/gtts launchers work
 * unchanged; only the heavy torch engines get their own isolated `.venvs/<id>`.
 */
const getEngineVenvTarget = (id) =>
  (id === 'base' ? path.join(projectRoot, '.venv') : path.join(projectRoot, '.venvs', String(id)));

const getEngineInstallMarker = (id) => path.join(getEngineVenvTarget(id), '.osg-engine-installed.json');

// "Installing" sentinel — kept OUTSIDE the venv dir (in .venvs/.osg-install-state) so `uv venv`
// recreating the venv can't wipe it. If it survives a restart with no success marker, the install
// was interrupted and the half-built venv can be cleaned on next boot.
const installStateDir = path.join(projectRoot, '.venvs', '.osg-install-state');
const getEngineInstallingMarker = (id) => path.join(installStateDir, `${String(id)}.installing.json`);

function markEngineInstalled(id, extra = {}) {
  const marker = getEngineInstallMarker(id);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({
    id,
    installedAt: new Date().toISOString(),
    ...extra,
  }, null, 2));
}

function clearEngineInstallMarker(id) {
  try {
    fs.rmSync(getEngineInstallMarker(id), { force: true });
  } catch (_) {
    // Best effort; a failed delete should not mask the real install error.
  }
}

function markEngineInstalling(id) {
  try {
    fs.mkdirSync(installStateDir, { recursive: true });
    fs.writeFileSync(getEngineInstallingMarker(id), JSON.stringify({ id, startedAt: new Date().toISOString() }));
  } catch (_) { /* best effort */ }
}

function clearEngineInstalling(id) {
  try { fs.rmSync(getEngineInstallingMarker(id), { force: true }); } catch (_) { /* best effort */ }
}

const isEngineInstalling = (id) => fs.existsSync(getEngineInstallingMarker(id));

// Remove a half-built per-engine venv so a failed/cancelled/interrupted install retries clean. Never
// touches the shared base `.venv` (the light yt-dlp/edge/gtts launchers depend on it).
function removeEngineVenv(id) {
  if (id === 'base') return;
  try { fs.rmSync(getEngineVenvTarget(id), { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

/**
 * Resolve the venv directory a launcher should USE for an engine id.
 *  - packaged Electron: the single prebuilt bundled venv (separate track, no per-engine split);
 *  - else: the per-engine .venvs/<id> if it exists;
 *  - else (migration fallback): the legacy shared .venv if it exists, so existing installs keep
 *    working until engines are re-installed per-engine;
 *  - else: the per-engine target (fresh install destination).
 * @param {string} [id] one of ENGINE_IDS
 * @returns {string} absolute path to the venv directory
 */
const getEngineVenv = (id) => {
  if (isPackaged()) return resolveSharedVenv();
  const perEngine = getEngineVenvTarget(id);
  if (fs.existsSync(perEngine)) return perEngine;
  const legacyShared = path.join(projectRoot, '.venv');
  if (fs.existsSync(legacyShared)) return legacyShared;
  return perEngine;
};

module.exports = {
  getEngineVenv,
  getEngineVenvTarget,
  getEngineInstallMarker,
  markEngineInstalled,
  clearEngineInstallMarker,
  getEngineInstallingMarker,
  markEngineInstalling,
  clearEngineInstalling,
  isEngineInstalling,
  removeEngineVenv,
  ENGINE_IDS,
  projectRoot,
  isPackaged,
};
