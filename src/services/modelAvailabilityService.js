/**
 * Service for checking model availability
 */
import { getModels } from './modelService';

// Cache for models to avoid repeated API calls
let modelsCache = null;
let lastFetchTime = 0;
const CACHE_DURATION = 60000; // 1 minute cache

// Custom event for model list changes
export const MODEL_LIST_CHANGED_EVENT = 'model-list-changed';

/**
 * Get all available models with cache
 * @returns {Promise<Object>} - List of models and active model
 */
export const getAvailableModels = async () => {
  const now = Date.now();

  // Use cache if available and not expired
  if (modelsCache && (now - lastFetchTime < CACHE_DURATION)) {
    return modelsCache;
  }

  try {
    const models = await getModels();
    modelsCache = models;
    lastFetchTime = now;
    return models;
  } catch (error) {
    console.error('Error fetching models:', error);
    // If we have a cache, return it even if expired
    if (modelsCache) {
      return modelsCache;
    }
    throw error;
  }
};

/**
 * Invalidate the models cache and notify listeners
 * Call this function whenever models are added or removed
 */
export const invalidateModelsCache = () => {

  modelsCache = null;
  lastFetchTime = 0;

  // Dispatch a custom event to notify components that the model list has changed
  const event = new CustomEvent(MODEL_LIST_CHANGED_EVENT);
  window.dispatchEvent(event);
};
