/**
 * Catalog of on-demand GPU ASR engines. ONE row per engine is the single source of truth — the engine
 * registry derives everything else from it (config ports + CORS, engine defs, spawn entries, venv ids,
 * installers, free-disk needs), so adding an ASR engine is appending a row here, not editing six files.
 * The hand-written engines (f5tts / chatterbox / parakeet) stay as they are; these slot in alongside.
 *
 * Weights come from ModelScope (NOT Hugging Face — HF repos can be gated/login-walled for a customer on
 * a clean PC) pulled at install time into models/asr/<id>; the engine's Python service loads from there.
 *
 * `runtime` selects both the installer's extra pip deps and the service's transcribe path:
 *   faster-whisper | transformers | nemo | onnx
 */

const path = require('path');

// Resolve project root locally (NOT via venvPaths) so this module stays dependency-free and venvPaths
// can derive ENGINE_IDS from it without a require cycle.
const projectRoot = path.resolve(__dirname, '..', '..');

const ROWS = [
  {
    id: 'faster-whisper-turbo',
    label: 'Faster-Whisper Turbo',
    kind: 'transcription',
    serviceDir: 'asr_services/faster_whisper', // entry file = <serviceDir>/app.py
    portEnv: 'FW_TURBO_PORT',
    port: 3039, // continues after parakeet (3038)
    runtime: 'faster-whisper',
    // CTranslate2 build of Whisper large-v3 turbo; non-gated ModelScope mirror.
    modelScopeId: 'pengzhendong/faster-whisper-large-v3-turbo',
    modelScopeRevision: 'c312f538745ce1237d0b0c8eef0b81d91ea1fce6', // pinned (master HEAD at validated install 2026-06-23)
    pyDeps: ['faster-whisper>=1.1.0'], // beyond torch + the shared FastAPI service deps
    requiredFreeGb: 10, // ~4.3GB CT2 model + ~2.5GB torch wheel (unpacks larger) + deps headroom
  },
];

const byId = (id) => ROWS.find((r) => r.id === String(id)) || null;
const ids = () => ROWS.map((r) => r.id);
const isAsrEngine = (id) => ROWS.some((r) => r.id === String(id));

// Where an engine's weights live after the install-time ModelScope pull; the service reads the same dir.
const modelDir = (id) => path.join(projectRoot, 'models', 'asr', String(id));

const entryFile = (r) => path.join(projectRoot, ...r.serviceDir.split('/'), 'app.py');
const entryRel = (r) => `${r.serviceDir}/app.py`;

// → engineDefs.js entries. Health is uniform: 200 == ready, 503 while the model is still loading.
const engineDefs = () => ROWS.map((r) => ({
  id: r.id,
  label: r.label,
  port: r.port,
  entryFile: entryFile(r),
  health: { path: '/health', isReady: (status) => status === 200 },
}));

// → engineSpawn.js ENTRIES rows. extraEnv hands the service its model dir + runtime so app.py needs no
// hardcoded paths.
const spawnEntries = () => Object.fromEntries(ROWS.map((r) => [r.id, {
  entry: entryRel(r),
  port: r.port,
  portEnv: r.portEnv,
  args: [],
  extraEnv: { ASR_MODEL_DIR: modelDir(r.id), ASR_RUNTIME: r.runtime },
}]));

// → config.PORTS additions (key = portEnv without the trailing _PORT), honoring env overrides.
const portsConfig = () => Object.fromEntries(ROWS.map((r) => [
  r.portEnv.replace(/_PORT$/, ''),
  parseInt(process.env[r.portEnv], 10) || r.port,
]));

// → config.CORS_ORIGIN localhost/127.0.0.1 pairs for each engine port.
const corsOrigins = () => ROWS.flatMap((r) => [
  `http://localhost:${r.port}`,
  `http://127.0.0.1:${r.port}`,
]);

// → engineManager.REQUIRED_FREE_GB additions.
const requiredFreeGb = () => Object.fromEntries(ROWS.map((r) => [r.id, r.requiredFreeGb || 6]));

module.exports = {
  ROWS, byId, ids, isAsrEngine, modelDir, entryFile, entryRel,
  engineDefs, spawnEntries, portsConfig, corsOrigins, requiredFreeGb, projectRoot,
};
