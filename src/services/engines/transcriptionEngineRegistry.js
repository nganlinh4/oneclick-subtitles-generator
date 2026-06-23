/**
 * Single source of truth for transcription METHODS (the frontend counterpart of the backend
 * server/engines/asrCatalog.js). Every method — Gemini ('new'/'old'), Parakeet ('nvidia-parakeet'),
 * and each catalog ASR engine — is one descriptor here, so the method dropdown, the modal options
 * body/footer/button, token counting, availability gating, and the runner dispatch all READ from this
 * registry instead of scattering `method === 'nvidia-parakeet'` / engine-id checks across the app.
 *
 * Descriptor shape:
 *  - id            : method id
 *  - type          : 'gemini' | 'asr'
 *  - labelKey, labelDefault : i18n for the method dropdown (engine name for ASR)
 *  - optionsPanel  : 'gemini' | 'asr'  (which body the modal renders)
 *  - capabilities  : { segmentation, language, tokenCounting }
 *  - availability  : (ctx) => boolean   ctx = { engineStatus (useEngineStatus result), isVercelMode }
 *  - route         : 'parakeet' | 'asr/<id>'  (AsrAdapter endpoint family; ASR only)
 *  - runnerKey     : key into METHOD_RUNNERS (ASR only)
 *  - supportedLanguagesBadges : truthy when the modal should show the static supported-languages strip
 *  - defaultStrategy : default segmentation strategy (ASR only)
 *
 * Adding an ASR engine is one row in asrEngines.js — the descriptor is derived here automatically.
 */

import { ASR_ENGINES } from './asrEngines';

const GEMINI_NEW = {
  id: 'new',
  type: 'gemini',
  labelKey: 'processing.methodNewOption',
  labelDefault: 'Gemini: New Method',
  optionsPanel: 'gemini',
  capabilities: { segmentation: false, language: false, tokenCounting: true },
  availability: () => true,
};

const GEMINI_OLD = {
  id: 'old',
  type: 'gemini',
  labelKey: 'processing.methodOldOption',
  labelDefault: 'Gemini: Old Method',
  optionsPanel: 'gemini',
  capabilities: { segmentation: false, language: false, tokenCounting: true },
  availability: (ctx) => !ctx.isVercelMode,
};

const PARAKEET = {
  id: 'nvidia-parakeet',
  type: 'asr',
  labelKey: 'processing.methodNvidiaParakeet',
  labelDefault: 'Nvidia Parakeet (local)',
  optionsPanel: 'asr',
  route: 'parakeet',
  runnerKey: 'nvidia-parakeet',
  capabilities: { segmentation: true, language: false, tokenCounting: false },
  availability: (ctx) => !!ctx.engineStatus && ctx.engineStatus.isReady('parakeet'),
  supportedLanguagesBadges: true,
  defaultStrategy: 'sentence',
};

const asrDescriptor = (e) => ({
  id: e.id,
  type: 'asr',
  labelKey: null,
  labelDefault: e.name,
  optionsPanel: 'asr',
  route: e.route || `asr/${e.id}`,
  runnerKey: e.id,
  capabilities: { segmentation: true, language: !!e.supportsLanguage, tokenCounting: false },
  availability: (ctx) => !!ctx.engineStatus && ctx.engineStatus.isReady(e.id),
  defaultStrategy: e.defaultStrategy || 'sentence',
});

// Ordered: Gemini methods, Parakeet, then catalog ASR engines (the method-dropdown order).
const DESCRIPTORS = [GEMINI_NEW, GEMINI_OLD, PARAKEET, ...ASR_ENGINES.map(asrDescriptor)];
const BY_ID = Object.fromEntries(DESCRIPTORS.map((d) => [d.id, d]));

export const getEngineDescriptor = (method) => BY_ID[method] || null;
export const getEngineType = (method) => BY_ID[method]?.type || 'gemini';
export const isAsr = (method) => BY_ID[method]?.type === 'asr';
export const supportsTokenCounting = (method) => !!BY_ID[method]?.capabilities?.tokenCounting;
export const supportsLanguage = (method) => !!BY_ID[method]?.capabilities?.language;

// All local (non-Gemini) method ids — for the useSubtitles dispatch/guard (single list).
export const LOCAL_METHOD_IDS = DESCRIPTORS.filter((d) => d.type === 'asr').map((d) => d.id);

/**
 * Ordered descriptors enriched with computed `available` for the method selector.
 * @param {object} engineStatus the useEngineStatus() result ({ isReady, ... })
 * @param {{ isVercelMode?: boolean }} opts
 */
export const buildMethodDescriptors = (engineStatus, { isVercelMode = false } = {}) => {
  const ctx = { engineStatus, isVercelMode };
  return DESCRIPTORS.map((d) => ({ ...d, available: d.availability(ctx) }));
};

export { DESCRIPTORS };
