/**
 * Single owner of the heavy engines: on-demand install (per-engine venv), start/stop (spawn the
 * engine's Python service from its own venv), and warm-start of already-installed engines at boot.
 * This replaces the old global "is the Python server running" boot gate with per-engine
 * lifecycle, so availability is per-engine at runtime.
 *
 * Install hardening: installs are serialized (one at a time) so two clicks can't race the shared uv
 * cache; each runs a free-disk precheck, streams progress with coarse milestones, can be cancelled,
 * and on failure/cancel its half-built venv is removed. start() waits for the service to actually
 * become healthy (or report that it died) instead of trusting a fixed spawn delay.
 */

const fs = require('fs');
const { spawnEngine } = require('./engineSpawn');
const { ENGINES } = require('./engineDefs');
const { getEnginesStatus, probeHealth } = require('./engineStatus');
const {
  clearEngineInstallMarker, markEngineInstalled, getEngineInstallMarker,
  markEngineInstalling, clearEngineInstalling, isEngineInstalling, removeEngineVenv, projectRoot,
} = require('./venvPaths');
const { setAmbientSignal, clearAmbientSignal } = require('./installers/execHelpers');
const { ensurePortFree } = require('../utils/portManager');

const installers = {
  base: require('./installers/base'),
  f5tts: require('./installers/f5tts'),
  chatterbox: require('./installers/chatterbox'),
  parakeet: require('./installers/parakeet'),
  // On-demand GPU ASR engines share one generic installer factory, registered per catalog row.
  ...require('./installers/asrInstaller').asrInstallers(),
};

// Per-engine runtime state: the spawned child, the most recent install run's progress, and the
// active install's abort controller.
const state = {}; // id -> { child, install: {...}, installAbort }
const stateOf = (id) => (state[id] || (state[id] = { child: null, install: null, installAbort: null }));
const engineDefOf = (id) => ENGINES.find((e) => e.id === id);
const MAX_LOG_LINES = 800;
const START_SPAWN_GRACE_MS = 1500;
// How long start() blocks the HTTP response waiting for /health before returning "pending" (still
// coming up — first run can load models for much longer; the 5s status poll reflects readiness when
// it lands). Kept short so the request never hangs; an early crash/exit within it IS reported as a
// real failure (the realistic CUDA-DLL / model-load crash surfaces within seconds).
const READY_TIMEOUT_MS = 12000;

// Conservative free-space needed per engine (torch + wheels + model weights). Heavy engines pull a
// ~2.5GB torch wheel that unpacks much larger; better to fail fast with a clear message than die
// deep in the wheel write on a too-small clean PC.
const REQUIRED_FREE_GB = { base: 2, f5tts: 8, chatterbox: 8, parakeet: 8, ...require('./asrCatalog').requiredFreeGb() };

// Bump the indeterminate bar to a coarse milestone when a recognizable install step is logged, so a
// 20-30 min install shows real forward motion instead of sitting at 0% then snapping to 100%.
const MILESTONES = [
  [/creating .*venv|venv create/i, 8],
  [/pytorch|torch install|provides cuda|cuda\/cudnn/i, 30],
  [/cloning|onnx-asr|core base dependencies|installing (f5-tts|text-to-speech|parakeet|faster-whisper)|asr service dependencies|turbo dependencies/i, 55],
  [/downloading model from modelscope|modelscope download/i, 68],
  [/installation completed|dependencies installed|installed successfully|installed and verified/i, 78],
  [/verify|verifying/i, 92],
];
function milestonePercent(line) {
  let p = 0;
  for (const [re, val] of MILESTONES) if (re.test(line)) p = Math.max(p, val);
  return p;
}

function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir); // Node >= 18.15
    return st.bavail * st.bsize;
  } catch (e) {
    return null; // unknown (old Node / unsupported FS) -> skip the check rather than block
  }
}

function checkFreeDisk(id) {
  const needGb = REQUIRED_FREE_GB[id] || 6;
  const free = freeBytes(projectRoot);
  if (free != null && free < needGb * 1024 ** 3) {
    const haveGb = (free / 1024 ** 3).toFixed(1);
    throw new Error(`Not enough disk space to install "${id}": needs ~${needGb} GB free, only ${haveGb} GB available.`);
  }
}

// Installs run one at a time (this chain). runInstall never rejects (it captures every error into the
// progress record), so the chain stays healthy across failures. `installsInFlight` tells a new request
// whether it will have to wait behind another.
let installChain = Promise.resolve();
let installsInFlight = 0;

function makeOnLog(record) {
  return (message) => {
    const line = String(message);
    record.log.push(line);
    if (record.log.length > MAX_LOG_LINES) record.log.shift();
    record.percent = Math.max(record.percent, milestonePercent(line));
  };
}

async function runInstall(id, inst, s, controller, onLog) {
  // Everything runs inside try/finally so the in-flight counter is ALWAYS released — including the
  // queued-then-cancelled path (which returns before doing any work).
  try {
    if (controller.signal.aborted) { // cancelled while still waiting in the queue
      s.install.error = 'Cancelled';
      return;
    }
    s.install.queued = false;
    checkFreeDisk(id); // re-check at run time (a queued install may have lost the space)
    clearEngineInstallMarker(id);
    markEngineInstalling(id);
    setAmbientSignal(controller.signal);
    await inst.install({ onLog, signal: controller.signal });
    markEngineInstalled(id);
    s.install.done = true;
    s.install.percent = 100;
    s.install.completedAt = new Date().toISOString();
  } catch (error) {
    const aborted = controller.signal.aborted || (error && error.cancelled);
    s.install.error = aborted ? 'Cancelled' : (error && error.message ? error.message : String(error));
    onLog(`ERROR: ${s.install.error}`);
    removeEngineVenv(id); // drop the partial venv so a retry starts clean (never the shared base .venv)
  } finally {
    clearAmbientSignal();
    clearEngineInstalling(id);
    s.install.queued = false;
    s.install.running = false;
    installsInFlight -= 1;
  }
}

/** Kick off a per-engine install (idempotent while one is running, serialized across engines). */
function install(id) {
  const inst = installers[id];
  if (!inst) throw new Error(`Unknown engine: ${id}`);
  const s = stateOf(id);
  if (s.install && s.install.running) return s.install;

  checkFreeDisk(id); // fast feedback before we even queue (throws -> route surfaces a clear message)

  const controller = new AbortController();
  s.installAbort = controller;
  s.install = { running: true, queued: true, percent: 0, log: [], error: null, done: false, startedAt: new Date().toISOString() };
  const onLog = makeOnLog(s.install);
  if (installsInFlight > 0) onLog('Queued — waiting for another engine install to finish…');
  installsInFlight += 1;

  installChain = installChain.then(() => runInstall(id, inst, s, controller, onLog));
  return s.install;
}

function getInstallProgress(id) {
  const s = state[id];
  return (s && s.install) || { running: false, percent: 0, log: [], done: false, error: null };
}

/** Cancel an in-flight (or queued) install. */
function cancelInstall(id) {
  const s = state[id];
  if (!s || !s.install || !s.install.running) return false;
  if (s.installAbort) s.installAbort.abort();
  if (s.install.queued) { // not started yet — reflect cancellation now; runInstall will skip it
    s.install.error = 'Cancelled';
    s.install.running = false;
  }
  return true;
}

// Resolve once the service is healthy, or report that it died / never came up. Rejecting paths
// (early exit / spawn error) are the real "started but broken" failures the caller cares about; a
// still-loading service after the timeout resolves as { pending } rather than a false failure.
function waitForReady(child, def, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const cleanup = () => { child.off('error', onError); child.off('close', onClose); };
    const finish = (val) => { if (done) return; done = true; cleanup(); resolve(val); };
    const onError = (err) => finish({ ok: false, error: err.message });
    const onClose = (code, signal) => finish({ ok: false, exited: true, code, signal });
    child.once('error', onError);
    child.once('close', onClose);

    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      if (done) return;
      let healthy = false;
      try { healthy = def ? await probeHealth(def) : false; } catch (e) { healthy = false; }
      if (done) return;
      if (healthy) return finish({ ok: true });
      if (Date.now() >= deadline) return finish({ ok: false, pending: true });
      setTimeout(tick, 1500);
    };
    setTimeout(tick, START_SPAWN_GRACE_MS); // let it bind before the first probe
  });
}

/** Spawn the engine's service and wait until it is healthy (or report why it isn't). */
async function start(id) {
  const status = await getEnginesStatus();
  const info = status[id];
  if (!info) throw new Error(`Unknown engine: ${id}`);
  if (info.running) return { child: null, alreadyRunning: true, healthy: true };
  if (!info.installed) throw new Error(`Engine "${id}" is not installed. Install it from Settings > Tools first.`);

  const s = stateOf(id);
  if (s.child && !s.child.killed) return { child: s.child, alreadyRunning: true, healthy: info.running };
  const child = spawnEngine(id);
  if (!child) throw new Error(`Unknown engine: ${id}`);
  s.child = child;
  child.on('close', () => { if (state[id]) state[id].child = null; });

  const ready = await waitForReady(child, engineDefOf(id), READY_TIMEOUT_MS);
  if (ready.exited) {
    throw new Error(`Engine "${id}" exited during startup (code ${ready.code}${ready.signal ? `/${ready.signal}` : ''}). It may have failed to load — try reinstalling it from Settings > Tools.`);
  }
  if (ready.error) {
    throw new Error(`Failed to start engine "${id}": ${ready.error}`);
  }
  return { child, alreadyRunning: false, healthy: !!ready.ok, pending: !!ready.pending };
}

/**
 * Stop the engine's service. We spawn it as `uv run … python …`, so the tracked child is the uv
 * wrapper — on Windows killing it does NOT reap the python grandchild, which keeps the socket bound.
 * So after killing the wrapper we free the engine's port (which expands to descendant PIDs), making
 * the in-app Stop button actually stop the engine and a later Start not hit EADDRINUSE.
 */
async function stop(id) {
  const s = state[id];
  let hadChild = false;
  if (s && s.child) {
    try { s.child.kill(); } catch (e) { /* already gone */ }
    s.child = null;
    hadChild = true;
  }
  const def = engineDefOf(id);
  let freed = false;
  if (def) {
    try { freed = await ensurePortFree(def.port, { label: `engine:${id}` }); } catch (e) { /* best effort */ }
  }
  return hadChild || freed;
}

/** Stop the engine and remove its venv + markers so it reads not-installed again (re-installable). */
async function uninstall(id) {
  if (!installers[id]) throw new Error(`Unknown engine: ${id}`);
  await stop(id);                 // kill the service + free its port first
  removeEngineVenv(id);           // drop the per-engine venv (never the shared base .venv)
  clearEngineInstallMarker(id);
  clearEngineInstalling(id);
  const s = state[id];
  if (s) s.install = null;        // clear any stale in-memory install record
  return true;
}

/** At server boot, start every engine that's installed but not already running. */
async function warmStart() {
  try {
    // Self-heal installs interrupted by a previous crash/restart: an "installing" sentinel with no
    // success marker means a half-built venv — drop it so the engine cleanly reads not-installed.
    for (const id of Object.keys(installers)) {
      try {
        if (isEngineInstalling(id) && !fs.existsSync(getEngineInstallMarker(id))) {
          console.log(`engineManager: cleaning up interrupted install for "${id}"`);
          removeEngineVenv(id);
          clearEngineInstalling(id);
        }
      } catch (e) { /* best effort */ }
    }

    const status = await getEnginesStatus();
    for (const [id, info] of Object.entries(status)) {
      if (info.installed && !info.running && installers[id]) {
        try { await start(id); } catch (e) { console.error(`engineManager warm-start ${id}:`, e.message); }
      }
    }
  } catch (error) {
    console.error('engineManager.warmStart failed:', error.message);
  }
}

module.exports = { install, getInstallProgress, cancelInstall, start, stop, uninstall, warmStart };
