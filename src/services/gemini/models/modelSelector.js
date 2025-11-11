/**
 * Functions for selecting appropriate Gemini models
 */

import i18n from '../../../i18n/i18n';

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
  try {
    // Known working model for WebSocket API with audio
    // Use the exact same model format as in the live-api-web-console
    const knownWorkingModel = 'models/gemini-2.5-flash-native-audio-preview-09-2025';

    // If we already have a list of supported models, check if our known working model is in it
    if (supportedModelsCache) {
      const knownModel = supportedModelsCache.find(model =>
        model.name.includes(knownWorkingModel)
      );

      if (knownModel) {

        // Return the full model path as used in the live-api-web-console
        return knownWorkingModel;
      }

      // If not, find any model that supports audio generation
      const audioModel = supportedModelsCache.find(model =>
        model.supportedGenerationMethods?.includes('generateContent') &&
        model.supportedGenerationMethods?.includes('streamGenerateContent')
      );

      if (audioModel) {

        return audioModel.name; // Use the full model name with path
      }
    }

    // Otherwise, fetch the list of models
    const models = await listGeminiModels(apiKey);
    supportedModelsCache = models;


    // First, check if our known working model is available
    const knownModel = models.find(model =>
      model.name.includes(knownWorkingModel)
    );

    if (knownModel) {

      // Return the full model path as used in the live-api-web-console
      return knownWorkingModel;
    }

    // Find models that support both generateContent and streamGenerateContent
    // These are likely to work with the WebSocket API
    const potentialModels = models.filter(model =>
      model.supportedGenerationMethods?.includes('generateContent') &&
      model.supportedGenerationMethods?.includes('streamGenerateContent')
    );

    if (potentialModels.length === 0) {
      // If no models have the required methods, fall back to the known working model
      console.warn('No models found with required generation methods, using known working model');
      return knownWorkingModel;
    }

    // Look for models with "live" in the name as they're more likely to support WebSocket
    const liveModel = potentialModels.find(model =>
      model.name.toLowerCase().includes('live')
    );

    if (liveModel) {
      // Use the full model name with path
      const modelName = liveModel.name;

      return modelName;
    }

    // Prefer models with "flash" in the name for faster generation
    const flashModel = potentialModels.find(model =>
      model.name.toLowerCase().includes('flash')
    );

    if (flashModel) {
      // Use the full model name with path
      const modelName = flashModel.name;

      return modelName;
    }

    // Otherwise, use the first suitable model
    // Use the full model name with path
    const modelName = potentialModels[0].name;

    return modelName;
  } catch (error) {
    console.error('Error finding suitable audio model:', error);
    // Fallback to our known working model with the full path
    return 'models/gemini-2.5-flash-native-audio-preview-09-2025';
  }
};
