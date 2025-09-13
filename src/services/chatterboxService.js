/**
 * Service for interacting with Chatterbox TTS API
 */

// Import centralized React configuration
import { API_URLS } from '../config/appConfig';

const CHATTERBOX_API_BASE_URL = API_URLS.CHATTERBOX;
const SERVER_API_BASE_URL = API_URLS.BACKEND;

// Track if Chatterbox service has been successfully initialized
let chatterboxServiceInitialized = false;

/**
 * Sleep for a specified number of milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Check server health to see if Chatterbox service should be running
 * @returns {Promise<{shouldBeRunning: boolean, message?: string}>}
 */
const checkServerChatterboxStatus = async () => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

    const response = await fetch(`${SERVER_API_BASE_URL}/api/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        shouldBeRunning: false,
        message: 'Server health check failed'
      };
    }

    const healthData = await response.json();
    const chatterboxRunning = healthData.services?.chatterbox?.running || false;

    return {
      shouldBeRunning: chatterboxRunning,
      message: chatterboxRunning ?
        'Chatterbox service should be running' :
        'Chatterbox service not started (use npm run dev:cuda)'
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      return {
        shouldBeRunning: false,
        message: 'Server health check timeout'
      };
    }

    return {
      shouldBeRunning: false,
      message: `Server health check error: ${error.message}`
    };
  }
};

/**
 * Single attempt to check Chatterbox API availability
 * @returns {Promise<{available: boolean, message?: string}>}
 */
export const checkChatterboxAvailabilitySingle = async () => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const response = await fetch(`${CHATTERBOX_API_BASE_URL}/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        available: false,
        message: `Chatterbox API returned status ${response.status}`
      };
    }

    const healthData = await response.json();

    // Check if TTS model is loaded
    if (!healthData.models_loaded?.tts) {
      return {
        available: false,
        message: 'Chatterbox TTS model is not loaded'
      };
    }

    // Mark service as initialized when health check passes with TTS model loaded
    chatterboxServiceInitialized = true;

    return {
      available: true,
      device: healthData.device,
      models: healthData.models_loaded
    };
  } catch (error) {
    if (error.name === 'AbortError') {
      return {
        available: false,
        message: 'Chatterbox API timeout - service may not be running'
      };
    }

    if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
      return {
        available: false,
        message: 'Chatterbox API is not running. Please start the Chatterbox service.'
      };
    }

    return {
      available: false,
      message: `Chatterbox API error: ${error.message}`
    };
  }
};

/**
 * Wake up the Chatterbox service by calling the wake-up endpoint
 * @returns {Promise<{success: boolean, message?: string}>}
 */
export const wakeUpChatterboxService = async () => {
  try {
    console.log('🔧 Attempting to wake up Chatterbox service...');

    const response = await fetch(`${CHATTERBOX_API_BASE_URL}/wake-up`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return {
        success: false,
        message: `Failed to wake up Chatterbox service: ${response.status}`
      };
    }

    const result = await response.json();
    console.log('✅ Chatterbox service wake-up response:', result.status);

    return {
      success: true,
      message: result.message || 'Chatterbox service awakened successfully'
    };
  } catch (error) {

    if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
      return {
        success: false,
        message: 'Chatterbox API is not running. Please start the service with "npm run dev:cuda".'
      };
    }

    console.error('❌ Error waking up Chatterbox service:', error);
    return {
      success: false,
      message: `Error waking up Chatterbox service: ${error.message}`
    };
  }
};

/**
 * Check if Chatterbox API is available with retry logic and wake-up capability
 * @param {number} maxAttempts - Maximum number of attempts (default: 5)
 * @param {number} delayMs - Delay between attempts in milliseconds (default: 2000)
 * @param {boolean} attemptWakeUp - Whether to attempt waking up the service if not running (default: true)
 * @returns {Promise<{available: boolean, message?: string}>}
 */
export const checkChatterboxAvailability = async (maxAttempts = 5, delayMs = 2000, attemptWakeUp = true) => {
  // First, try to connect directly to see if service is already running
  let directCheck = await checkChatterboxAvailabilitySingle();
  if (directCheck.available) {
    return directCheck;
  }

  // If not available and wake-up is enabled, try to wake up the service
  if (attemptWakeUp) {
    console.log('🔧 Chatterbox not available, attempting to wake up service...');
    const wakeUpResult = await wakeUpChatterboxService();

    if (!wakeUpResult.success) {
      // If wake-up failed, return the error immediately
      return {
        available: false,
        message: wakeUpResult.message || 'Failed to wake up Chatterbox service'
      };
    }

    // Wake-up was successful, now try to connect
    console.log('⏳ Wake-up successful, verifying service availability...');
  } else {
    // If wake-up is disabled, check server status first
    const serverStatus = await checkServerChatterboxStatus();
    if (!serverStatus.shouldBeRunning) {
      return {
        available: false,
        message: serverStatus.message || 'Chatterbox service not started (use npm run dev:cuda)'
      };
    }
  }

  // If server says it should be running, try to connect to the actual API
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await checkChatterboxAvailabilitySingle();

      // If successful, return immediately
      if (result.available) {
        return result;
      }

      // Store the error for potential final return
      lastError = result;

      // If this is the last attempt, don't wait
      if (attempt === maxAttempts) {
        break;
      }

      // Wait before next attempt
      await sleep(delayMs);

    } catch (error) {
      lastError = {
        available: false,
        message: `Chatterbox API error: ${error.message}`
      };

      // If this is the last attempt, don't wait
      if (attempt === maxAttempts) {
        break;
      }

      // Wait before next attempt
      await sleep(delayMs);
    }
  }

  // Return the last error if all attempts failed
  return lastError || {
    available: false,
    message: 'Chatterbox API is not available after multiple attempts'
  };
};

/**
 * Generate speech using Chatterbox TTS
 * @param {string} text - Text to synthesize
 * @param {number} exaggeration - Emotional intensity (0.25-2.0)
 * @param {number} cfgWeight - CFG/Pace control (0.0-1.0)
 * @param {File|null} voiceFile - Required voice reference file
 * @param {string|null} voiceFilePath - Optional voice reference file path (more efficient than uploading)
 * @returns {Promise<Blob>} - Audio blob
 */
export const generateChatterboxSpeech = async (text, languageId = 'en', exaggeration = 0.5, cfgWeight = 0.5, voiceFile = null, voiceFilePath = null) => {
  // Capability gate: only send advanced controls for English for now
  const ADVANCED_NON_EN_ENABLED = false;
  const supportsAdvancedControls = (lang) => {
    const l = (lang || '').toLowerCase();
    if (l.startsWith('en')) return true;
    return ADVANCED_NON_EN_ENABLED;
  };

  try {
    // Reference audio is now required for all Chatterbox generation
    if (!voiceFile && !voiceFilePath) {
      throw new Error('Reference audio is required for Chatterbox TTS generation');
    }

    // Use the single endpoint that requires reference audio
    const endpoint = '/tts/generate';
    const url = `${CHATTERBOX_API_BASE_URL}${endpoint}`;

    let body;
    let headers = {};

    if (voiceFilePath) {
      // Convert file path to actual file by fetching it from the server
      try {
        console.log('Converting file path to file for Chatterbox API:', voiceFilePath);

        // Create a URL to fetch the file from the server
        // The file path is typically something like: /path/to/reference_audio/filename.wav
        // We need to convert it to a server URL
        const filename = voiceFilePath.split(/[/\\]/).pop(); // Get filename from path
        const fileUrl = `${SERVER_API_BASE_URL}/api/narration/reference-audio/${filename}`;

        const response = await fetch(fileUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch reference audio file: ${response.status}`);
        }

        const blob = await response.blob();
        const file = new File([blob], filename, { type: 'audio/wav' });

        // Use the converted file
        const formData = new FormData();
        formData.append('text', text);
        formData.append('language_id', languageId);
        if (supportsAdvancedControls(languageId) && Number.isFinite(exaggeration) && Number.isFinite(cfgWeight)) {
          formData.append('exaggeration', exaggeration.toString());
          formData.append('cfg_weight', cfgWeight.toString());
        }
        formData.append('voice_file', file);
        body = formData;

        console.log('Successfully converted file path to file for Chatterbox API');
      } catch (error) {
        console.error('Error converting file path to file:', error);
        throw new Error(`Failed to convert reference audio file: ${error.message}`);
      }
    } else if (voiceFile) {
      // Use FormData for file upload (the only supported method now)
      const formData = new FormData();
      formData.append('text', text);
      formData.append('language_id', languageId);
      if (supportsAdvancedControls(languageId) && Number.isFinite(exaggeration) && Number.isFinite(cfgWeight)) {
        formData.append('exaggeration', exaggeration.toString());
        formData.append('cfg_weight', cfgWeight.toString());
      }
      formData.append('voice_file', voiceFile);
      body = formData;
      // Don't set Content-Type header, let browser set it with boundary
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Chatterbox API error: ${response.status} - ${errorText}`);
    }

    // Return the audio blob
    return await response.blob();
  } catch (error) {
    console.error('Error generating Chatterbox speech:', error);

    if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
      throw new Error('Chatterbox API is not running. Please start the Chatterbox service.');
    }

    throw error;
  }
};

/**
 * Convert voice using Chatterbox VC
 * @param {File} inputAudio - Input audio file to convert
 * @param {File} targetVoice - Target voice reference file
 * @returns {Promise<Blob>} - Converted audio blob
 */
export const convertChatterboxVoice = async (inputAudio, targetVoice) => {
  try {
    const formData = new FormData();
    formData.append('input_audio', inputAudio);
    formData.append('target_voice', targetVoice);

    const response = await fetch(`${CHATTERBOX_API_BASE_URL}/vc/convert`, {
      method: 'POST',
      body: formData,
      // Add timeout for voice conversion
      signal: AbortSignal.timeout(120000), // 2 minute timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Chatterbox VC error: ${response.status} - ${errorText}`);
    }

    // Return the converted audio blob
    return await response.blob();
  } catch (error) {
    console.error('Error converting voice with Chatterbox:', error);

    if (error.name === 'TimeoutError') {
      throw new Error('Chatterbox voice conversion timeout');
    }

    throw error;
  }
};

/**
 * Get Chatterbox API health status
 * @returns {Promise<Object>} - Health status object
 */
export const getChatterboxHealth = async () => {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${CHATTERBOX_API_BASE_URL}/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Chatterbox health check timeout');
    }

    if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
      throw new Error('Chatterbox API is not running');
    }

    throw error;
  }
};

/**
 * Check if Chatterbox service has been initialized
 * @returns {boolean} - Whether the service has been initialized
 */
export const isChatterboxServiceInitialized = () => {
  return chatterboxServiceInitialized;
};

/**
 * Reset Chatterbox service initialization status
 * Used for testing or when service needs to be re-initialized
 */
export const resetChatterboxServiceInitialization = () => {
  chatterboxServiceInitialized = false;
};

/**
 * Quick check if Chatterbox should be available based on server configuration
 * This provides immediate feedback without API calls, similar to F5-TTS
 * @returns {Promise<{available: boolean, message?: string}>}
 */
export const checkChatterboxShouldBeAvailable = async () => {
  return await checkServerChatterboxStatus();
};
