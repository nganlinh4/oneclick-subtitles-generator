/**
 * Runtime helpers around the shared Gemini catalog.
 *
 * Model IDs, capabilities, defaults, quotas, and migrations belong in
 * geminiModelCatalog.json. Keep this module limited to derived views/helpers.
 */
import catalog from './geminiModelCatalog.json';

const modelNumberOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Newest numeric version first; never reorder the catalog or change a saved/default choice. */
export const sortModelsForDisplay = (models) => [...models].sort((left, right) => {
  const leftVersion = left.id.match(/^gemini-(\d+(?:\.\d+)*)/)?.[1];
  const rightVersion = right.id.match(/^gemini-(\d+(?:\.\d+)*)/)?.[1];
  if (leftVersion && rightVersion) {
    const versionOrder = modelNumberOrder.compare(rightVersion, leftVersion);
    if (versionOrder) return versionOrder;
  } else if (leftVersion || rightVersion) {
    return leftVersion ? -1 : 1;
  }
  return modelNumberOrder.compare(left.id, right.id);
});

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
export const DEFAULT_SPEECH_MODEL_ID = catalog.defaults.speech;

export const IMAGE_GENERATION_MODELS = sortModelsForDisplay(catalog.imageGenerationModels);
export const GEMINI_SPEECH_MODEL_CATALOG = sortModelsForDisplay(catalog.speechModels);
export const GEMINI_SPEECH_MODEL_IDS = GEMINI_SPEECH_MODEL_CATALOG.map(({ id }) => id);
export const MEDIA_INPUT_MODALITIES = ['audio', 'video'];

/** Menu-only quota metadata; the closed control keeps its model name alone. */
export const buildGeminiModelOption = (model, t) => {
  const requests = model.quota?.requestsPerDay;
  const hasDailyLimit = Number.isSafeInteger(requests) && requests >= 0;
  return {
    value: model.id,
    label: model.isCustom
      ? `${model.name} (${t('models.customLabel', 'Custom')})`
      : t(model.nameKey, model.nameDefault),
    trailingLabel: hasDailyLimit
      ? t('models.requestsPerDay', '{{count}} requests/day', { count: requests })
      : '—',
    trailingTitle: hasDailyLimit
      ? t('models.freeDailyQuotaHelp', 'Free-tier reference per Google project, not per key or video. Each chunk and retry uses a request; actual project limits may differ.')
      : t('models.unknownDailyQuota', 'Daily request limit not verified for this model.'),
  };
};

export const getModelById = (id) => GEMINI_MODELS.find((model) => model.id === id);
export const modelAcceptsMedia = (id) => {
  const model = getModelById(catalog.legacyMigrations[id] || id);
  return Boolean(model?.modalities.some((modality) => MEDIA_INPUT_MODALITIES.includes(modality)));
};
export const getModelsForFeature = (feature) =>
  sortModelsForDisplay(GEMINI_MODELS.filter((model) => model.features.includes(feature)));
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
const CUSTOM_GEMINI_MODEL_ID_PATTERN = /^gemini-[a-z0-9](?:[a-z0-9.-]{0,119}[a-z0-9])?$/;

/** Custom IDs are provider model names only, never paths or method-bearing URLs. */
export const normalizeCustomGeminiModelId = (id) => {
  const normalized = typeof id === 'string' ? id.trim() : '';
  return CUSTOM_GEMINI_MODEL_ID_PATTERN.test(normalized)
    && !isBuiltInGeminiModel(normalized)
    ? normalized
    : null;
};

export const isCustomGeminiModelId = (id) => normalizeCustomGeminiModelId(id) !== null;
export const normalizeCustomGeminiModels = (models) => {
  if (!Array.isArray(models)) return [];
  const seen = new Set();
  return models.flatMap((model) => {
    const id = normalizeCustomGeminiModelId(model?.id);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    const name = typeof model.name === 'string' && model.name.trim()
      ? model.name.trim()
      : id;
    return [{ id, name, isCustom: true }];
  });
};
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

  try {
    const rawCustomModels = targetStorage.getItem('custom_gemini_models');
    if (rawCustomModels) {
      const customModels = JSON.parse(rawCustomModels);
      const normalized = normalizeCustomGeminiModels(customModels);
      if (JSON.stringify(normalized) !== JSON.stringify(customModels)) {
        targetStorage.setItem('custom_gemini_models', JSON.stringify(normalized));
        changed.custom_gemini_models = normalized;
      }
    }
  } catch (error) {
    console.warn('Could not migrate saved custom Gemini models:', error);
  }

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
      catalog.models.forEach((model) => {
        if (!(model.id in thinkingValues) || !model.thinking) return;
        const value = thinkingValues[model.id];
        const compatible = model.thinking.type === 'level'
          ? model.thinking.options.includes(value)
          : typeof value === 'number';
        if (!compatible) {
          thinkingValues[model.id] = model.thinking.default;
          thinkingChanged = true;
        }
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
