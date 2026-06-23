/**
 * Generic installer factory for the catalog's GPU ASR engines. ONE factory replaces N copy-pasted
 * installers (CLAUDE.md: a single way to do each thing). Mirrors installers/parakeet.js: create the
 * per-engine venv, install torch (GPU-first via torchProfile, CPU build otherwise), the shared FastAPI
 * service deps, the engine's own pip deps, then pull the model weights from ModelScope into
 * models/asr/<id> and verify the venv imports (+ report GPU availability — GPU is preferred but not
 * required; CPU fallback is allowed, so a missing GPU is a warning, never a failed install).
 *
 * Cancellation: execHelpers honors the engine manager's ambient AbortSignal, so a user-requested
 * cancel stops the in-flight step (incl. a multi-GB ModelScope pull) — no manual signal threading here.
 */

const fs = require('fs');
const { getEngineVenvTarget } = require('../venvPaths');
const { executeWithRetry, runCommand } = require('./execHelpers');
const { installServiceDeps } = require('./serviceDeps');
const torch = require('../torchProfile');
const catalog = require('../asrCatalog');

// One import line per runtime that proves the engine's transcribe stack is importable in the venv.
const VERIFY_IMPORT = {
  'faster-whisper': 'from faster_whisper import WhisperModel',
  transformers: 'import transformers',
  nemo: 'import nemo.collections.asr',  // NeMo (Parakeet-TDT v3 / Nemotron / Canary), wave 2
  onnx: 'import onnxruntime',           // Moonshine, wave 3
};

function makeAsrInstaller(row) {
  async function install({ onLog = () => {} } = {}) {
    const log = (m) => onLog(String(m));
    const logger = {
      info: log, warning: log, progress: log, command: log, success: log,
      found: log, installing: log, subsection: log, step: () => {}, error: log,
    };

    const venv = getEngineVenvTarget(row.id);
    const modelDir = catalog.modelDir(row.id);

    // 1) Per-engine venv.
    logger.subsection(`Creating ${row.label} venv`);
    await runCommand('uv', ['venv', venv, '-p', 'python3.11'], { label: `${row.id} venv create`, logger });

    // 2) torch — GPU-first (CUDA wheel when an NVIDIA GPU is present), CPU build otherwise. CTranslate2
    //    (faster-whisper) and onnxruntime find their CUDA/cuDNN DLLs from torch's bundled libs.
    const { profile, installNotes } = torch.resolveTorchProfile(logger);
    logger.installing(`PyTorch (${profile.description})`);
    if (installNotes) logger.info(installNotes);
    await executeWithRetry('uv', torch.buildTorchInstallArgs(profile, venv, true), { label: 'torch', logger });
    await torch.installTorchCompatibilityPackages(profile, venv, { logger });

    // 3) FastAPI/uvicorn/pydub etc. the service imports (not pulled by the ASR packages).
    await installServiceDeps(venv, { logger });

    // 4) Engine-specific pip deps + the modelscope downloader.
    logger.installing(`${row.label} dependencies`);
    await executeWithRetry(
      'uv',
      ['pip', 'install', '--python', venv, ...row.pyDeps, 'modelscope'],
      { label: `${row.id} deps`, env: { UV_HTTP_TIMEOUT: '600' }, logger }
    );

    // 5) Pull weights from ModelScope (non-gated) into models/asr/<id>. Skip if already present so a
    //    re-install / resumed install doesn't re-download multiple GB.
    fs.mkdirSync(modelDir, { recursive: true });
    const haveWeights = fs.readdirSync(modelDir).length > 0;
    if (haveWeights) {
      logger.info(`Model weights already present at ${modelDir} — skipping download`);
    } else {
      logger.installing(`Downloading model from ModelScope: ${row.modelScopeId}`);
      // Use the `modelscope` console script — `python -m modelscope` is NOT valid (the package has no
      // __main__). `uv run --python <venv> modelscope …` runs the script from the engine venv.
      const dlArgs = ['run', '--python', venv, 'modelscope', 'download',
        '--model', row.modelScopeId, '--local_dir', modelDir];
      if (row.modelScopeRevision && row.modelScopeRevision !== 'master') {
        dlArgs.push('--revision', row.modelScopeRevision);
      }
      await executeWithRetry('uv', dlArgs, {
        label: `${row.id} modelscope download`, env: { UV_HTTP_TIMEOUT: '1800' }, logger,
      });
    }

    // 6) Verify the venv is usable. GPU is preferred but NOT required — report availability, don't fail.
    logger.progress(`Verifying ${row.label} runtime`);
    const importLine = VERIFY_IMPORT[row.runtime] || 'pass';
    // Mirror the service's CUDA-DLL bootstrap (add torch/lib to the DLL search path) BEFORE importing
    // the runtime, so ctranslate2/onnxruntime can find the CUDA/cuDNN DLLs torch bundles — otherwise
    // `from faster_whisper import WhisperModel` (which loads ctranslate2) fails to import on a GPU box.
    const verifyPy = [
      'import sys, os',
      'import torch',
      "torch_lib = os.path.join(os.path.dirname(torch.__file__), 'lib')",
      "if os.name == 'nt' and os.path.isdir(torch_lib):",
      '    try:',
      '        os.add_dll_directory(torch_lib)',
      '    except Exception:',
      '        pass',
      "    os.environ['PATH'] = torch_lib + os.pathsep + os.environ.get('PATH', '')",
      "print('Python:', sys.executable)",
      "print('CUDA available:', torch.cuda.is_available())",
      importLine,
      "print('Import OK for runtime: " + row.runtime + "')",
      "print('OK')",
    ].join('\n');
    await runCommand('uv', ['run', '--python', venv, '--', 'python', '-c', verifyPy], {
      label: `${row.id} verify`, logger,
    });
    logger.success(`${row.label} installed and verified`);
  }

  return { id: row.id, install };
}

// installers map for engineManager: { '<id>': { id, install } }
const asrInstallers = () => Object.fromEntries(catalog.ROWS.map((r) => [r.id, makeAsrInstaller(r)]));

module.exports = { makeAsrInstaller, asrInstallers };
