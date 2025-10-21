/**
 * Service for analyzing videos with Gemini before splitting
 */

import { createVideoAnalysisSchema, addResponseSchema } from '../utils/schemaUtils';
import { addThinkingConfig } from '../utils/thinkingBudgetUtils';
import { callGeminiApiWithFilesApiForAnalysis } from './gemini';
import i18n from '../i18n/i18n';

// Translation function shorthand
const t = (key, fallback) => i18n.t(key, fallback);

// Store the active abort controller for video analysis
let activeAnalysisController = null;

// Maximum number of terminology items to keep to prevent localStorage overflow
const MAX_TERMINOLOGY_ITEMS = 50;

/**
 * Abort any active video analysis request
 */
export const abortVideoAnalysis = () => {
  if (activeAnalysisController) {

    activeAnalysisController.abort();
    activeAnalysisController = null;
    return true;
  }
  return false;
};

/**
 * Sanitize and limit the size of the analysis result to prevent localStorage overflow
 * @param {Object} analysisResult - The raw analysis result from Gemini
 * @returns {Object} - The sanitized analysis result
 */
const sanitizeAnalysisResult = (analysisResult) => {
  if (!analysisResult) return null;

  try {
    // Create a deep copy to avoid modifying the original
    const sanitized = JSON.parse(JSON.stringify(analysisResult));

    // List of valid preset IDs
    const validPresetIds = ['general', 'focus-lyrics', 'extract-text', 'describe-video', 'diarize-speakers', 'chaptering', 'translate-directly'];

    // Ensure we have the required structure and valid preset ID
    if (!sanitized.recommendedPreset || !sanitized.recommendedPreset.id || !validPresetIds.includes(sanitized.recommendedPreset.id)) {
      console.warn('[VideoAnalysis] Invalid or missing preset ID:', sanitized.recommendedPreset?.id, '- defaulting to general');
      sanitized.recommendedPreset = {
        id: 'general',
        reason: sanitized.recommendedPreset?.reason || 'Default preset selected due to invalid or missing recommendation'
      };
    }

    if (!sanitized.transcriptionRules) {
      sanitized.transcriptionRules = {};
    }

    // Limit terminology items if there are too many
    if (sanitized.transcriptionRules.terminology &&
        Array.isArray(sanitized.transcriptionRules.terminology) &&
        sanitized.transcriptionRules.terminology.length > MAX_TERMINOLOGY_ITEMS) {

      sanitized.transcriptionRules.terminology = sanitized.transcriptionRules.terminology.slice(0, MAX_TERMINOLOGY_ITEMS);

      // Add a note about truncation
      if (!sanitized.transcriptionRules.additionalNotes) {
        sanitized.transcriptionRules.additionalNotes = [];
      }
      sanitized.transcriptionRules.additionalNotes.push(
        `Note: The terminology list was truncated from the original analysis as it was too large.`
      );
    }

    return sanitized;
  } catch (error) {
    console.error('Error sanitizing analysis result:', error);
    return {
      recommendedPreset: {
        id: 'general',
        reason: 'Default preset selected due to sanitization error'
      },
      transcriptionRules: {
        additionalNotes: ['Error sanitizing analysis result. Using default settings.']
      }
    };
  }
};

/**
 * Analyzes a video with Gemini to determine the best prompt preset and generate transcription rules
 * @param {File} videoFile - The video file to analyze
 * @param {Function} onStatusUpdate - Callback for status updates
 * @returns {Promise<Object>} - Analysis results
 */
export const analyzeVideoWithGemini = async (videoFile, onStatusUpdate) => {
  // Create a new AbortController and store it
  activeAnalysisController = new AbortController();
  const signal = activeAnalysisController.signal;
  try {
    const geminiApiKey = localStorage.getItem('gemini_api_key');
    if (!geminiApiKey) {
      throw new Error(t('settings.geminiApiKeyRequired', 'Gemini API key not found'));
    }

    // Get the selected model from localStorage or use the default
    const MODEL = localStorage.getItem('video_analysis_model') || "gemini-2.5-flash-lite";

    // Get video duration
    onStatusUpdate({ message: t('input.preparingVideoAnalysis', 'Preparing video for analysis...'), type: 'loading' });
    let videoDuration = 0;
    try {
      // Import dynamically to avoid circular dependencies
      const { getVideoDuration } = await import('../utils/durationUtils');
      videoDuration = await getVideoDuration(videoFile);

    } catch (error) {
      console.warn('Could not determine video duration:', error);
    }

    // Determine how comprehensive the rule set should be based on video length
    const isLongVideo = videoDuration > 600; // More than 10 minutes
    const isVeryLongVideo = videoDuration > 1800; // More than 30 minutes

    // Create the analysis prompt
    const analysisPrompt = `You are an expert video and audio content analyzer. This video is ${Math.round(videoDuration)} seconds long (${Math.round(videoDuration/60)} minutes). Analyze this video and provide:

1. The most suitable transcription preset for this content from the following options:
   - general: General purpose transcription
   - focus-lyrics: Focus on lyrics (for music videos, songs)
   - extract-text: Extract visible text (for presentations, tutorials with text)
   - describe-video: Describe video content (for visual content description)
   - diarize-speakers: Identify different speakers (for multi-person conversations)
   - chaptering: Create chapters based on content (for long-form content)
	Guidance: When in doubt, default to 'general'. Choose 'diarize-speakers' only if there is clear, sustained multi-speaker conversation that will materially benefit from diarization.

2. A detailed rule set for consistent transcription. ${isLongVideo ? 'Since this is a longer video, provide as many detailed rules as possible to ensure consistency across the entire transcription.' : ''} ${isVeryLongVideo ? 'This is a very long video, so an extremely comprehensive rule set is essential - aim for at least 5-10 items in each applicable category.' : ''} Include (only if applicable):
   - Atmosphere: Description of the setting or context
   - Terminology: List of specialized terms and proper nouns with definitions (${isLongVideo ? 'provide as many as you can identify' : 'provide key terms'})
   - Speaker Identification: Descriptions of different speakers (${isLongVideo ? 'be very detailed about voice characteristics, speaking patterns, and any identifying features' : 'basic identification'})
   - Formatting and Style Conventions: How to format specific content (${isLongVideo ? 'be comprehensive and specific' : 'basic guidelines'})
   - Spelling, Grammar, and Punctuation: Special rules for this content (${isLongVideo ? 'include all exceptions and special cases' : 'key rules only'})
   - Relationships and Social Hierarchy: Information about relationships between people
   - Any other aspects that would help ensure consistent, high-quality transcription

Provide your analysis in a structured format that can be used to guide the transcription process.`;

    onStatusUpdate({ message: t('input.analyzingVideo', 'Analyzing video content...'), type: 'loading' });

    // Prepare options for Files API call with very low FPS and resolution for analysis
    const analysisOptions = {
      modelId: MODEL,
      videoMetadata: {
        fps: 0.01  // Ultra low FPS (1 frame every 100 seconds) for maximum token efficiency
      },
      mediaResolution: 'MEDIA_RESOLUTION_LOW',  // Use low resolution to reduce token count
      // We'll need a custom analysis prompt instead of transcription prompt
      analysisMode: true,
      analysisPrompt: analysisPrompt
    };

    // Limit analysis to max 30 minutes (1800 seconds) centered around video middle
    const MAX_ANALYSIS_DURATION = 1800; // 30 minutes in seconds

    if (videoDuration > MAX_ANALYSIS_DURATION) {
      // Calculate center-based offsets for videos longer than 30 minutes
      const centerTime = videoDuration / 2;
      const halfAnalysisDuration = MAX_ANALYSIS_DURATION / 2;

      // Calculate start and end times, ensuring they stay within video bounds
      const startOffset = Math.max(0, Math.floor(centerTime - halfAnalysisDuration));
      const endOffset = Math.min(videoDuration, Math.floor(centerTime + halfAnalysisDuration));

      // Add video metadata with offsets
      analysisOptions.videoMetadata.start_offset = `${startOffset}s`;
      analysisOptions.videoMetadata.end_offset = `${endOffset}s`;

      console.log(`[VideoAnalysis] Limiting analysis to 30 minutes: ${startOffset}s to ${endOffset}s (video duration: ${videoDuration}s)`);

      // Update the analysis prompt to mention we're analyzing a sample
      analysisOptions.analysisPrompt = `You are analyzing a 30-minute sample from the middle of this video (from ${Math.floor(startOffset/60)}:${(startOffset%60).toString().padStart(2,'0')} to ${Math.floor(endOffset/60)}:${(endOffset%60).toString().padStart(2,'0')} of a ${Math.round(videoDuration/60)}-minute video). ${analysisPrompt}`;
    }

    // Use the Files API with shared caching mechanism
    const result = await callGeminiApiWithFilesApiForAnalysis(videoFile, analysisOptions, signal);

    // Extract analysis result from the response
    let analysisResult;

    // Check if result is already structured JSON (from schema response)
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      // Result is already parsed structured JSON from the API
      console.log('[VideoAnalysis] Received structured JSON response from API');
      analysisResult = result;
      console.log('[VideoAnalysis] Recommended preset:', analysisResult.recommendedPreset?.id);
    }
    // Check if result is in text format that needs parsing
    else if (result && result.length > 0 && result[0].text) {
      // The result is in text format, needs parsing
      const analysisText = result[0].text;

      try {
        // Try to parse as JSON if the model returned structured data
        analysisResult = JSON.parse(analysisText);
        console.log('[VideoAnalysis] Parsed JSON from text response');
        console.log('[VideoAnalysis] Recommended preset:', analysisResult.recommendedPreset?.id);
      } catch (e) {
        // If not JSON, create a structured result from the text
        console.log('[VideoAnalysis] Analysis result is not JSON, processing as text');
        analysisResult = {
          rawResponse: analysisText.substring(0, 1000),
          recommendedPreset: {
            id: 'general',
            reason: 'Default preset selected - analysis returned unstructured text'
          },
          transcriptionRules: {
            additionalNotes: [analysisText]
          }
        };
      }
    } else {
      throw new Error('No analysis returned from Gemini');
    }

    // Sanitize the result to prevent localStorage overflow
    const sanitizedResult = sanitizeAnalysisResult(analysisResult);


    return sanitizedResult;
  } catch (error) {
    console.error('Error analyzing video:', error);

    // Clear the active controller
    activeAnalysisController = null;

    // Check if this is an abort error
    if (error.name === 'AbortError') {
      throw new Error('Video analysis was cancelled');
    }

    throw error;
  } finally {
    // Clear the active controller in case of success
    activeAnalysisController = null;
  }
};
