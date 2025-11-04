import { PROMPT_PRESETS } from '../../services/geminiService';
import { abortVideoAnalysis } from '../../services/videoAnalysisService';
import { setTranscriptionRules } from '../../utils/transcriptionRulesStore';
import { setUserProvidedSubtitles, setCurrentCacheId as setSubtitlesCacheId } from '../../utils/userSubtitlesStore';
import { setCurrentCacheId as setRulesCacheId } from '../../utils/transcriptionRulesStore';
import { extractYoutubeVideoId } from '../../utils/videoDownloader';

/**
 * Hook for modal-related handlers
 */
export const useModalHandlers = (appState) => {
  const {
    setShowVideoAnalysis,
    setVideoAnalysisResult,
    videoAnalysisResult,
    setTranscriptionRulesState,
    setShowRulesEditor,
    setStatus,
    setUserProvidedSubtitlesState,
    setUseUserProvidedSubtitles,
    selectedVideo,
    uploadedFile,
    t = (key, defaultValue) => defaultValue // Provide a default implementation if t is not available
  } = appState;

  /**
   * Handle using the recommended preset from video analysis
   * This will use the recommended preset for the current session only,
   * without changing the user's chosen preset in settings
   */
  const handleUseRecommendedPreset = (presetId) => {

    // Find the preset
    const preset = PROMPT_PRESETS.find(p => p.id === presetId);
    if (preset) {
      // Store the preset for the current session only
      // Use sessionStorage instead of localStorage to avoid changing the user's settings
      sessionStorage.setItem('current_session_prompt', preset.prompt);
      sessionStorage.setItem('current_session_preset_id', presetId);

      // Save the transcription rules
      if (videoAnalysisResult && videoAnalysisResult.transcriptionRules) {
        setTranscriptionRules(videoAnalysisResult.transcriptionRules);
        setTranscriptionRulesState(videoAnalysisResult.transcriptionRules);
      }

      // Update status to indicate we're moving forward
      setStatus({
        message: t('output.preparingProcessing', 'Preparing video for processing...'),
        type: 'loading'
      });

      // Dispatch event to notify videoProcessor that user has made a choice
      const userChoiceEvent = new CustomEvent('videoAnalysisUserChoice', {
        detail: {
          presetId,
          transcriptionRules: videoAnalysisResult?.transcriptionRules
        }
      });
      window.dispatchEvent(userChoiceEvent);


      // Clear the localStorage flags and set processing flag
      localStorage.removeItem('show_video_analysis');
      localStorage.removeItem('video_analysis_timestamp');
      localStorage.removeItem('video_analysis_result'); // Also clear the result
      localStorage.setItem('video_processing_in_progress', 'true'); // Set processing flag


      // Close the modal
      setShowVideoAnalysis(false);
      setVideoAnalysisResult(null); // Clear the result to prevent re-showing

    }
  };

  /**
   * Handle using the default preset from settings
   * This will use the user's chosen preset from settings
   */
  const handleUseDefaultPreset = () => {


    // Clear any session-specific prompt to ensure we use the user's chosen preset
    sessionStorage.removeItem('current_session_prompt');
    sessionStorage.removeItem('current_session_preset_id');


    // Update status to indicate we're moving forward
    setStatus({
      message: t('output.preparingProcessing', 'Preparing video for processing...'),
      type: 'loading'
    });

    // Dispatch event to notify videoProcessor that user has made a choice
    const userChoiceEvent = new CustomEvent('videoAnalysisUserChoice', {
      detail: {
        presetId: null, // Use default preset
        transcriptionRules: videoAnalysisResult?.transcriptionRules // Still use the rules
      }
    });
    window.dispatchEvent(userChoiceEvent);


    // Save the transcription rules
    if (videoAnalysisResult && videoAnalysisResult.transcriptionRules) {
      setTranscriptionRules(videoAnalysisResult.transcriptionRules);
      setTranscriptionRulesState(videoAnalysisResult.transcriptionRules);
    }

    // Clear the localStorage flags and set processing flag
    localStorage.removeItem('show_video_analysis');
    localStorage.removeItem('video_analysis_timestamp');
    localStorage.removeItem('video_analysis_result'); // Also clear the result
    localStorage.setItem('video_processing_in_progress', 'true'); // Set processing flag


    // Close the modal
    setShowVideoAnalysis(false);
    setVideoAnalysisResult(null); // Clear the result to prevent re-showing

  };

  /**
   * Handle editing the transcription rules
   */
  const handleEditRules = (rules) => {

    // First, close the video analysis modal
    setShowVideoAnalysis(false);

    // Use a small timeout to ensure state updates properly
    setTimeout(() => {
      // Then set the rules and open the editor
      setTranscriptionRulesState(rules);
      setShowRulesEditor(true);

    }, 50); // Small delay to ensure proper transition

    // Save the current analysis result to state but don't clear localStorage flags
    // This allows us to reopen the modal when the rules editor is closed

  };

  /**
   * Handle saving the edited transcription rules
   */
  const handleSaveRules = async (editedRules) => {
    // Update state
    setTranscriptionRulesState(editedRules);

    // Set cache ID based on the current video source
    const cacheId = getCacheIdForCurrentVideo();
    if (cacheId) {
      setRulesCacheId(cacheId);

    }

    // Save to store (which will handle caching)
    await setTranscriptionRules(editedRules);

    // Update the analysis result with the edited rules
    if (videoAnalysisResult) {
      setVideoAnalysisResult({
        ...videoAnalysisResult,
        transcriptionRules: editedRules
      });
    }
  };

  /**
   * Handle viewing transcription rules
   */
  const handleViewRules = () => {
    setShowRulesEditor(true);
  };

  /**
   * Handle adding or updating user-provided subtitles
   */
  const handleUserSubtitlesAdd = async (subtitlesText) => {
    // Update state
    setUserProvidedSubtitlesState(subtitlesText);

    // Set cache ID based on the current video source
    const cacheId = getCacheIdForCurrentVideo();
    if (cacheId) {
      setSubtitlesCacheId(cacheId);

    }

    // Save to store (which will handle caching)
    await setUserProvidedSubtitles(subtitlesText);

    // Enable using user-provided subtitles
    setUseUserProvidedSubtitles(true);
    localStorage.setItem('use_user_provided_subtitles', 'true');

  };

  /**
   * Get cache ID for the current video source using unified approach
   */
  const getCacheIdForCurrentVideo = async () => {
    // Check for video URL first (from any source)
    const currentVideoUrl = localStorage.getItem('current_video_url');
    if (currentVideoUrl) {
      // Use unified URL-based caching
  const { generateUrlBasedCacheId } = await import('../../services/subtitleCache');
      return await generateUrlBasedCacheId(currentVideoUrl);
    } else if (uploadedFile) {
      // For uploaded files, use the file name without extension
      const fileName = uploadedFile.name;
      const fileNameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
      return fileNameWithoutExt;
    }
    return null;
  };

  /**
   * Handle aborting video analysis
   */
  const handleAbortVideoAnalysis = () => {
    const analysisAborted = abortVideoAnalysis();
    if (analysisAborted) {
      // If video analysis was aborted, update the status
      setStatus({ message: t('output.videoAnalysisAborted', 'Video analysis aborted'), type: 'warning' });
      // Clear video analysis state
      localStorage.removeItem('show_video_analysis');
      localStorage.removeItem('video_analysis_timestamp');
      localStorage.removeItem('video_analysis_result');
      setShowVideoAnalysis(false);
      setVideoAnalysisResult(null);
    }
    return analysisAborted;
  };

  return {
    handleUseRecommendedPreset,
    handleUseDefaultPreset,
    handleEditRules,
    handleSaveRules,
    handleViewRules,
    handleUserSubtitlesAdd,
    getCacheIdForCurrentVideo,
    handleAbortVideoAnalysis
  };
};
