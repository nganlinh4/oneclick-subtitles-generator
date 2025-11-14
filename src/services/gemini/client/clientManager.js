/**
 * Manager for Gemini WebSocket clients
 */

import { GeminiWebSocketClient } from './GeminiWebSocketClient';
import { findSuitableAudioModel } from '../models/modelSelector';
import { getNextAvailableKey, blacklistKey } from '../keyManager';

// Default number of concurrent WebSocket clients
const DEFAULT_CONCURRENT_CLIENTS = 5;
// Maximum number of concurrent WebSocket clients
const MAX_CONCURRENT_CLIENTS = 10;

// Get the configured number of concurrent clients
const getConcurrentClientsCount = () => {
  const configuredCount = parseInt(localStorage.getItem('gemini_concurrent_clients'), 10);
  if (!isNaN(configuredCount)) {
    // Ensure the count is within valid range (1 to MAX_CONCURRENT_CLIENTS)
    return Math.min(Math.max(configuredCount, 1), MAX_CONCURRENT_CLIENTS);
  }
  return DEFAULT_CONCURRENT_CLIENTS;
};

// Client pool for managing multiple WebSocket connections
const clientPool = {
  clients: [],
  apiKey: null,
  modelName: null,
  voiceName: null,
  languageCode: null,
  initialized: false,
  initializing: false
};

/**
 * Initialize the client pool with multiple WebSocket clients
 * @param {string} apiKey - Gemini API key (optional, will use key manager if not provided)
 * @param {string} modelName - Model name to use
 * @param {string} voiceName - Voice name to use
 * @param {string} languageCode - Language code for speech synthesis
 * @returns {Promise<boolean>} - Whether initialization was successful
 */
export const initializeClientPool = async (apiKey, modelName, voiceName, languageCode) => {
  // Get API key from key manager if not provided
  if (!apiKey) {
    apiKey = getNextAvailableKey();
    if (!apiKey) {
      throw new Error('No valid Gemini API key available. Please add at least one API key in Settings.');
    }
  }

  // If already initialized with the same parameters, return immediately
  if (clientPool.initialized &&
      clientPool.apiKey === apiKey &&
      clientPool.modelName === modelName &&
      clientPool.voiceName === voiceName &&
      clientPool.languageCode === languageCode) {
    return true;
  }

  // If already initializing, wait for it to complete
  if (clientPool.initializing) {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (clientPool.initialized) {
          clearInterval(checkInterval);
          resolve(true);
        } else if (!clientPool.initializing) {
          clearInterval(checkInterval);
          reject(new Error('Client pool initialization failed'));
        }
      }, 100);
    });
  }

  try {
    clientPool.initializing = true;

    // Close any existing clients
    await disconnectAllClients();

    // Reset the client pool
    clientPool.clients = [];
    clientPool.apiKey = apiKey;
    clientPool.modelName = modelName;
    clientPool.voiceName = voiceName;
    clientPool.languageCode = languageCode;

    // Create the specified number of clients
    const concurrentClients = getConcurrentClientsCount();
    console.log(`Initializing pool with ${concurrentClients} WebSocket clients`);

    // Create all clients in parallel
    const clientPromises = [];
    for (let i = 0; i < concurrentClients; i++) {
      clientPromises.push(createClient(apiKey, modelName, voiceName, languageCode, i));
    }

    // Wait for all clients to be created
    const results = await Promise.allSettled(clientPromises);

    // Filter out any failed clients
    const successfulClients = results
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value);

    if (successfulClients.length === 0) {
      throw new Error('Failed to create any WebSocket clients');
    }

    // Log how many clients were successfully created
    console.log(`Successfully created ${successfulClients.length} of ${concurrentClients} WebSocket clients`);

    clientPool.clients = successfulClients;
    clientPool.initialized = true;
    clientPool.initializing = false;

    // If we have fewer clients than requested, log a warning
    if (successfulClients.length < concurrentClients) {
      console.warn(`Warning: Only ${successfulClients.length} of ${concurrentClients} requested WebSocket clients were created successfully. The system will operate with reduced concurrency.`);
    }

    return true;
  } catch (error) {
    console.error('Error initializing client pool:', error);
    clientPool.initializing = false;
    clientPool.initialized = false;
    throw error;
  }
};

/**
 * Create a single WebSocket client
 * @param {string} apiKey - Gemini API key
 * @param {string} modelName - Model name to use
 * @param {string} voiceName - Voice name to use
 * @param {string} languageCode - Language code for speech synthesis
 * @param {number} index - Client index for identification
 * @returns {Promise<Object>} - Client object with client instance and status
 */
const createClient = async (apiKey, modelName, voiceName, languageCode, index) => {
  const client = new GeminiWebSocketClient(apiKey);

  // Create the client object
  const clientObj = {
    client,
    index,
    busy: false,
    connected: false,
    setupComplete: false,
    lastUsed: 0
  };

  // Set up event listeners
  client.on('setupcomplete', () => {
    clientObj.setupComplete = true;
    console.log(`WebSocket client ${index} setup complete`);
  });

  client.on('close', (event) => {
    clientObj.connected = false;
    clientObj.setupComplete = false;
    console.log(`WebSocket client ${index} closed`);
  });

  // Connect to the WebSocket API
  try {
    // Use the same configuration format as in the live-api-web-console
    const config = {
      model: modelName,
      generationConfig: {
        topK: 32,
        topP: 0.95,
        maxOutputTokens: 1024,
        responseModalities: "audio",
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName
            }
          },
          languageCode: languageCode
        }
      },
      systemInstruction: {
        parts: [
          { text: "You are a narrator. When asked to read a text, YOU MUST ONLY READ IT OUT LOUD AND DO NOT ASK BACK ANY QUESTIONS." }
        ]
      }
    };

    await client.connect(config);
    clientObj.connected = true;

    // Wait for setup to complete
    if (!clientObj.setupComplete) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(`Setup completion timeout for client ${index}`));
        }, 10000); // 10 second timeout

        client.once('setupcomplete', () => {
          clearTimeout(timeout);
          resolve();
        });

        // Also listen for close events during setup
        const closeHandler = (event) => {
          clearTimeout(timeout);
          reject(new Error(`Connection closed during setup for client ${index}: ${event?.reason || 'No reason provided'}`));
        };

        client.once('close', closeHandler);

        // Remove the close handler once setup is complete
        client.once('setupcomplete', () => {
          client.removeListener('close', closeHandler);
        });
      });
    }

    return clientObj;
  } catch (error) {
    console.error(`Error creating WebSocket client ${index}:`, error);

    // Blacklist the API key if there's a connection error
    if (error.message && (
      error.message.includes('Could not connect') ||
      error.message.includes('403') ||
      error.message.includes('401') ||
      error.message.includes('Forbidden') ||
      error.message.includes('Unauthorized')
    )) {
      console.warn(`Blacklisting API key due to connection error: ${error.message}`);
      blacklistKey(apiKey);
    }

    throw error;
  }
};

/**
 * Disconnect all WebSocket clients in the pool
 */
export const disconnectAllClients = async () => {
  if (clientPool.clients.length > 0) {
    console.log(`Disconnecting ${clientPool.clients.length} WebSocket clients`);

    for (const clientObj of clientPool.clients) {
      try {
        if (clientObj.client && clientObj.connected) {
          clientObj.client.disconnect();
        }
      } catch (error) {
        console.error(`Error disconnecting client ${clientObj.index}:`, error);
      }
    }

    clientPool.clients = [];
    clientPool.initialized = false;
  }
};

/**
 * Get the next available WebSocket client from the pool
 * @param {number} maxRetries - Maximum number of retries (default: 5)
 * @param {number} retryDelayMs - Delay between retries in milliseconds (default: 100)
 * @returns {Promise<Object>} - Client object with client instance and status
 */
export const getNextAvailableClient = async (maxRetries = 5, retryDelayMs = 100) => {
  if (!clientPool.initialized) {
    throw new Error('Client pool not initialized. Call initializeClientPool first.');
  }

  let retries = 0;

  while (retries <= maxRetries) {
    // First, try to find a non-busy client
    let availableClient = clientPool.clients.find(c => !c.busy && c.connected && c.setupComplete);

    // If no non-busy client is found, get the least recently used client
    if (!availableClient) {
      // Sort by last used timestamp (ascending)
      const sortedClients = [...clientPool.clients]
        .filter(c => c.connected && c.setupComplete)
        .sort((a, b) => a.lastUsed - b.lastUsed);

      // Find the first client that's not busy, or the least recently used client if all are busy
      availableClient = sortedClients.find(c => !c.busy) || (sortedClients.length > 0 ? sortedClients[0] : null);
    }

    // If we found an available client
    if (availableClient) {
      // Mark the client as busy and update last used timestamp
      availableClient.busy = true;
      availableClient.lastUsed = Date.now();

      console.log(`Assigned client ${availableClient.index} (retry attempt: ${retries})`);
      return availableClient;
    }

    // Check if we can create a new client
    if (clientPool.clients.length < MAX_CONCURRENT_CLIENTS) {
      try {
        console.log(`All clients busy, creating a new client (current count: ${clientPool.clients.length})`);

        // Create a new client with the same parameters as the existing ones
        const newClientIndex = clientPool.clients.length;
        const newClient = await createClient(
          clientPool.apiKey,
          clientPool.modelName,
          clientPool.voiceName,
          clientPool.languageCode,
          newClientIndex
        );

        // Add the new client to the pool
        clientPool.clients.push(newClient);

        // Mark the client as busy and update last used timestamp
        newClient.busy = true;
        newClient.lastUsed = Date.now();

        console.log(`Created and assigned new client ${newClientIndex}`);
        return newClient;
      } catch (error) {
        console.error('Error creating new client:', error);
        // Continue with retries if we can't create a new client
      }
    }

    // If we've reached the maximum number of retries, throw an error
    if (retries === maxRetries) {
      throw new Error(`No available WebSocket clients in the pool after ${maxRetries} retry attempts`);
    }

    // Wait before trying again
    console.log(`No available clients, retrying in ${retryDelayMs}ms (attempt ${retries + 1}/${maxRetries})`);
    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    retries++;
  }

  // This should never be reached due to the throw in the loop, but just in case
  throw new Error('No available WebSocket clients in the pool');
};

/**
 * Mark a client as no longer busy
 * @param {Object} clientObj - Client object to mark as not busy
 */
export const markClientAsNotBusy = (clientObj) => {
  if (clientObj && clientPool.clients.includes(clientObj)) {
    clientObj.busy = false;
  }
};

/**
 * Get the client pool for direct access to client information
 * @returns {Object} - The client pool object
 */
export const getClientPool = () => {
  return clientPool;
};

/**
 * Get or create a WebSocket client (legacy method for backward compatibility)
 * @param {string} apiKey - Gemini API key (optional, will use key manager if not provided)
 * @param {string} modelName - Optional model name to use
 * @param {string} voiceName - Optional voice name to use
 * @param {string} languageCode - Optional language code for speech synthesis
 * @returns {Promise<GeminiWebSocketClient>} - WebSocket client
 */
export const getWebSocketClient = async (apiKey, modelName = null, voiceName = null, languageCode = null) => {
  // Get API key from key manager if not provided
  if (!apiKey) {
    apiKey = getNextAvailableKey();
    if (!apiKey) {
      throw new Error('No valid Gemini API key available. Please add at least one API key in Settings.');
    }
  }

  // Get the voice name from localStorage if not provided
  if (!voiceName) {
    voiceName = localStorage.getItem('gemini_voice') || 'Aoede'; // Default to Aoede if not set
  }

  // Default language code to English if not provided
  if (!languageCode) {
    languageCode = 'en-US';
  }

  // Find a suitable model if not provided
  if (!modelName) {
    modelName = await findSuitableAudioModel(apiKey);
  }

  // Initialize the client pool if needed
  if (!clientPool.initialized) {
    await initializeClientPool(apiKey, modelName, voiceName, languageCode);
  }

  // Get the next available client
  const clientObj = await getNextAvailableClient();

  // Return just the client instance for backward compatibility
  return clientObj.client;
};
