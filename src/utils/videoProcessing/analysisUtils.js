/**
 * Utilities for video analysis
 */

import { analyzeVideoWithGemini } from '../../services/videoAnalysisService';
import { setTranscriptionRules } from '../transcriptionRulesStore';

/**
 * Analyze a video file with Gemini and handle user interaction
 * @param {File} analysisFile - The file to analyze
 * @param {Function} onStatusUpdate - Callback for status updates
 * @param {Function} t - Translation function
 * @returns {Promise<Object>} - Analysis result and user choice
 */
export const analyzeVideoAndWaitForUserChoice = async (analysisFile, onStatusUpdate, t) => {
  // Notify user about analysis
  onStatusUpdate({
    message: t('output.analyzingVideo', 'Analyzing video content...'),
    type: 'loading'
  });

  // Dispatch event to notify App.js to show the analysis modal

  const analysisEvent = new CustomEvent('videoAnalysisStarted');
  window.dispatchEvent(analysisEvent);


  try {
    // Analyze the video
    const analysisResult = await analyzeVideoWithGemini(analysisFile, onStatusUpdate);


    // Store the analysis result for the App component to use
    try {
      // Ensure the result can be properly stringified
      const resultString = JSON.stringify(analysisResult);
      // Check if the result is too large for localStorage (typically 5MB limit)
      if (resultString.length > 4 * 1024 * 1024) { // 4MB to be safe
        console.warn('Analysis result is too large for localStorage, truncating...');
        // Create a simplified version with limited terminology
        const simplifiedResult = {
          ...analysisResult,
          transcriptionRules: {
            ...analysisResult.transcriptionRules,
            // Limit terminology to first 20 items if it exists
            terminology: analysisResult.transcriptionRules.terminology ?
              analysisResult.transcriptionRules.terminology.slice(0, 20) : [],
            // Add a note about truncation
            additionalNotes: [
              ...(analysisResult.transcriptionRules.additionalNotes || []),
              'Note: The terminology list was truncated as it was too large for storage.'
            ]
          }
        };
        localStorage.setItem('video_analysis_result', JSON.stringify(simplifiedResult));
      } else {
        localStorage.setItem('video_analysis_result', resultString);
      }
    } catch (error) {
      console.error('Error storing analysis result in localStorage:', error);
      // Store a simplified version instead
      const fallbackResult = {
        recommendedPreset: {
          id: analysisResult.recommendedPreset?.id || 'general',
          reason: 'Preset from analysis (storage error occurred)'
        },
        transcriptionRules: {
          additionalNotes: ['Error storing full analysis result. Using simplified version.']
        }
      };
      localStorage.setItem('video_analysis_result', JSON.stringify(fallbackResult));
    }

    // Open rules editor modal directly with countdown
    // Set the transcription rules globally
    if (analysisResult.transcriptionRules) {
      setTranscriptionRules(analysisResult.transcriptionRules);
    }

    // Set the recommended preset directly in localStorage so it's immediately used
    const recommendedPresetId = analysisResult.recommendedPreset?.id || 'settings';
    localStorage.setItem('video_processing_prompt_preset', recommendedPresetId);
    // Also keep in sessionStorage for reference
    sessionStorage.setItem('current_session_preset_id', recommendedPresetId);
    
    // Store a fingerprint of the analyzed file to tie the recommendation to this specific video
    const videoFingerprint = `${analysisFile.name}_${analysisFile.size}_${analysisFile.lastModified || Date.now()}`;
    sessionStorage.setItem('current_session_video_fingerprint', videoFingerprint);

    // Also set the prompt if we have the preset
    if (recommendedPresetId !== 'settings') {
      const { PROMPT_PRESETS } = await import('../../services/geminiService');
      const recommendedPreset = PROMPT_PRESETS.find(p => p.id === recommendedPresetId);
      if (recommendedPreset) {
        sessionStorage.setItem('current_session_prompt', recommendedPreset.prompt);
      }
    }

    // Dispatch event to open the rules editor with countdown
    const openRulesEditorEvent = new CustomEvent('openRulesEditorWithCountdown', {
      detail: {
        transcriptionRules: analysisResult.transcriptionRules,
        analysisResult: analysisResult,
        recommendedPresetId: recommendedPresetId,
        showCountdown: true // Flag to show countdown
      }
    });
    window.dispatchEvent(openRulesEditorEvent);

    // Return the analysis result with a default choice (use recommended preset)
    const userChoice = {
      presetId: recommendedPresetId,
      transcriptionRules: analysisResult.transcriptionRules
    };

    return {
      analysisResult,
      userChoice
    };
  } catch (error) {
    console.error('Error analyzing video:', error);
    throw error;
  }
};
