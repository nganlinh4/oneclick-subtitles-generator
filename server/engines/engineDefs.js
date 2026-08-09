/**
 * Metadata for each heavy engine — the single source of truth the engine status probe (and, later,
 * the engine manager/installers) read from. Adding a future engine = one entry here.
 */

const path = require('path');
const { PORTS } = require('../config');
const { projectRoot } = require('./venvPaths');

const ENGINES = [
  {
    id: 'f5tts',
    label: 'F5-TTS',
    port: PORTS.NARRATION,
    entryFile: path.join(projectRoot, 'server', 'narrationApp.py'),
    health: {
      path: '/api/narration/status',
      // F5-TTS reports readiness via a JSON `available` flag (model can still be loading on 200).
      isReady: (status, json) => status === 200 && !!json && json.available === true,
    },
  },
  {
    id: 'chatterbox',
    label: 'Chatterbox',
    port: PORTS.CHATTERBOX,
    entryFile: path.join(projectRoot, 'chatterbox-fastapi', 'start_api.py'),
    health: { path: '/health', isReady: (status) => status === 200 },
  },
  {
    id: 'parakeet',
    label: 'Parakeet',
    port: PORTS.PARAKEET,
    entryFile: path.join(projectRoot, 'parakeet_wrapper', 'app.py'),
    // Parakeet returns 503 until its ASR model is loaded; 200 means ready.
    health: { path: '/health', isReady: (status) => status === 200 },
  },
  // On-demand GPU ASR engines, derived from the catalog (one row per engine).
  ...require('./asrCatalog').engineDefs(),
];

module.exports = { ENGINES };
