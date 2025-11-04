/**
 * Gemini Files API implementation
 * Handles uploading and managing files for the Gemini API
 */

import { getNextAvailableKey } from './keyManager';
import { fileToBase64 } from './utils';

/**
 * Upload a file to Gemini Files API
 * @param {File} file - The file to upload
 * @param {string} displayName - Optional display name for the file
 * @returns {Promise<Object>} - Upload result with file URI and metadata
 */
export const uploadFileToGemini = async (file, displayName = null, options = {}) => {
  const geminiApiKey = getNextAvailableKey();
  if (!geminiApiKey) {
    throw new Error('No valid Gemini API key available. Please add at least one API key in Settings.');
  }
  // Note: Do NOT send custom headers like X-Run-Id to Google endpoints to avoid CORS issues

  try {
    // Step 1: Start resumable upload
    const startResponse = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'x-goog-api-key': geminiApiKey,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': file.size.toString(),
        'X-Goog-Upload-Header-Content-Type': file.type,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file: {
          display_name: displayName || file.name
        }
      })
    });

    if (!startResponse.ok) {
      const errorData = await startResponse.json();
      throw new Error(`Failed to start upload: ${errorData.error?.message || startResponse.statusText}`);
    }

    // Get upload URL from response headers
    const uploadUrl = startResponse.headers.get('x-goog-upload-url');
    if (!uploadUrl) {
      throw new Error('No upload URL received from Gemini');
    }

    // Step 2: Upload file data
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': file.size.toString(),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: file
    });

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json();
      throw new Error(`Failed to upload file: ${errorData.error?.message || uploadResponse.statusText}`);
    }

    const uploadResult = await uploadResponse.json();
    
    // Step 3: Wait for processing if needed
    if (uploadResult.file?.state === 'PROCESSING') {
      console.log('File is processing, waiting for completion...');
      await waitForFileProcessing(uploadResult.file.name, geminiApiKey, 300000);
    }

    return {
      uri: uploadResult.file.uri,
      name: uploadResult.file.name,
      mimeType: uploadResult.file.mimeType,
      sizeBytes: uploadResult.file.sizeBytes,
      createTime: uploadResult.file.createTime,
      updateTime: uploadResult.file.updateTime,
      expirationTime: uploadResult.file.expirationTime,
      sha256Hash: uploadResult.file.sha256Hash,
      state: uploadResult.file.state
    };

  } catch (error) {
    console.error('Error uploading file to Gemini:', error);
    throw error;
  }
};

/**
 * Wait for file processing to complete
 * @param {string} fileName - The file name returned from upload
 * @param {string} apiKey - Gemini API key
 * @param {number} maxWaitTime - Maximum time to wait in milliseconds
 * @returns {Promise<Object>} - File info when processing is complete
 */
const waitForFileProcessing = async (fileName, apiKey, maxWaitTime = 300000) => { // 5 minutes max
  const startTime = Date.now();
  const pollInterval = 2000; // 2 seconds

  while (Date.now() - startTime < maxWaitTime) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}`, {
        headers: {
          'x-goog-api-key': apiKey
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to check file status: ${response.statusText}`);
      }

      const fileInfo = await response.json();
      
      if (fileInfo.state === 'ACTIVE') {
        console.log('File processing completed successfully');
        return fileInfo;
      } else if (fileInfo.state === 'FAILED') {
        throw new Error('File processing failed');
      }

      // Still processing, wait and try again
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      
    } catch (error) {
      console.error('Error checking file processing status:', error);
      throw error;
    }
  }

  throw new Error('File processing timeout - file took too long to process');
};

/**
 * Get file information
 * @param {string} fileName - The file name
 * @returns {Promise<Object>} - File information
 */
export const getFileInfo = async (fileName, options = {}) => {
  const geminiApiKey = getNextAvailableKey();
  if (!geminiApiKey) {
    throw new Error('No valid Gemini API key available');
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}`, {
      headers: {
        'x-goog-api-key': geminiApiKey
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to get file info: ${errorData.error?.message || response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error getting file info:', error);
    throw error;
  }
};

/**
 * Delete a file from Gemini Files API
 * @param {string} fileName - The file name to delete
 * @returns {Promise<void>}
 */
export const deleteFile = async (fileName, options = {}) => {
  const geminiApiKey = getNextAvailableKey();
  if (!geminiApiKey) {
    throw new Error('No valid Gemini API key available');
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}`, {
      method: 'DELETE',
      headers: {
        'x-goog-api-key': geminiApiKey
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to delete file: ${errorData.error?.message || response.statusText}`);
    }

    console.log(`File ${fileName} deleted successfully`);
  } catch (error) {
    console.error('Error deleting file:', error);
    throw error;
  }
};

/**
 * List uploaded files
 * @param {number} pageSize - Number of files to return per page
 * @param {string} pageToken - Token for pagination
 * @returns {Promise<Object>} - List of files with pagination info
 */
export const listFiles = async (pageSize = 10, pageToken = null, options = {}) => {
  const geminiApiKey = getNextAvailableKey();
  if (!geminiApiKey) {
    throw new Error('No valid Gemini API key available');
  }

  try {
    const params = new URLSearchParams();
    params.append('pageSize', pageSize.toString());
    if (pageToken) {
      params.append('pageToken', pageToken);
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/files?${params}`, {
      headers: {
        'x-goog-api-key': geminiApiKey
      }
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Failed to list files: ${errorData.error?.message || response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error listing files:', error);
    throw error;
  }
};

/**
 * Check if a file should use Files API based on size and duration
 * @param {File} file - The file to check
 * @param {number} estimatedDuration - Estimated duration in seconds (optional)
 * @returns {boolean} - True if should use Files API
 */
export const shouldUseFilesApi = (file, estimatedDuration = null) => {
  const FILE_SIZE_THRESHOLD = 20 * 1024 * 1024; // 20MB
  const DURATION_THRESHOLD = 60; // 1 minute

  // Always use Files API for files larger than 20MB
  if (file.size > FILE_SIZE_THRESHOLD) {
    return true;
  }

  // Use Files API for videos longer than 1 minute (if duration is known)
  if (estimatedDuration && estimatedDuration > DURATION_THRESHOLD) {
    return true;
  }

  // For now, default to Files API for better caching and reuse
  // This can be made configurable later
  return true;
};
