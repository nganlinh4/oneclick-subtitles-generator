/**
 * Functions for checking Gemini API availability
 */

import i18n from '../../../i18n/i18n';
import { listGeminiModels, findSuitableAudioModel } from '../models/modelSelector';

// Translation function shorthand
const t = (key, fallback) => i18n.t(key, fallback);

/**
 * Check if Gemini API is available
 * @returns {Promise<Object>} - Availability status
 */
export const checkGeminiAvailability = async () => {
  try {
    // Check if API key is available
    const apiKey = localStorage.getItem('gemini_api_key');
    if (!apiKey) {
      return {
        available: false,
        error: t('settings.geminiApiKeyRequired', 'Gemini API key not found'),
        message: 'geminiApiKeyRequired'
      };
    }

    // Try to list models to check if the API key is valid
    try {
      const models = await listGeminiModels(apiKey);

      // Check if there are any models available
      if (!models || models.length === 0) {
        return {
          available: false,
          error: 'No Gemini models available',
          message: 'noGeminiModelsAvailable'
        };
      }

      // Try to find a suitable model for audio generation
      const suitableModel = await findSuitableAudioModel(apiKey);

      if (!suitableModel) {
        return {
          available: false,
          error: 'No suitable models for audio generation',
          message: 'noSuitableGeminiModels'
        };
      }

      return {
        available: true,
        model: suitableModel
      };
    } catch (error) {
      return {
        available: false,
        error: `Gemini API error: ${error.message}`,
        message: 'invalidGeminiApiKey'
      };
    }
  } catch (error) {
    console.error('Error checking Gemini availability:', error);
    return {
      available: false,
      error: error.message,
      message: 'errorCheckingGeminiAvailability'
    };
  }
};
