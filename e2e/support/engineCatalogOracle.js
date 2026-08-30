// Pure, node:test-checkable mirror of the reviewed engine/backend catalogs, so the ASR and
// narration "matrix" journeys (alternateLocalAsrMatrix, narrationEngineMatrix) assert against the
// same source of truth the product ships instead of a hand-maintained guess that could silently
// drift from it.
//
//   ASR catalog:        crates/osg-asr/src/catalog.rs:67-103 (CATALOG, 5 entries)
//   Narration backends:  crates/osg-speech/src/types.rs:11-17 (SpeechBackend: F5Tts, Chatterbox,
//                         EdgeTts, Gtts, GeminiLive)
//   Windows delivery:    crates/osg-engine-packages/delivery/engine-packages.delivery.json
//                         crates/osg-speech/delivery/speech-packages.delivery.json
//   Frontend card id <-> managed-package id mapping:
//                         src/platform/managedEngineCatalog.js:1-33 (only f5tts/f5-tts differ)
//   Card state derivation: src/components/engines/EngineCard.js:67-79
//   Store root wiring: apps/desktop/src-tauri/src/lib.rs (`engine-packages/v1`)
//   On-disk package layout: crates/osg-engine-packages/src/manager.rs (`ensure_component_layout`)
//                         (ensure_component_layout joins the store root with the package id
//                         directly -- ASR and narration/speech packages share ONE store,
//                         `data/engine-packages/v1`, keyed by their own id string)
//
// Every download/installed size and hardware verdict for these entries is recorded in
// docs/rewrite/ENGINE_CATALOG_FEASIBILITY.md, cited back to the same delivery catalogs.

import { join } from 'node:path';

/** The package component directory used by the shipping desktop store. */
export const enginePackageDirectory = (dataRoot, packageId) => (
  join(dataRoot, 'data', 'engine-packages', 'v1', packageId)
);

/**
 * `cardId` is the frontend `[data-engine-id]` value (src/components/engines/EnginesPanel.js).
 * `packageId` is the on-disk/native package id -- identical to cardId for every entry except
 * F5-TTS ('f5tts' card, 'f5-tts' package). `proven` marks the one engine per surface that already
 * has a green real-binary generate-and-verify journey.
 */
export const ASR_CATALOG_ENGINES = Object.freeze([
  Object.freeze({ cardId: 'parakeet', packageId: 'parakeet', proven: false }),
  Object.freeze({ cardId: 'faster-whisper-turbo', packageId: 'faster-whisper-turbo', proven: true }),
  Object.freeze({ cardId: 'faster-whisper-large-v3', packageId: 'faster-whisper-large-v3', proven: false }),
  Object.freeze({ cardId: 'qwen3-asr-1.7b', packageId: 'qwen3-asr-1.7b', proven: false }),
  Object.freeze({ cardId: 'qwen3-asr-0.6b', packageId: 'qwen3-asr-0.6b', proven: false }),
]);

export const NARRATION_CATALOG_ENGINES = Object.freeze([
  Object.freeze({ cardId: 'f5tts', packageId: 'f5-tts', proven: false }),
  Object.freeze({ cardId: 'chatterbox', packageId: 'chatterbox', proven: false }),
  // edge-tts is proven separately by journeys/edgeTtsNarrationGeneration.journey.js, not by the
  // matrix journey's install-then-cancel proof -- it is small enough to install to completion.
  Object.freeze({ cardId: 'edge-tts', packageId: 'edge-tts', proven: true }),
  Object.freeze({ cardId: 'gtts', packageId: 'gtts', proven: true }),
  Object.freeze({ cardId: 'gemini-tts', packageId: 'gemini-tts', proven: false }),
]);

// EngineCard.js:67-79: once a package is installed (state !== 'missing'/'unavailable'), the card
// shows 'ready' (native runtime running) or 'installed-stopped' (not running yet) -- both are
// truthful for "a package directory exists on disk". 'corrupt'/'update-available' also require an
// on-disk presence (a corrupt or updatable package is still an installed one).
const INSTALLED_CARD_STATES = Object.freeze([
  'ready', 'installed-stopped', 'corrupt', 'update-available',
]);
const NOT_INSTALLED_CARD_STATES = Object.freeze(['not-installed']);

/** The set of `data-engine-state` values that are truthful for a given on-disk presence. */
export const expectedCardStatesForPackagePresence = (packageDirectoryExists) => (
  packageDirectoryExists ? [...INSTALLED_CARD_STATES] : [...NOT_INSTALLED_CARD_STATES]
);

/** Whether one observed `data-engine-state` value is consistent with the independent filesystem oracle. */
export const isTruthfulCardState = (domState, packageDirectoryExists) => (
  expectedCardStatesForPackagePresence(packageDirectoryExists).includes(domState)
);

/** States the settle-wait should treat as terminal (i.e. not a transient probe/error). */
export const SETTLED_CARD_STATES = Object.freeze([
  ...INSTALLED_CARD_STATES, ...NOT_INSTALLED_CARD_STATES, 'unavailable',
]);

/** The first catalog entry whose on-disk package directory does not currently exist, or null. */
export const pickNotInstalledEngine = (engines, existsByPackageId) => (
  engines.find(({ packageId }) => existsByPackageId(packageId) === false) ?? null
);
