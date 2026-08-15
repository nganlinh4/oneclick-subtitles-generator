import { PROMPT_PRESETS } from '../../services/geminiService';
import { abortVideoAnalysis } from '../../services/videoAnalysisService';
import {
  getCurrentCacheId as getRulesCacheId,
  setTranscriptionRules,
  setTranscriptionRulesForCache,
} from '../../utils/transcriptionRulesStore';
import {
  getCurrentCacheId as getSubtitlesCacheId,
  setUserProvidedSubtitlesForCache,
} from '../../utils/userSubtitlesStore';
import { isNativeMediaDescriptor } from '../../platform/mediaService';
import { generateFileCacheId } from '../../utils/cacheUtils';
import { resolveProjectForCache } from '../../platform/subtitleProjectStore';

const rulesEditorContexts = new WeakMap();

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
    uploadedFile,
    t = (key, defaultValue) => defaultValue // Provide a default implementation if t is not available
  } = appState;
  let rulesEditorContextRef = rulesEditorContexts.get(setShowRulesEditor);
  if (!rulesEditorContextRef) {
    rulesEditorContextRef = { current: null };
    rulesEditorContexts.set(setShowRulesEditor, rulesEditorContextRef);
  }

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
  const captureRulesEditorContext = async () => {
    const cacheId = await getCacheIdForCurrentVideo();
    if (!cacheId
        || getRulesCacheId() !== cacheId
        || getSubtitlesCacheId() !== cacheId) {
      throw new Error('The active subtitle project changed.');
    }
    const project = await resolveProjectForCache(cacheId, { create: true });
    if (!project?.projectId
        || getRulesCacheId() !== cacheId
        || getSubtitlesCacheId() !== cacheId) {
      throw new Error('The active subtitle project changed.');
    }
    return Object.freeze({ cacheId, projectId: project.projectId });
  };

  const handleEditRules = async (rules) => {
    try {
      rulesEditorContextRef.current = await captureRulesEditorContext();
      setShowVideoAnalysis(false);
      setTimeout(() => {
        setTranscriptionRulesState(rules);
        setShowRulesEditor(true);
      }, 50);
      return true;
    } catch {
      setStatus({
        message: t('errors.activeProjectChanged', 'The active subtitle project changed.'),
        type: 'error',
      });
      return false;
    }
  };

  /**
   * Handle saving the edited transcription rules
   */
  const handleSaveRules = async (editedRules) => {
    const context = await (rulesEditorContextRef.current ?? captureRulesEditorContext());
    if (getRulesCacheId() !== context.cacheId
        || getSubtitlesCacheId() !== context.cacheId) {
      throw new Error('The active subtitle project changed.');
    }
    await setTranscriptionRulesForCache(context.cacheId, editedRules, {
      expectedProjectId: context.projectId,
    });
    const projectAfterWrite = await resolveProjectForCache(context.cacheId, { create: false });
    if (getRulesCacheId() !== context.cacheId
        || getSubtitlesCacheId() !== context.cacheId
        || projectAfterWrite?.projectId !== context.projectId) {
      throw new Error('The active subtitle project changed.');
    }
    setTranscriptionRulesState(editedRules);

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
  const handleViewRules = async () => {
    try {
      rulesEditorContextRef.current = await captureRulesEditorContext();
      setShowRulesEditor(true);
      return true;
    } catch {
      setStatus({
        message: t('errors.activeProjectChanged', 'The active subtitle project changed.'),
        type: 'error',
      });
      return false;
    }
  };

  /**
   * Handle adding or updating user-provided subtitles
   */
  const handleUserSubtitlesAdd = async (subtitlesText) => {
    const cacheId = await getCacheIdForCurrentVideo();
    if (!cacheId) throw new Error('The active subtitle project is unavailable.');
    if (getSubtitlesCacheId() !== cacheId) throw new Error('The active subtitle project changed.');
    const project = await resolveProjectForCache(cacheId, { create: true });
    if (!project?.projectId || getSubtitlesCacheId() !== cacheId) {
      throw new Error('The active subtitle project changed.');
    }
    await setUserProvidedSubtitlesForCache(cacheId, subtitlesText, {
      expectedProjectId: project.projectId,
    });
    const projectAfterWrite = await resolveProjectForCache(cacheId, { create: false });
    if (getSubtitlesCacheId() !== cacheId
        || projectAfterWrite?.projectId !== project.projectId) {
      throw new Error('The active subtitle project changed.');
    }
    setUserProvidedSubtitlesState(subtitlesText);

    // The enablement flag is part of the same persisted result. Clearing the
    // text must not leave timing-generation enabled with no source lines.
    const hasProvidedSubtitles = typeof subtitlesText === 'string'
      && subtitlesText.trim() !== '';
    setUseUserProvidedSubtitles(hasProvidedSubtitles);
    localStorage.setItem('use_user_provided_subtitles', String(hasProvidedSubtitles));

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
    }

    const storedCacheId = localStorage.getItem('current_file_cache_id');
    if (typeof storedCacheId === 'string' && storedCacheId.length > 0 && storedCacheId.length <= 8_192) {
      return storedCacheId;
    }
    if (isNativeMediaDescriptor(uploadedFile)) return uploadedFile.assetId;
    if (uploadedFile instanceof File) return await generateFileCacheId(uploadedFile);
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
