/**
 * Central Gemini model configuration — single source of truth.
 * Pure data, no React/JSX. Import from any component or utility.
 *
 * When a model's limits change or a new model is added, edit ONLY this file.
 */

export const GEMINI_MODELS = [
  {
    id: 'gemini-3.1-pro-preview',
    nameKey: 'models.gemini31Pro',
    nameDefault: 'Gemini 3.1 Pro',
    descKey: 'models.newestPro',
    descDefault: 'Newest Pro (Paid)',
    translationDescKey: 'translation.modelGemini31Pro',
    translationDescDefault: 'output length 65536 tokens (usually no splitting needed)',
    settingsLabelKey: 'settings.modelNewestPro',
    settingsLabelDefault: 'Gemini 3.1 Pro (Paid)',
    analysisLabelKey: null,
    icon: { symbol: 'workspace_premium', className: 'model-icon star-icon' },
    color: 'var(--md-tertiary)',
    bgColor: 'rgba(var(--md-tertiary-rgb), 0.1)',
    freeRPD: 0,
    thinking: {
      type: 'level',
      options: ['low', 'medium', 'high'],
      default: 'high'
    }
  },
  {
    id: 'gemini-2.5-pro',
    nameKey: 'models.gemini25Pro',
    nameDefault: 'Gemini 2.5 Pro',
    descKey: 'models.bestAccuracy',
    descDefault: 'Best accuracy (Paid)',
    translationDescKey: 'translation.modelGemini25Pro',
    translationDescDefault: 'output length 65536 tokens (usually no splitting needed)',
    settingsLabelKey: 'settings.modelBestAccuracy',
    settingsLabelDefault: 'Gemini 2.5 Pro (Paid)',
    analysisLabelKey: null,
    icon: { symbol: 'star', className: 'model-icon star-icon' },
    color: 'var(--md-tertiary)',
    bgColor: 'rgba(var(--md-tertiary-rgb), 0.1)',
    freeRPD: 0,
    thinking: {
      type: 'budget',
      min: 128,
      max: 32768,
      allowDisable: false,
      default: -1
    }
  },
  {
    id: 'gemini-3.5-flash',
    nameKey: 'models.gemini35Flash',
    nameDefault: 'Gemini 3.5 Flash',
    descKey: 'models.newestFlash',
    descDefault: 'Newest Flash model',
    translationDescKey: 'translation.modelGemini35Flash',
    translationDescDefault: 'output length 65536 tokens (usually no splitting needed)',
    settingsLabelKey: 'settings.modelGemini35Flash',
    settingsLabelDefault: 'Gemini 3.5 Flash (20 calls/day)',
    analysisLabelKey: null,
    icon: { symbol: 'auto_awesome', className: 'model-icon activity-icon' },
    color: 'var(--md-primary)',
    bgColor: 'rgba(var(--md-primary-rgb), 0.1)',
    freeRPD: 20,
    thinking: {
      type: 'level',
      options: ['minimal', 'low', 'medium', 'high'],
      default: 'high'
    }
  },
  {
    id: 'gemini-3-flash-preview',
    nameKey: 'models.gemini3Flash',
    nameDefault: 'Gemini 3 Flash',
    descKey: 'models.newestGeneration',
    descDefault: 'Newest generation',
    translationDescKey: 'translation.modelGemini3Flash',
    translationDescDefault: 'output length 65536 tokens (usually no splitting needed)',
    settingsLabelKey: 'settings.modelThirdBest',
    settingsLabelDefault: 'Gemini 3 Flash (20 calls/day)',
    analysisLabelKey: 'settings.modelFlash3',
    analysisLabelDefault: 'Gemini 3 Flash (Newest)',
    icon: { symbol: 'activity_zone', className: 'model-icon activity-icon' },
    color: 'var(--md-primary)',
    bgColor: 'rgba(var(--md-primary-rgb), 0.1)',
    freeRPD: 20,
    thinking: {
      type: 'level',
      options: ['minimal', 'low', 'medium', 'high'],
      default: 'high'
    }
  },
  {
    id: 'gemini-2.5-flash',
    nameKey: 'models.gemini25Flash',
    nameDefault: 'Gemini 2.5 Flash',
    descKey: 'models.smarterFaster',
    descDefault: 'Smarter & faster',
    translationDescKey: 'translation.modelGemini25Flash',
    translationDescDefault: 'output length 65536 tokens (usually no splitting needed)',
    settingsLabelKey: 'settings.modelSmartFast',
    settingsLabelDefault: 'Gemini 2.5 Flash (20 calls/day)',
    analysisLabelKey: 'settings.modelFlash25',
    analysisLabelDefault: 'Gemini 2.5 Flash (Best)',
    icon: { symbol: 'bolt', className: 'model-icon zap-icon', style: { color: 'var(--md-tertiary)' } },
    color: 'var(--md-tertiary)',
    bgColor: 'rgba(var(--md-tertiary-rgb), 0.1)',
    freeRPD: 20,
    thinking: {
      type: 'budget',
      min: 0,
      max: 24576,
      allowDisable: true,
      default: -1
    }
  },
  {
    id: 'gemini-3.1-flash-lite-preview',
    nameKey: 'models.gemini31FlashLite',
    nameDefault: 'Gemini 3.1 Flash Lite',
    descKey: 'models.bestFreeQuota',
    descDefault: '500 req/day free',
    translationDescKey: 'translation.modelGemini31FlashLite',
    translationDescDefault: 'output length 65536 tokens (usually no splitting needed)',
    settingsLabelKey: 'settings.modelFastest',
    settingsLabelDefault: 'Gemini 3.1 Flash Lite (500 calls/day)',
    analysisLabelKey: null,
    icon: { symbol: 'memory', className: 'model-icon cpu-icon' },
    color: 'var(--success-color)',
    bgColor: 'rgba(var(--success-color-rgb), 0.1)',
    freeRPD: 500,
    thinking: {
      type: 'level',
      options: ['minimal', 'low', 'medium', 'high'],
      default: 'minimal'
    }
  },
  {
    id: 'gemini-2.5-flash-lite',
    nameKey: 'models.gemini25FlashLite',
    nameDefault: 'Gemini 2.5 Flash Lite',
    descKey: 'models.fastestAdvanced',
    descDefault: 'Fastest 2.5 model',
    translationDescKey: 'translation.modelGemini25FlashLite',
    translationDescDefault: 'output length 65536 tokens (usually no splitting needed)',
    settingsLabelKey: 'settings.modelFlash25Lite',
    settingsLabelDefault: 'Gemini 2.5 Flash Lite (20 calls/day)',
    analysisLabelKey: 'settings.modelFlash25LiteSettings',
    analysisLabelDefault: 'Gemini 2.5 Flash Lite (Fast + Efficient)',
    icon: { symbol: 'trending_up', className: 'model-icon trending-icon', style: { color: 'var(--md-tertiary)' } },
    color: 'var(--md-tertiary)',
    bgColor: 'rgba(var(--md-tertiary-rgb), 0.1)',
    freeRPD: 20,
    thinking: {
      type: 'budget',
      min: 512,
      max: 24576,
      allowDisable: true,
      default: -1
    }
  }
];

/** Model IDs available in the video analysis dropdown */
export const ANALYSIS_MODEL_IDS = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite'
];

/** Look up a model by its API ID */
export const getModelById = (id) => GEMINI_MODELS.find(m => m.id === id);

/**
 * Returns the initial thinkingBudgets object { modelId: defaultValue }.
 * Safe to pass directly as useState lazy initializer.
 */
export const getDefaultThinkingBudgets = () =>
  Object.fromEntries(
    GEMINI_MODELS
      .filter(m => m.thinking !== null)
      .map(m => [m.id, m.thinking.default])
  );
