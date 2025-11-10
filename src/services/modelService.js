/**
 * Service for managing F5-TTS models
 */
import { API_BASE_URL } from '../config';

/**
 * Get list of available models
 * @param {boolean} includeCache - Whether to include models from Hugging Face cache
 * @returns {Promise<Object>} - List of models and active model
 */
export const getModels = async (includeCache = false) => {
  try {
    const url = `${API_BASE_URL}/narration/models${includeCache ? '?include_cache=true' : ''}`;
    const response = await fetch(url, {
      mode: 'cors',
      credentials: 'include',
      headers: {
        'Accept': 'application/json'
      }
    });
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching models:', error);
    throw error;
  }
};

/**
 * Get the currently active model
 * @returns {Promise<Object>} - Active model ID
 */
export const getActiveModel = async () => {
  try {
    const response = await fetch(`${API_BASE_URL}/narration/models/active`);
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error fetching active model:', error);
    throw error;
  }
};

/**
 * Set the active model
 * @param {string} modelId - Model ID to set as active
 * @returns {Promise<Object>} - Response from server
 */
export const setActiveModel = async (modelId) => {
  try {
    const response = await fetch(`${API_BASE_URL}/narration/models/active`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model_id: modelId }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Server returned ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error setting active model:', error);
    throw error;
  }
};

/**
 * Add a new model from Hugging Face
 * @param {Object} modelData - Model data
 * @returns {Promise<Object>} - Response from server
 */
export const addModelFromHuggingFace = async (modelData) => {
  try {
    const response = await fetch(`${API_BASE_URL}/narration/models`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_type: 'huggingface',
        model_url: modelData.modelUrl,
        vocab_url: modelData.vocabUrl,
        model_id: modelData.modelId,
        languageCodes: modelData.languageCodes || [],
        config: modelData.config || {},
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Server returned ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error adding model from Hugging Face:', error);
    throw error;
  }
};

/**
 * Add a new model from direct URL
 * @param {Object} modelData - Model data
 * @returns {Promise<Object>} - Response from server
 */
export const addModelFromUrl = async (modelData) => {
  try {
    const response = await fetch(`${API_BASE_URL}/narration/models`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_type: 'url',
        model_url: modelData.modelUrl,
        vocab_url: modelData.vocabUrl,
        model_id: modelData.modelId,
        languageCodes: modelData.languageCodes || [],
        config: modelData.config || {},
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Server returned ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error adding model from URL:', error);
    throw error;
  }
};

/**
 * Get the download status of a model
 * @param {string} modelId - Model ID
 * @returns {Promise<Object>} - Download status
 */
export const getModelDownloadStatus = async (modelId) => {
  try {
    const response = await fetch(`${API_BASE_URL}/narration/models/download-status/${modelId}`);

    if (response.status === 404) {
      return { status: null };
    }

    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error getting model download status:', error);
    throw error;
  }
};

/**
 * Delete a model
 * @param {string} modelId - Model ID to delete
 * @param {boolean} deleteCache - Whether to also delete the model from Hugging Face cache
 * @returns {Promise<Object>} - Response from server
 */
export const deleteModel = async (modelId, deleteCache = false) => {
  try {
    const url = `${API_BASE_URL}/narration/models/${modelId}${deleteCache ? '?delete_cache=true' : ''}`;
    const response = await fetch(url, {
      method: 'DELETE',
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Server returned ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error deleting model:', error);
    throw error;
  }
};

/**
 * Update model information
 * @param {string} modelId - Model ID to update
 * @param {Object} modelInfo - New model information
 * @returns {Promise<Object>} - Response from server
 */
export const updateModelInfo = async (modelId, modelInfo) => {
  try {
    const response = await fetch(`${API_BASE_URL}/narration/models/${modelId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(modelInfo),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Server returned ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error updating model info:', error);
    throw error;
  }
};

/**
 * Get model storage information (whether it's using symbolic links)
 * @param {string} modelId - Model ID to check
 * @returns {Promise<Object>} - Storage information
 */
export const getModelStorageInfo = async (modelId) => {
  try {
    const response = await fetch(`${API_BASE_URL}/narration/models/${modelId}/storage`);

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Server returned ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error getting model storage info:', error);
    throw error;
  }
};

/**
 * Cancel an ongoing model download
 * @param {string} modelId - Model ID to cancel download for
 * @returns {Promise<Object>} - Response from server
 */
export const cancelModelDownload = async (modelId) => {
  try {
    const response = await fetch(`${API_BASE_URL}/narration/models/cancel-download/${modelId}`, {
      method: 'POST',
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Server returned ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error cancelling model download:', error);
    throw error;
  }
};

/**
 * Scan the models directory for new models and add them to registry
 * Simple Node.js version - no Python bullshit!
 * @returns {Promise<Object>} - Scan results
 */
export const scanModelsDirectory = async () => {
  try {
    // Initiating model directory scan

    const response = await fetch(`${API_BASE_URL}/scan-models`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // API response received

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `Server returned ${response.status}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    throw error;
  }
};
