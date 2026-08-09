/**
 * Runtime helpers around the shared Gemini catalog.
 *
 * Model IDs, capabilities, defaults, quotas, and migrations belong in
 * geminiModelCatalog.json. Keep this module limited to derived views/helpers.
 */
import catalog from './geminiModelCatalog.json';

const UI_ICONS = [
  { symbol: 'bolt', className: 'model-icon zap-icon' },
  { symbol: 'auto_awesome', className: 'model-icon activity-icon' },
  { symbol: 'psychology', className: 'model-icon star-icon' },
  { symbol: 'memory', className: 'model-icon cpu-icon' },
  { symbol: 'activity_zone', className: 'model-icon activity-icon' },
  { symbol: 'trending_up', className: 'model-icon trending-icon' },
  { symbol: 'precision_manufacturing', className: 'model-icon star-icon' },
  { symbol: 'center_focus_strong', className: 'model-icon star-icon' }
];

const toKeySuffix = (id) => `gemini${id
  .replace(/^gemini-/, '')
  .split(/[^a-zA-Z0-9]+/)
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join('')}`;

const withUiMetadata = (model, index) => {
  const quota = model.quota.requestsPerDay;
  const suffix = toKeySuffix(model.id);
  return {
    ...model,
    nameKey: `models.${suffix}`,
    nameDefault: model.displayName,
    descKey: `models.${suffix}Description`,
    descDefault: `${model.profileLabels.en} · ${model.dailyUse}`,
    icon: UI_ICONS[index % UI_ICONS.length],
    color: model.intelligenceTier >= 6 ? 'var(--md-primary)' : 'var(--md-tertiary)',
    bgColor: model.intelligenceTier >= 6
      ? 'rgba(var(--md-primary-rgb), 0.1)'
      : 'rgba(var(--md-tertiary-rgb), 0.1)',
    freeRPD: quota,
    maxTokens: model.limits.inputTokens
  };
};

export const GEMINI_MODEL_CATALOG = catalog;
export const GEMINI_MODELS = catalog.models.map(withUiMetadata);
export const GEMINI_MODEL_IDS = GEMINI_MODELS.map(({ id }) => id);

export const DEFAULT_GEMINI_MODEL_ID = catalog.defaults.ordinary;
export const DEFAULT_TRANSCRIPTION_MODEL_ID = catalog.defaults.transcription;
export const DEFAULT_TRANSLATION_MODEL_ID = catalog.defaults.translation;
export const DEFAULT_ANALYSIS_MODEL_ID = catalog.defaults.analysis;
export const DEFAULT_BACKGROUND_PROMPT_MODEL_ID = catalog.defaults.backgroundPrompt;
export const DEFAULT_FAST_TEXT_MODEL_ID = catalog.defaults.fastText;
export const DEFAULT_IMAGE_GENERATION_MODEL_ID = catalog.defaults.imageGeneration;
export const DEFAULT_LIVE_AUDIO_MODEL_ID = catalog.defaults.liveAudio;

export const IMAGE_GENERATION_MODELS = catalog.imageGenerationModels;
export const LIVE_AUDIO_MODELS = catalog.liveAudioModels;
export const MEDIA_INPUT_MODALITIES = ['audio', 'video'];

export const getModelById = (id) => GEMINI_MODELS.find((model) => model.id === id);
export const getLiveAudioModelById = (id) => LIVE_AUDIO_MODELS.find((model) => model.id === id);
export const modelAcceptsMedia = (id) => {
  const model = getModelById(catalog.legacyMigrations[id] || id);
  return Boolean(model?.modalities.some((modality) => MEDIA_INPUT_MODALITIES.includes(modality)));
};
export const getModelsForFeature = (feature) =>
  GEMINI_MODELS.filter((model) => model.features.includes(feature));
export const modelSupportsFeature = (id, feature) => {
  const model = getModelById(catalog.legacyMigrations[id] || id);
  return model ? model.features.includes(feature) : true;
};

export const ANALYSIS_MODELS = getModelsForFeature('analysis');
export const ANALYSIS_MODEL_IDS = ANALYSIS_MODELS.map(({ id }) => id);
export const TRANSCRIPTION_MODELS = getModelsForFeature('transcription');
export const TRANSLATION_MODELS = getModelsForFeature('translation');
export const DOCUMENT_MODELS = getModelsForFeature('document');
export const BACKGROUND_PROMPT_MODELS = getModelsForFeature('backgroundPrompt');
export const CONFIGURABLE_THINKING_MODELS = GEMINI_MODELS.filter(
  (model) => model.thinking?.configurable
);

export const isBuiltInGeminiModel = (id) => GEMINI_MODEL_IDS.includes(id);
export const normalizeImageGenerationModelId = (id) =>
  IMAGE_GENERATION_MODELS.some((model) => model.id === id)
    ? id
    : DEFAULT_IMAGE_GENERATION_MODEL_ID;
export const isLegacyGeminiModel = (id) => Boolean(catalog.legacyMigrations[id]);
export const migrateGeminiModelId = (id, fallback = DEFAULT_GEMINI_MODEL_ID) => {
  const normalized = typeof id === 'string' ? id.trim().replace(/^models\//, '') : '';
  if (!normalized) return fallback;
  return catalog.legacyMigrations[normalized] || normalized;
};
/** Resolve media-processing selections to a catalog model proven to accept audio or video. */
export const normalizeMediaModelId = (id, fallback = DEFAULT_TRANSCRIPTION_MODEL_ID) => {
  const normalized = migrateGeminiModelId(id, fallback);
  if (modelAcceptsMedia(normalized)) return normalized;

  const normalizedFallback = migrateGeminiModelId(fallback, DEFAULT_TRANSCRIPTION_MODEL_ID);
  return modelAcceptsMedia(normalizedFallback)
    ? normalizedFallback
    : DEFAULT_TRANSCRIPTION_MODEL_ID;
};
export const isHighIntelligenceModel = (id) =>
  (getModelById(migrateGeminiModelId(id))?.intelligenceTier || 0) >= 6;

/** Migrate only known retired built-ins. Unknown IDs remain valid custom models. */
export const migrateStoredGeminiModels = (storage = null) => {
  const targetStorage = storage || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!targetStorage) return {};
  const migrations = {
    gemini_model: { fallback: DEFAULT_GEMINI_MODEL_ID, requiresMedia: true },
    translation_model: { fallback: DEFAULT_TRANSLATION_MODEL_ID, requiresMedia: false },
    video_analysis_model: { fallback: DEFAULT_ANALYSIS_MODEL_ID, requiresMedia: true },
    video_processing_model: { fallback: DEFAULT_TRANSCRIPTION_MODEL_ID, requiresMedia: true },
    background_prompt_model: { fallback: DEFAULT_BACKGROUND_PROMPT_MODEL_ID, requiresMedia: false }
  };
  const changed = {};

  Object.entries(migrations).forEach(([key, { fallback, requiresMedia }]) => {
    const current = targetStorage.getItem(key);
    if (!current) return;
    const next = requiresMedia
      ? normalizeMediaModelId(current, fallback)
      : migrateGeminiModelId(current, fallback);
    if (next !== current) {
      targetStorage.setItem(key, next);
      changed[key] = next;
    }
  });

  try {
    const rawThinking = targetStorage.getItem('thinking_budgets');
    if (rawThinking) {
      const thinkingValues = JSON.parse(rawThinking);
      let thinkingChanged = false;
      Object.entries(catalog.legacyMigrations).forEach(([legacyId, currentId]) => {
        if (!(legacyId in thinkingValues)) return;
        const profile = getModelById(currentId)?.thinking;
        const legacyValue = thinkingValues[legacyId];
        const compatible = profile?.type === 'level'
          ? profile.options.includes(legacyValue)
          : typeof legacyValue === 'number';
        if (compatible && !(currentId in thinkingValues)) thinkingValues[currentId] = legacyValue;
        delete thinkingValues[legacyId];
        thinkingChanged = true;
      });
      if (thinkingChanged) {
        targetStorage.setItem('thinking_budgets', JSON.stringify(thinkingValues));
      }
    }
  } catch (error) {
    console.warn('Could not migrate saved Gemini thinking settings:', error);
  }
  return changed;
};

export const getDefaultThinkingBudgets = () => Object.fromEntries(
  GEMINI_MODELS
    .filter((model) => model.thinking)
    .map((model) => [model.id, model.thinking.default])
);
