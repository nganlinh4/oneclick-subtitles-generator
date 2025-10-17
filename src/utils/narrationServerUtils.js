/**
 * Utility functions for narration server interactions
 */

import { SERVER_URL } from '../config';
import React from 'react';
import { createRoot } from 'react-dom/client';
import LoadingIndicator from '../components/common/LoadingIndicator';
import { base64ToArrayBuffer } from './audioConversionUtils';
import { checkAudioAlignmentFromResponse } from './audioAlignmentNotification';

/**
 * Create a React-based loading overlay with LoadingIndicator component
 * @param {string} message - Initial loading message
 * @returns {Object} - Object with container element, root, and update function
 */
const createLoadingOverlay = (message) => {
  // Create container element
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.top = '50%';
  container.style.left = '50%';
  container.style.transform = 'translate(-50%, -50%)';
  container.style.padding = '24px';
  container.style.background = 'rgba(0, 0, 0, 0.85)';
  container.style.borderRadius = '16px';
  container.style.zIndex = '9999';
  container.style.textAlign = 'center';
  container.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3)';
  container.style.minWidth = '280px';
  container.style.backdropFilter = 'blur(8px)';

  // Create React root
  const root = createRoot(container);

  // Loading component
  const LoadingOverlay = ({ message }) => (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '16px',
      color: 'white'
    }}>
      <LoadingIndicator
        theme="light"
        showContainer={false}
        size={48}
        className="download-loading-indicator"
      />
      <div style={{
        fontSize: '16px',
        fontWeight: '500',
        textAlign: 'center',
        lineHeight: '1.4'
      }}>
        {message}
      </div>
    </div>
  );

  // Render initial state
  root.render(<LoadingOverlay message={message} />);

  // Add to document
  document.body.appendChild(container);

  return {
    container,
    root,
    updateMessage: (newMessage) => {
      root.render(<LoadingOverlay message={newMessage} />);
    },
    destroy: () => {
      root.unmount();
      if (document.body.contains(container)) {
        document.body.removeChild(container);
      }
    }
  };
};

/**
 * Save audio data to server
 * @param {Object} result - Narration result object
 * @param {Object} savedToServer - Object tracking saved files
 * @param {Function} setSavedToServer - State setter for savedToServer
 * @param {Array} generationResults - All generation results
 * @returns {Promise<string|null>} - Filename if saved successfully, null otherwise
 */
export const saveAudioToServer = async (result, savedToServer, setSavedToServer, generationResults) => {
  // If already saved, don't save again
  if (savedToServer[result.subtitle_id]) {

    return savedToServer[result.subtitle_id];
  }

  if (result.audioData) {
    try {




      // Validate the audio data
      try {
        // Test decode to make sure it's valid base64
        base64ToArrayBuffer(result.audioData);
      } catch (decodeError) {
        console.error(`Error validating audio data: ${decodeError.message}`);
        throw new Error(`Invalid audio data: ${decodeError.message}`);
      }

      // Send the audio data to the server
      const response = await fetch(`${SERVER_URL}/api/narration/save-gemini-audio`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audioData: result.audioData,
          subtitle_id: result.subtitle_id,
          sampleRate: result.sampleRate || 24000
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Server error response: ${errorText}`);
        throw new Error(`Server returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.success) {

        // Update the result with the filename
        result.filename = data.filename;

        // Update the savedToServer state
        setSavedToServer(prev => ({
          ...prev,
          [result.subtitle_id]: data.filename
        }));

        // Dispatch an event to notify other components that narrations have been updated
        const event = new CustomEvent('narrations-updated', {
          detail: {
            source: 'original', // Assuming Gemini narrations are for original subtitles
            narrations: generationResults.map(r => ({
              ...r,
              filename: r.subtitle_id === result.subtitle_id ? data.filename : (savedToServer[r.subtitle_id] || r.filename)
            }))
          }
        });
        window.dispatchEvent(event);

        return data.filename;
      } else {
        throw new Error(data.error || 'Unknown error saving audio to server');
      }
    } catch (error) {
      console.error(`Error saving audio to server for subtitle ${result.subtitle_id}:`, error);
      return null;
    }
  }
  return null;
};

/**
 * Download aligned narration audio (one file)
 * @param {Array} generationResults - Array of narration results
 * @param {Function} t - Translation function
 * @returns {Promise<void>}
 */
export const downloadAlignedAudio = async (generationResults, t) => {
  // Check if we have any generation results
  if (!generationResults || generationResults.length === 0) {
    alert(t('narration.noResults', 'No narration results to download'));
    return;
  }

  // Create a React-based loading overlay
  const loadingOverlay = createLoadingOverlay(t('narration.preparingDownload', 'Preparing aligned narration file...'));



  try {
    // Get all subtitles from the video for timing information
    const allSubtitles = [];

    // Try to get subtitles from window.subtitles (main source)
    if (window.subtitles && Array.isArray(window.subtitles)) {

      allSubtitles.push(...window.subtitles);
    }

    // Also try original and translated subtitles
    if (window.originalSubtitles && Array.isArray(window.originalSubtitles)) {

      allSubtitles.push(...window.originalSubtitles);
    }

    if (window.translatedSubtitles && Array.isArray(window.translatedSubtitles)) {

      allSubtitles.push(...window.translatedSubtitles);
    }

    // Create a map for faster lookup
    const subtitleMap = {};
    allSubtitles.forEach(sub => {
      if (sub.id !== undefined) {
        subtitleMap[sub.id] = sub;
      }
    });



    // Prepare the data for the aligned narration with correct timing
    const narrationData = generationResults
      .filter(result => result.success && (result.audioData || result.filename))
      .map(result => {
        // Find the corresponding subtitle for timing information
        const subtitle = subtitleMap[result.subtitle_id];

        // If we found a matching subtitle, use its timing
        if (subtitle && typeof subtitle.start === 'number' && typeof subtitle.end === 'number') {

          return {
            filename: result.filename || `gemini_narration_${result.subtitle_id}.wav`,
            subtitle_id: result.subtitle_id,
            start: subtitle.start,
            end: subtitle.end,
            text: result.text || ''
          };
        }

        // Otherwise, use existing timing or defaults
        return {
          filename: result.filename || `gemini_narration_${result.subtitle_id}.wav`,
          subtitle_id: result.subtitle_id,
          start: result.start || 0,
          end: result.end || (result.start ? result.start + 5 : 5),
          text: result.text || ''
        };
      });

    // Sort by start time to ensure correct order
    narrationData.sort((a, b) => a.start - b.start);



    // Create a download link
    const downloadUrl = `${SERVER_URL}/api/narration/download-aligned`;

    // Use fetch API to download the file


    // Update loading indicator text
    loadingOverlay.updateMessage(t('narration.sendingRequest', 'Sending request to server...'));

    let response;
    try {
      response = await fetch(downloadUrl, {
        method: 'POST',
        mode: 'cors',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'audio/wav'
        },
        body: JSON.stringify({ narrations: narrationData })
      });

      // Check for audio alignment notification after successful response
      if (response.ok) {
        checkAudioAlignmentFromResponse(response);
      }



    } catch (fetchError) {
      console.error('Network error during fetch:', fetchError);
      throw new Error(`Network error: ${fetchError.message}`);
    }

    // Check if the response is successful
    if (!response.ok) {
      // Try to parse error message if it's JSON
      try {
        const errorData = await response.json();
        throw new Error(errorData.error || `Server error: ${response.status} ${response.statusText}`);
      } catch (jsonError) {
        // If it's not JSON, use the status text
        throw new Error(`Failed to download aligned audio: ${response.status} ${response.statusText}`);
      }
    }

    // Update loading indicator text
    loadingOverlay.updateMessage(t('narration.processingResponse', 'Processing audio data...'));

    // Get the blob from the response
    let blob;
    try {
      blob = await response.blob();


      // Validate the blob
      if (!blob || blob.size === 0) {
        throw new Error('Received empty audio data from server');
      }
    } catch (blobError) {
      console.error('Error processing response blob:', blobError);
      throw new Error(`Error processing audio data: ${blobError.message}`);
    }

    // Update loading indicator text
    loadingOverlay.updateMessage(t('narration.preparingDownload', 'Preparing download...'));

    // Create a URL for the blob
    let url;
    try {
      url = URL.createObjectURL(blob);

    } catch (urlError) {
      console.error('Error creating blob URL:', urlError);
      throw new Error(`Error creating download: ${urlError.message}`);
    }

    // Create a temporary anchor element
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aligned_narration.wav';
    a.style.display = 'none';
    document.body.appendChild(a);

    // Update loading indicator text
    loadingOverlay.updateMessage(t('narration.startingDownload', 'Starting download...'));

    // Trigger the download
    try {
      a.click();

    } catch (clickError) {
      console.error('Error triggering download:', clickError);
      throw new Error(`Error starting download: ${clickError.message}`);
    }

    // Clean up
    try {
      setTimeout(() => {
        if (document.body.contains(a)) {
          document.body.removeChild(a);
        }
        if (url) {
          URL.revokeObjectURL(url);
        }

      }, 1000); // Increased timeout to ensure download starts
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError);
      // Don't throw here, as the download might still be working
    }
  } catch (error) {
    console.error('Error downloading aligned audio:', error);

    // Update loading indicator to show error
    try {
      loadingOverlay.updateMessage(t('narration.downloadError', 'Error downloading audio'));
      // Change overlay background to indicate error
      loadingOverlay.container.style.background = 'rgba(220, 38, 38, 0.85)';
    } catch (uiError) {
      console.error('Error updating loading indicator:', uiError);
    }

    // Show error message to user
    alert(t('narration.downloadError', `Error downloading aligned audio file: ${error.message}`));

    // Short delay before removing the loading indicator to ensure the user sees the error
    await new Promise(resolve => setTimeout(resolve, 1500));
  } finally {
    // Remove loading overlay
    try {
      loadingOverlay.destroy();
    } catch (cleanupError) {
      console.error('Error during final cleanup:', cleanupError);
    }
  }
};
