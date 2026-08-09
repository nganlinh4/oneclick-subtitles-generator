/** Build exact thinkingConfig payloads from the shared Gemini model contract. */
import { getModelById, migrateGeminiModelId } from '../config/geminiModels';

const getThinkingProfile = (modelId) => getModelById(migrateGeminiModelId(modelId))?.thinking || null;

export const isThinkingLevelModel = (modelId) => getThinkingProfile(modelId)?.type === 'level';
export const isThinkingSupported = (modelId) => Boolean(getThinkingProfile(modelId));
export const getDefaultThinkingBudget = (modelId) => getThinkingProfile(modelId)?.default ?? null;

export const validateThinkingBudget = (modelId, value) => {
  const thinking = getThinkingProfile(modelId);
  if (!thinking) return false;

  if (thinking.type === 'level') return thinking.options.includes(value);
  if (!thinking.configurable) return value === thinking.default;
  if (value === -1) return thinking.allowDynamic !== false;
  if (value === 0) return Boolean(thinking.allowDisable);
  return Number.isInteger(value) && value >= thinking.min && value <= thinking.max;
};

export const getThinkingBudget = (modelId) => {
  const fallback = getDefaultThinkingBudget(modelId);
  if (fallback === null) return null;

  try {
    const saved = JSON.parse(localStorage.getItem('thinking_budgets') || '{}')[migrateGeminiModelId(modelId)];
    return validateThinkingBudget(modelId, saved) ? saved : fallback;
  } catch (error) {
    console.error('Error reading Gemini thinking settings:', error);
    return fallback;
  }
};

const getLowestThinkingValue = (thinking) => {
  if (thinking.type === 'budget') return thinking.allowDisable === false ? thinking.default : 0;
  return thinking.options.includes('minimal') ? 'minimal' : thinking.options[0];
};

/**
 * Add the model's exact thinking shape. Setting enableThinking=false requests
 * the lowest supported value instead of silently falling back to provider defaults.
 */
export const addThinkingConfig = (requestData, modelId, options = {}) => {
  const thinking = getThinkingProfile(modelId);
  if (!thinking) return requestData;

  const value = options.enableThinking === false
    ? getLowestThinkingValue(thinking)
    : getThinkingBudget(modelId);
  const thinkingConfig = thinking.type === 'level'
    ? { thinkingLevel: String(value).toUpperCase() }
    : { thinkingBudget: value };

  return {
    ...requestData,
    generationConfig: {
      ...(requestData.generationConfig || {}),
      thinkingConfig
    }
  };
};
