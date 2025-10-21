/**
 * Functions for generating narration using Gemini API
 */

import i18n from '../../../i18n/i18n';
import { SERVER_URL } from '../../../config';
import {
  initializeClientPool,
  getNextAvailableClient,
  markClientAsNotBusy,
  getClientPool
} from '../client/clientManager';
import { getGeminiLanguageCode } from '../utils/languageUtils';

// Translation function shorthand
const t = (key, fallback) => i18n.t(key, fallback);

// Flag to track if generation has been cancelled
let isCancelled = false;

// Queue for pending narration requests
const narrationQueue = [];

// Flag to track if the queue processor is running
let isProcessingQueue = false;

/**
 * Cancel ongoing narration generation
 */
export const cancelGeminiNarrations = () => {
  console.log("Cancelling Gemini narration generation");
  isCancelled = true;

  // Clear the narration queue
  narrationQueue.length = 0;

  // If the queue is not being processed, we need to manually trigger the completion
  if (!isProcessingQueue) {
    // Import the event dispatcher from the browser
    if (typeof window !== 'undefined') {
      // Dispatch an event to notify components that narration has been cancelled
      const event = new CustomEvent('gemini-narration-cancelled', {
        detail: {
          timestamp: Date.now()
        }
      });
      window.dispatchEvent(event);
    }
  }
};

/**
 * Generate narration for a subtitle using Gemini API with WebSocket for audio
 * @param {Object} subtitle - Subtitle object with text and id
 * @param {string} language - Language of the subtitle
 * @param {string} modelName - Optional model name to use
 * @param {string} voiceName - Optional voice name to use
 * @param {Object} clientObj - Optional client object to use
 * @returns {Promise<Object>} - Narration result
 */
export const generateGeminiNarration = async (subtitle, language, modelName = null, voiceName = null, clientObj = null) => {
  let client = null;

  try {
    // Get API key from localStorage
    const apiKey = localStorage.getItem('gemini_api_key');
    if (!apiKey) {
      throw new Error(t('geminiApiKeyRequired', 'Gemini API key not found'));
    }

    // Create the prompt for narration - explicitly instruct to speak in the target language
    const narrationPrompt = `READ the following text. DO NOT ASK ME ANYTHING FOLLOW UP, just read it exactly as written: "${subtitle.text}"`;

    // Use the provided client or get a new one
    if (clientObj) {
      client = clientObj.client;
    } else {
      // Get a client from the pool
      clientObj = await getNextAvailableClient();
      client = clientObj.client;
    }

    // Create a unique request ID for this subtitle
    const requestId = `subtitle_${subtitle.id}_${Date.now()}`;

    // Send the prompt and get the request ID
    const sentRequestId = client.send(
      { text: narrationPrompt },
      true, // turnComplete
      { subtitleId: subtitle.id, requestId }
    );

    // Wait for the response
    const audioResult = await client.waitForResponse(sentRequestId, 60000);

    // Return the result with audio data and metadata
    return {
      subtitle_id: subtitle.id,
      text: subtitle.text,
      audioData: audioResult.audioData, // Base64 encoded audio data
      mimeType: audioResult.mimeType,   // MIME type of the audio
      sampleRate: audioResult.sampleRate, // Sample rate of the audio
      success: !!audioResult.audioData,
      gemini: true, // Flag to indicate this is a Gemini narration
      // Include original_ids if this is a grouped subtitle
      original_ids: subtitle.original_ids || [subtitle.id],
      // Include start and end times if available
      start: subtitle.start,
      end: subtitle.end
    };
  } catch (error) {
    console.error(`Error generating Gemini narration for subtitle ${subtitle.id}:`, error);

    return {
      subtitle_id: subtitle.id,
      text: subtitle.text,
      audioData: null,
      success: false,
      error: error.message,
      gemini: true,
      // Include original_ids if this is a grouped subtitle
      original_ids: subtitle.original_ids || [subtitle.id],
      // Include start and end times if available
      start: subtitle.start,
      end: subtitle.end
    };
  } finally {
    // We no longer release the client here
    // The client is released by the processNarrationTask function
    // This prevents double-releasing the client
  }
};

/**
 * Process a single narration from the queue
 * @param {Object} narrationTask - Task object with subtitle, language, etc.
 * @returns {Promise<Object>} - Narration result
 */
const processNarrationTask = async (narrationTask) => {
  const { subtitle, language, modelName, voiceName, clientObj: initialClientObj } = narrationTask;
  let clientObj = initialClientObj;
  let acquiredClient = false;

  try {
    // If no client was assigned, get one now
    if (!clientObj) {
      try {
        clientObj = await getNextAvailableClient();
        acquiredClient = true;
        console.log(`Acquired client ${clientObj.index} for subtitle ${subtitle.id}`);
      } catch (error) {
        console.error(`Error getting client for subtitle ${subtitle.id}:`, error);
        throw error;
      }
    }

    // Generate the narration
    const result = await generateGeminiNarration(subtitle, language, modelName, voiceName, clientObj);

    // If the result has audio data, save it to the server automatically
    if (result.success && result.audioData) {
      try {
        // Send the audio data to the server
        const response = await fetch(`${SERVER_URL}/api/narration/save-gemini-audio`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            audioData: result.audioData,
            subtitle_id: result.subtitle_id,
            sampleRate: result.sampleRate || 24000,
            mimeType: result.mimeType || 'audio/pcm' // Include MIME type
          })
        });

        if (response.ok) {
          const data = await response.json();
          if (data.success) {
            // Update the result with the filename
            result.filename = data.filename;
          } else {
            console.error(`Error saving audio to server: ${data.error}`);
          }
        } else {
          console.error(`Server returned ${response.status}: ${response.statusText}`);
        }
      } catch (error) {
        console.error(`Error saving audio to server for subtitle ${result.subtitle_id}:`, error);
      }
    }

    return result;
  } finally {
    // Release the client if we acquired it in this function
    if (acquiredClient && clientObj) {
      console.log(`Releasing client ${clientObj.index} after processing subtitle ${subtitle.id}`);
      markClientAsNotBusy(clientObj);
    }
  }
};

/**
 * Process the narration queue
 * @param {Array} results - Array to store results
 * @param {number} total - Total number of narrations to process
 * @param {Function} onProgress - Callback for progress updates
 * @param {Function} onResult - Callback for each result
 * @param {Function} onError - Callback for errors
 * @param {Function} onComplete - Callback for completion
 */
const processNarrationQueue = async (results, total, onProgress, onResult, onError, onComplete) => {
  if (isProcessingQueue) return;

  isProcessingQueue = true;
  console.log("Starting to process narration queue with concurrent processing");

  try {
    // Process narrations in batches to maintain concurrency
    while (narrationQueue.length > 0 && !isCancelled) {
      // Get the actual number of available clients in the pool
      const clientPool = getClientPool();
      const availableClientsCount = clientPool.clients.length;

      // Check if we have any available clients
      if (availableClientsCount === 0) {
        console.error("No available WebSocket clients in the pool. Cannot process narrations.");
        const error = new Error("No available WebSocket clients in the pool. Please check your API key and try again.");
        onError(error);
        break;
      }

      // Use the actual number of available clients for batch size, not the configured number
      // This ensures we only process as many narrations as we have clients for
      const tasksToProcess = [];
      const configuredConcurrentClients = parseInt(localStorage.getItem('gemini_concurrent_clients'), 10) || 5;
      const batchSize = Math.min(availableClientsCount, narrationQueue.length);

      console.log(`Processing batch of ${batchSize} narrations concurrently (using ${availableClientsCount} of ${configuredConcurrentClients} configured clients)`);

      for (let i = 0; i < batchSize; i++) {
        if (narrationQueue.length > 0) {
          tasksToProcess.push(narrationQueue.shift());
        }
      }

      // Process all tasks in this batch concurrently
      const taskPromises = tasksToProcess.map(task => {
        return processNarrationTask(task)
          .then(result => {
            // Add the result to the results array
            results.push(result);

            // Update progress
            const progressPercent = Math.round((results.length / total) * 100);
            onProgress(`Generating narrations... (${progressPercent}% complete)`);

            // Call the result callback
            onResult(result, results.length, total);

            // Dispatch an event to notify other components that narrations have been updated
            const event = new CustomEvent('narrations-updated', {
              detail: {
                source: 'original', // Assuming Gemini narrations are for original subtitles
                narrations: [...results]
              }
            });
            window.dispatchEvent(event);

            return result;
          })
          .catch(error => {
            console.error('Error processing narration task:', error);

            // Create a failed result object to maintain the correct order
            const failedResult = {
              subtitle_id: task.subtitle.id,
              text: task.subtitle.text,
              audioData: null,
              success: false,
              error: error.message,
              gemini: true,
              failed: true, // Flag to indicate this narration failed
              // Include original_ids if this is a grouped subtitle
              original_ids: task.subtitle.original_ids || [task.subtitle.id],
              // Include start and end times if available
              start: task.subtitle.start,
              end: task.subtitle.end
            };

            // Add the failed result to the results array to maintain order
            results.push(failedResult);

            // Update progress
            const progressPercent = Math.round((results.length / total) * 100);
            onProgress(`Generating narrations... (${progressPercent}% complete, with errors)`);

            // Call the error callback
            onError(error);

            // Return the failed result to maintain the correct order in the results array
            return failedResult;
          });
      });

      // Wait for all tasks in this batch to complete
      await Promise.all(taskPromises);

      // Check if we should cancel
      if (isCancelled) {
        console.log("Narration generation cancelled during batch processing");
        break;
      }
    }

    // Check if generation was cancelled
    if (isCancelled) {
      onProgress('Narration generation cancelled');
    }
    // Check if we have any results at all
    else if (results.length === 0) {
      // No results were generated, likely due to a connection error
      const error = new Error("No narrations were generated. There may have been a connection issue with Gemini.");
      onError(error);
    }
    // Check if we have fewer results than expected
    else if (results.length < total) {
      // Some results were generated, but not all
      onProgress(`Narration generation incomplete. Generated ${results.length} of ${total} narrations.`);
    }
    // All narrations were generated successfully
    else {
      // Complete the generation
      onProgress("Narration generation complete");
    }

    // Call the complete callback regardless of cancellation
    onComplete(results);
  } finally {
    isProcessingQueue = false;
  }
};

/**
 * Generate narration for multiple subtitles using Gemini API with concurrent processing
 * @param {Array} subtitles - Array of subtitle objects
 * @param {string} language - Language of the subtitles
 * @param {Function} onProgress - Callback for progress updates
 * @param {Function} onResult - Callback for each result
 * @param {Function} onError - Callback for errors
 * @param {Function} onComplete - Callback for completion
 * @param {string} modelName - Optional model name to use
 * @param {string} voiceName - Optional voice name to use
 * @returns {Promise<Object>} - Generation response
 */
export const generateGeminiNarrations = async (
  subtitles,
  language,
  onProgress = () => {},
  onResult = () => {},
  onError = () => {},
  onComplete = () => {},
  modelName = null,
  // sleepTime parameter removed as it's not used with concurrent processing
  voiceName = null,
  initialProgressMessage = "Preparing to generate narration..."
) => {
  // Reset cancellation flag
  isCancelled = false;

  try {
    // Initial progress message - now provided by the component with proper translation
    onProgress(initialProgressMessage);

    // Get API key from localStorage
    const apiKey = localStorage.getItem('gemini_api_key');
    if (!apiKey) {
      throw new Error(t('settings.geminiApiKeyRequired', 'Gemini API key not found'));
    }

    // Convert the language code to a Gemini-compatible format
    const geminiLanguageCode = getGeminiLanguageCode(language);

    // Find a suitable model if not provided
    if (!modelName) {
      const { findSuitableAudioModel } = await import('../models/modelSelector');
      modelName = await findSuitableAudioModel(apiKey);
    }

    // Get the voice name from localStorage if not provided
    if (!voiceName) {
      voiceName = localStorage.getItem('gemini_voice') || 'Aoede'; // Default to Aoede if not set
    }

    // Initialize the client pool
    await initializeClientPool(apiKey, modelName, voiceName, geminiLanguageCode);

    // Clear the narration queue
    narrationQueue.length = 0;

    // Create an array to store results
    const results = [];
    const total = subtitles.length;

    // Add all subtitles to the queue without pre-assigning clients
    for (const subtitle of subtitles) {
      // Check if generation has been cancelled
      if (isCancelled) {
        onProgress('Narration generation cancelled');
        return { success: false, cancelled: true, results };
      }

      // Add the task to the queue without a client
      // Clients will be assigned when the task is processed
      narrationQueue.push({
        subtitle,
        language,
        modelName,
        voiceName,
        clientObj: null // Will be assigned during processing
      });
    }

    // Start processing the queue
    // Use setTimeout to ensure the UI updates before we start processing
    setTimeout(() => {
      processNarrationQueue(results, total, onProgress, onResult, onError, onComplete);
    }, 0);

    // Dispatch an event to notify that narration generation has started
    if (typeof window !== 'undefined') {
      const event = new CustomEvent('gemini-narration-started', {
        detail: {
          timestamp: Date.now(),
          total: subtitles.length
        }
      });
      window.dispatchEvent(event);
    }

    // Return immediately with a pending status
    return {
      success: true,
      pending: true,
      message: 'Narration generation started in the background'
    };
  } catch (error) {
    console.error('Error setting up Gemini narrations:', error);
    onError(error);
    return { success: false, error: error.message };
  }
};
