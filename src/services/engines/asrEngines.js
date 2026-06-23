/**
 * Frontend catalog of on-demand local GPU ASR engines — the UI mirror of the backend catalog
 * (server/engines/asrCatalog.js). Keep the ids in sync. Each engine's transcription METHOD id equals
 * its engine id, so the method selectors, the registry (transcriptionEngineRegistry.js), and the
 * useSubtitles dispatch all derive from this one list. Adding an engine = appending one row here.
 *
 * Row fields:
 *  - id, name               : engine id (== method id) + display name
 *  - supportsLanguage       : true if the engine can force a transcription language (else auto-only)
 *  - defaultStrategy         : default segmentation strategy ('sentence' | 'word' | 'char')
 *  - route                  : adapter endpoint family for AsrAdapter -> POST /api/<route>/transcribe
 *
 * (Parakeet predates this catalog and is registered statically in the engine registry with the bespoke
 * method id 'nvidia-parakeet' + route 'parakeet'; it shares the same generic ASR options/flow.)
 */

export const ASR_ENGINES = [
  {
    id: 'faster-whisper-turbo',
    name: 'Faster-Whisper Turbo',
    supportsLanguage: true,
    defaultStrategy: 'sentence',
    route: 'asr/faster-whisper-turbo',
  },
  {
    id: 'faster-whisper-large-v3',
    name: 'Faster-Whisper Large-v3',
    supportsLanguage: true,
    defaultStrategy: 'sentence',
    route: 'asr/faster-whisper-large-v3',
  },
  {
    id: 'qwen3-asr-1.7b',
    name: 'Qwen3-ASR 1.7B',
    supportsLanguage: true,
    defaultStrategy: 'sentence',
    route: 'asr/qwen3-asr-1.7b',
  },
  {
    id: 'qwen3-asr-0.6b',
    name: 'Qwen3-ASR 0.6B',
    supportsLanguage: true,
    defaultStrategy: 'sentence',
    route: 'asr/qwen3-asr-0.6b',
  },
];

export const ASR_METHOD_IDS = ASR_ENGINES.map((e) => e.id);
export const isAsrMethod = (method) => ASR_METHOD_IDS.includes(method);
export const getAsrEngine = (id) => ASR_ENGINES.find((e) => e.id === id) || null;
