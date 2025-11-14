/**
 * Utility functions for managing thinking budgets for Gemini models
 */

/**
 * Get the thinking budget for a specific model
 * @param {string} modelId - The model ID (e.g., 'gemini-2.5-pro')
 * @returns {number|null} - The thinking budget or null if not supported
 */
export const getThinkingBudget = (modelId) => {
  try {
    const thinkingBudgets = JSON.parse(localStorage.getItem('thinking_budgets') || '{}');
    console.log(`[ThinkingBudget] Stored budgets:`, thinkingBudgets);

    // Check if the model supports thinking
    if (!isThinkingSupported(modelId)) {
      console.log(`[ThinkingBudget] Model ${modelId} does not support thinking`);
      return null;
    }

    // Get the budget for this model, or use default
    const budget = thinkingBudgets[modelId];

    if (budget !== undefined) {
      console.log(`[ThinkingBudget] Using stored budget for ${modelId}: ${budget} (type: ${typeof budget})`);
      return budget;
    }

    // Return default values if not set
    const defaultBudget = getDefaultThinkingBudget(modelId);
    console.log(`[ThinkingBudget] Using default budget for ${modelId}: ${defaultBudget}`);
    return defaultBudget;
  } catch (error) {
    console.error('Error getting thinking budget:', error);
    return getDefaultThinkingBudget(modelId);
  }
};

/**
 * Check if a model supports thinking
 * @param {string} modelId - The model ID
 * @returns {boolean} - True if the model supports thinking
 */
export const isThinkingSupported = (modelId) => {
  const supportedModels = [
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite'
  ];
  
  return supportedModels.includes(modelId);
};

/**
 * Get the default thinking budget for a model
 * @param {string} modelId - The model ID
 * @returns {number} - The default thinking budget
 */
export const getDefaultThinkingBudget = (modelId) => {
  const defaults = {
    'gemini-2.5-pro': -1, // Dynamic thinking
    'gemini-2.5-flash': -1, // Dynamic thinking
    'gemini-2.5-flash-lite': -1 // Dynamic thinking
  };

  return defaults[modelId] || null;
};

/**
 * Add thinking configuration to a Gemini API request
 * @param {Object} requestData - The original request data
 * @param {string} modelId - The model ID
 * @param {Object} options - Options for thinking config
 * @param {boolean} options.enableThinking - Whether to enable thinking for this request
 * @returns {Object} - Updated request data with thinking config
 */
export const addThinkingConfig = (requestData, modelId, options = {}) => {
  const { enableThinking = true } = options;
  // Skip thinking if explicitly disabled
  if (!enableThinking) {
    console.log(`[ThinkingBudget] Thinking disabled for this request (${modelId})`);
    return requestData;
  }

  const thinkingBudget = getThinkingBudget(modelId);

  console.log(`[ThinkingBudget] Model: ${modelId}, Budget: ${thinkingBudget}, Supported: ${isThinkingSupported(modelId)}`);
  console.log(`[ThinkingBudget] Raw localStorage:`, localStorage.getItem('thinking_budgets'));

  // If thinking is not supported or budget is null, return original request
  if (thinkingBudget === null) {
    console.log(`[ThinkingBudget] No thinking config added for ${modelId}`);
    return requestData;
  }

  // Add thinking configuration to generationConfig (REST API structure)
  const updatedRequest = {
    ...requestData,
    generationConfig: {
      ...(requestData.generationConfig || {}),
      thinkingConfig: {
        thinkingBudget: thinkingBudget
      }
    }
  };

  console.log(`[ThinkingBudget] Added thinking config for ${modelId}:`, updatedRequest.generationConfig.thinkingConfig);
  return updatedRequest;
};

/**
 * Validate thinking budget value for a model
 * @param {string} modelId - The model ID
 * @param {number} budget - The budget value to validate
 * @returns {boolean} - True if the budget is valid for this model
 */
export const validateThinkingBudget = (modelId, budget) => {
  if (!isThinkingSupported(modelId)) {
    return false;
  }
  
  const ranges = {
    'gemini-2.5-pro': { min: 128, max: 32768, allowDisable: false },
    'gemini-2.5-flash': { min: 0, max: 24576, allowDisable: true },
    'gemini-2.5-flash-lite': { min: 512, max: 24576, allowDisable: true }
  };
  
  const range = ranges[modelId];
  if (!range) return false;
  
  // -1 is always valid (dynamic thinking)
  if (budget === -1) return true;
  
  // 0 is only valid if the model allows disabling thinking
  if (budget === 0) return range.allowDisable;
  
  // Check if budget is within valid range
  return budget >= range.min && budget <= range.max;
};
