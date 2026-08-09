/**
 * Functions for selecting appropriate Gemini models
 */

import i18n from '../../../i18n/i18n';
import { DEFAULT_LIVE_AUDIO_MODEL_ID, LIVE_AUDIO_MODELS } from '../../../config/geminiModels';

// Translation function shorthand
const t = (key, fallback) => i18n.t(key, fallback);

/**
 * List available Gemini models
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<Array>} - List of available models
 */
export const listGeminiModels = async (apiKey) => {
  try {
    if (!apiKey) {
      apiKey = localStorage.getItem('gemini_api_key');
      if (!apiKey) {
        throw new Error(t('settings.geminiApiKeyRequired', 'Gemini API key not found'));
      }
    }

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const response = await fetch(apiUrl);

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Gemini API error: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    return data.models || [];
  } catch (error) {
    console.error('Error listing Gemini models:', error);
    throw error;
  }
};

// Cache for supported models
let supportedModelsCache = null;

/**
 * Find a suitable model for audio generation
 * @param {string} apiKey - Gemini API key
 * @returns {Promise<string>} - Model name
 */
export const findSuitableAudioModel = async (apiKey) => {
  const candidates = [
    DEFAULT_LIVE_AUDIO_MODEL_ID,
    ...LIVE_AUDIO_MODELS.map(({ id }) => id).filter((id) => id !== DEFAULT_LIVE_AUDIO_MODEL_ID)
  ];
  const asModelPath = (id) => `models/${id}`;
  const findAvailableCandidate = (models) => candidates.find((id) =>
    models.some((model) => model.name === asModelPath(id))
  );

  try {
    if (supportedModelsCache) {
      const cachedCandidate = findAvailableCandidate(supportedModelsCache);
      if (cachedCandidate) return asModelPath(cachedCandidate);
    }

    const models = await listGeminiModels(apiKey);
    supportedModelsCache = models;
    const availableCandidate = findAvailableCandidate(models);
    if (availableCandidate) return asModelPath(availableCandidate);

    console.warn('No catalog Gemini Live model appeared in the models response; using the catalog default');
    return asModelPath(DEFAULT_LIVE_AUDIO_MODEL_ID);
  } catch (error) {
    console.error('Error finding suitable audio model:', error);
    return asModelPath(DEFAULT_LIVE_AUDIO_MODEL_ID);
  }
};
