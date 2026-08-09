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
  {
    id: 'faster-whisper-large-v3',
    label: 'Faster-Whisper Large-v3',
    kind: 'transcription',
    serviceDir: 'asr_services/faster_whisper', // reuses the same sidecar (loads the CT2 dir from env)
    portEnv: 'FW_LARGE_V3_PORT',
    port: 3040,
    runtime: 'faster-whisper',
    modelScopeId: 'keepitsimple/faster-whisper-large-v3', // CTranslate2 build, non-gated mirror
    modelScopeRevision: '24dad542d3c19528ad5abbfdd27639a4edb46e26', // pinned (validated install 2026-06-23)
    pyDeps: ['faster-whisper>=1.1.0'],
    requiredFreeGb: 10,
  },
  {
    id: 'qwen3-asr-1.7b',
    label: 'Qwen3-ASR 1.7B',
    kind: 'transcription',
    serviceDir: 'asr_services/qwen3_asr',
    portEnv: 'QWEN3_ASR_17B_PORT',
    port: 3041,
    runtime: 'qwen-asr',
    modelScopeId: 'Qwen/Qwen3-ASR-1.7B',
    modelScopeRevision: 'd69410f1c275f2b0fa60cbb9960edfcdb0ae0aec', // pinned (validated install 2026-06-23)
    // Word timing comes from a shared companion aligner (downloaded once for all Qwen3-ASR variants).
    alignerModelScopeId: 'Qwen/Qwen3-ForcedAligner-0.6B',
    pyDeps: ['qwen-asr'],
    requiredFreeGb: 14, // ~3.5GB ASR + ~1.5GB aligner + torch + transformers deps
  },
  {
    id: 'qwen3-asr-0.6b',
    label: 'Qwen3-ASR 0.6B',
    kind: 'transcription',
    serviceDir: 'asr_services/qwen3_asr',
    portEnv: 'QWEN3_ASR_06B_PORT',
    port: 3042,
    runtime: 'qwen-asr',
    modelScopeId: 'Qwen/Qwen3-ASR-0.6B',
    modelScopeRevision: '3b885f72b1733a6a50dc17a597fb4135c3d656a0', // pinned (validated install 2026-06-23)
    alignerModelScopeId: 'Qwen/Qwen3-ForcedAligner-0.6B',
    pyDeps: ['qwen-asr'],
    requiredFreeGb: 12, // ~1.8GB ASR + ~1.5GB aligner + torch + deps
  },
];

const byId = (id) => ROWS.find((r) => r.id === String(id)) || null;
const ids = () => ROWS.map((r) => r.id);
const isAsrEngine = (id) => ROWS.some((r) => r.id === String(id));

// Where an engine's weights live after the install-time ModelScope pull; the service reads the same dir.
const modelDir = (id) => path.join(projectRoot, 'models', 'asr', String(id));
// Shared forced-aligner weights for the qwen-asr engines (one copy serves every Qwen3-ASR variant).
const alignerDir = () => path.join(projectRoot, 'models', 'asr', 'qwen3-forced-aligner');

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
  // ASR_PORT is the generic port every sidecar reads (so one shared sidecar serves multiple engines on
  // different ports); ASR_MODEL_DIR/ASR_RUNTIME locate the model; ASR_ALIGNER_DIR for engines that need
  // a separate forced-aligner (qwen-asr).
  extraEnv: {
    ASR_PORT: String(r.port),
    ASR_MODEL_DIR: modelDir(r.id),
    ASR_RUNTIME: r.runtime,
    ...(r.alignerModelScopeId ? { ASR_ALIGNER_DIR: alignerDir() } : {}),
  },
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
  ROWS, byId, ids, isAsrEngine, modelDir, alignerDir, entryFile, entryRel,
  engineDefs, spawnEntries, portsConfig, corsOrigins, requiredFreeGb, projectRoot,
};
