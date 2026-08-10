import { useEffect } from 'react';
import useNarrationHandlers from './useNarrationHandlers';
import useNarrationEffects, { createSetReferenceTextWithCache } from './useNarrationEffects';

// Import custom hooks
import useNarrationState from './useNarrationState';
import useAvailabilityCheck from './useAvailabilityCheck';
import useAudioPlayback from './useAudioPlayback';
import useNarrationStorage from './useNarrationStorage';
import useUIEffects from './useUIEffects';
import useNarrationCache from './useNarrationCache';
import useWindowStateManager from './useWindowStateManager';
import useNativeNarrationController from './useNativeNarrationController';

/**
 * Orchestrates all narration state, the per-method generation hooks, side-effects and handlers
 * for UnifiedNarrationSection. Keeps the component a thin render layer.
 *
 * @param {Object} params - Parameters
 * @param {Array} params.subtitles - Subtitles to generate narration for (fallback)
 * @param {Array} params.originalSubtitles - Original subtitles
 * @param {Array} params.translatedSubtitles - Translated subtitles (optional)
 * @param {string} params.videoPath - Path to the current video (optional)
 * @param {Function} params.onReferenceAudioChange - Callback when reference audio changes
 * @param {Object} params.initialReferenceAudio - Initial reference audio
 * @param {Function} params.t - i18next translation function
 * @param {Object} params.fileInputRef - Ref to the hidden file input
 * @param {Object} params.mediaRecorderRef - Ref to the MediaRecorder
 * @param {Object} params.audioChunksRef - Ref to recorded audio chunks
 * @param {Object} params.statusRef - Ref to the status element
 * @param {Object} params.sectionRef - Ref to the section element
 * @returns {Object} - Everything the render layer needs
 */
const useUnifiedNarration = ({
  subtitles,
  originalSubtitles,
  translatedSubtitles,
  videoPath,
  onReferenceAudioChange,
  initialReferenceAudio,
  t,
  fileInputRef,
  mediaRecorderRef,
  audioChunksRef,
  statusRef,
  sectionRef
}) => {
  // Use custom hooks for state management
  const narrationState = useNarrationState(initialReferenceAudio);

  // Destructure state from the hook
  const {
    // Narration Method state
    narrationMethod, setNarrationMethod,
    isGeminiAvailable, setIsGeminiAvailable,
    isChatterboxAvailable, setIsChatterboxAvailable,

    // Gemini-specific settings
    selectedVoice, setSelectedVoice,
    concurrentClients, setConcurrentClients,

    // Chatterbox-specific settings
    exaggeration, setExaggeration,
    cfgWeight, setCfgWeight,
    chatterboxLanguage, setChatterboxLanguage,

    // Edge TTS-specific settings
    edgeTTSVoice, setEdgeTTSVoice,
    edgeTTSRate, setEdgeTTSRate,
    edgeTTSVolume, setEdgeTTSVolume,
    edgeTTSPitch, setEdgeTTSPitch,

    // gTTS-specific settings
    gttsLanguage, setGttsLanguage,
    gttsTld, setGttsTld,
    gttsSlow, setGttsSlow,

    // Narration Settings state (for F5-TTS)
    referenceAudio, setReferenceAudio,
    referenceText, setReferenceText,
    isRecording, setIsRecording,
    isStartingRecording, setIsStartingRecording,
    recordingStartTime, setRecordingStartTime,
    setRecordedAudio,
    isExtractingSegment, setIsExtractingSegment,
    segmentStartTime, segmentEndTime,
    autoRecognize, setAutoRecognize,
    isRecognizing, setIsRecognizing,

    // Narration Generation state
    isAvailable, setIsAvailable,
    isGenerating, setIsGenerating,
    generationStatus, setGenerationStatus,
    generationResults, setGenerationResults,
    error, setError,
    currentAudio, setCurrentAudio,
    isPlaying, setIsPlaying,
    subtitleSource, setSubtitleSource,
    advancedSettings, setAdvancedSettings,
    originalLanguage, setOriginalLanguage,
    translatedLanguage, setTranslatedLanguage,
    retryingSubtitleId, setRetryingSubtitleId,
    useGroupedSubtitles, setUseGroupedSubtitles,
    groupedSubtitles, setGroupedSubtitles,
    isGroupingSubtitles, setIsGroupingSubtitles,
    groupingIntensity, setGroupingIntensity,
    selectedNarrationModel,
    setSelectedNarrationModel,

    // Helper functions
    updateReferenceAudio
  } = narrationState;

  // Use availability check hook
  useAvailabilityCheck({
    narrationMethod,
    setIsAvailable,
    setIsGeminiAvailable,
    setIsChatterboxAvailable,
    setError,
    t
  });

  // Use audio playback hook
  const { audioRef, handleAudioEnded } = useAudioPlayback({
    isPlaying,
    currentAudio,
    setIsPlaying,
    setCurrentAudio
  });

  // Use narration storage hook
  useNarrationStorage({
    generationResults,
    subtitleSource
  });

  // Use UI effects hook
  useUIEffects({
    isGenerating,
    generationStatus,
    statusRef,
    t,
    referenceAudio,
    segmentStartTime,
    segmentEndTime,
    setError
  });

  // Use narration cache hook
  useNarrationCache({
    generationResults,
    setGenerationResults,
    setGenerationStatus,
    subtitleSource,
    originalSubtitles,
    translatedSubtitles,
    subtitles,
    t,
    setReferenceAudio,
    setReferenceText
  });

  // Use window state manager hook
  useWindowStateManager({
    generationResults,
    subtitleSource,
    narrationMethod,
    originalSubtitles,
    translatedSubtitles,
    subtitles,
    useGroupedSubtitles,
    groupedSubtitles,
    setGroupedSubtitles,
    setIsGroupingSubtitles,
    setUseGroupedSubtitles,
    groupingIntensity
  });

  // Wrapper function for setReferenceText that also updates cache
  const setReferenceTextWithCache = createSetReferenceTextWithCache({ referenceAudio, setReferenceText });

  // Update reference audio when initialReferenceAudio changes
  useEffect(() => {
    updateReferenceAudio(initialReferenceAudio);
  }, [initialReferenceAudio, updateReferenceAudio]);

  // Local side-effects: method-switch reset + error / status toast dispatch
  useNarrationEffects({
    narrationMethod,
    setGenerationStatus,
    setError,
    sectionRef,
    error,
    isGenerating,
    retryingSubtitleId,
    generationStatus
  });

  const nativeNarrationHandlers = useNativeNarrationController({
    ...narrationState,
    subtitles,
    originalSubtitles,
    translatedSubtitles,
    t
  });

  // Import the handler functions from separate file to keep this component clean
  const {
    handleFileUpload,
    startRecording,
    stopRecording,
    // extractSegment is available but not used in this component
    clearReferenceAudio,
    handleGenerateNarration,
    playAudio,
    downloadAllAudio,
    downloadAlignedAudio,
    cancelGeneration,
    retryF5TTSNarration,
    retryFailedNarrations,
    generateAllPendingF5TTSNarrations,
    handleExampleSelect
  } = useNarrationHandlers({
    fileInputRef,
    mediaRecorderRef,
    audioChunksRef,
    referenceAudio,
    referenceText,
    setReferenceAudio,
    setReferenceText,
    setRecordedAudio,
    setIsRecording,
    setIsStartingRecording,
    setRecordingStartTime,
    setIsExtractingSegment,
    setIsRecognizing,
    setError,
    autoRecognize,
    segmentStartTime,
    segmentEndTime,
    videoPath,
    onReferenceAudioChange,
    getSelectedSubtitles: () => {
      // Check if we should use grouped subtitles
      if (useGroupedSubtitles && groupedSubtitles && groupedSubtitles.length > 0) {
        return groupedSubtitles;
      }
      if (subtitleSource === 'translated' && translatedSubtitles && translatedSubtitles.length > 0) {
        return translatedSubtitles;
      }
      return originalSubtitles || subtitles;
    },
    advancedSettings,
    setIsGenerating,
    isGenerating,
    setGenerationStatus,
    setGenerationResults,
    generationResults,
    currentAudio,
    setCurrentAudio,
    setIsPlaying,
    statusRef,
    t,
    subtitleSource,
    translatedSubtitles,
    isPlaying,
    selectedNarrationModel,
    originalLanguage,
    translatedLanguage,
    setRetryingSubtitleId,
    useGroupedSubtitles,
    setUseGroupedSubtitles,
    groupedSubtitles,
    narrationMethod,
    nativeNarrationHandlers
  });

  // Check if all narration services are unavailable
  // Edge TTS and gTTS are always available, so only show unavailable message if all 5 methods are unavailable
  const isEdgeTTSAvailable = true; // Edge TTS is always available
  const isGTTSAvailable = true; // gTTS is always available
  const allServicesUnavailable = !isAvailable && !isGeminiAvailable && !isChatterboxAvailable && !isEdgeTTSAvailable && !isGTTSAvailable;

  return {
    // Method state
    narrationMethod, setNarrationMethod,
    isGeminiAvailable, isChatterboxAvailable,
    isAvailable,
    allServicesUnavailable,

    // Gemini settings
    selectedVoice, setSelectedVoice,
    concurrentClients, setConcurrentClients,

    // Chatterbox settings
    exaggeration, setExaggeration,
    cfgWeight, setCfgWeight,
    chatterboxLanguage, setChatterboxLanguage,

    // Edge TTS settings
    edgeTTSVoice, setEdgeTTSVoice,
    edgeTTSRate, setEdgeTTSRate,
    edgeTTSVolume, setEdgeTTSVolume,
    edgeTTSPitch, setEdgeTTSPitch,

    // gTTS settings
    gttsLanguage, setGttsLanguage,
    gttsTld, setGttsTld,
    gttsSlow, setGttsSlow,

    // F5-TTS reference settings
    referenceAudio,
    referenceText,
    isRecording,
    isStartingRecording,
    recordingStartTime,
    isExtractingSegment,
    autoRecognize, setAutoRecognize,
    isRecognizing,

    // Generation state
    isGenerating,
    generationResults,
    error,
    currentAudio,
    isPlaying,
    subtitleSource, setSubtitleSource,
    advancedSettings, setAdvancedSettings,
    originalLanguage, setOriginalLanguage,
    translatedLanguage, setTranslatedLanguage,
    retryingSubtitleId,
    useGroupedSubtitles, setUseGroupedSubtitles,
    groupedSubtitles, setGroupedSubtitles,
    isGroupingSubtitles,
    groupingIntensity, setGroupingIntensity,
    selectedNarrationModel, setSelectedNarrationModel,
    setReferenceTextWithCache,

    // Gemini handlers
    handleGeminiNarration: nativeNarrationHandlers.handleGeminiNarration,
    cancelGeminiGeneration: nativeNarrationHandlers.cancelGeminiGeneration,
    retryGeminiNarration: nativeNarrationHandlers.retryGeminiNarration,
    retryFailedGeminiNarrations: nativeNarrationHandlers.retryFailedGeminiNarrations,
    generateAllPendingGeminiNarrations: nativeNarrationHandlers.generateAllPendingGeminiNarrations,

    // Chatterbox handlers
    handleChatterboxNarration: nativeNarrationHandlers.handleChatterboxNarration,
    cancelChatterboxGeneration: nativeNarrationHandlers.cancelChatterboxGeneration,
    retryChatterboxNarration: nativeNarrationHandlers.retryChatterboxNarration,
    retryFailedChatterboxNarrations: nativeNarrationHandlers.retryFailedChatterboxNarrations,
    generateAllPendingChatterboxNarrations: nativeNarrationHandlers.generateAllPendingChatterboxNarrations,

    // Edge TTS handlers
    handleEdgeTTSNarration: nativeNarrationHandlers.handleEdgeTTSNarration,
    cancelEdgeTTSGeneration: nativeNarrationHandlers.cancelEdgeTTSGeneration,
    retryEdgeTTSNarration: nativeNarrationHandlers.retryEdgeTTSNarration,
    retryFailedEdgeTTSNarrations: nativeNarrationHandlers.retryFailedEdgeTTSNarrations,
    generateAllPendingEdgeTTSNarrations: nativeNarrationHandlers.generateAllPendingEdgeTTSNarrations,

    // gTTS handlers
    handleGTTSNarration: nativeNarrationHandlers.handleGTTSNarration,
    cancelGTTSGeneration: nativeNarrationHandlers.cancelGTTSGeneration,
    retryGTTSNarration: nativeNarrationHandlers.retryGTTSNarration,
    retryFailedGTTSNarrations: nativeNarrationHandlers.retryFailedGTTSNarrations,
    generateAllPendingGTTSNarrations: nativeNarrationHandlers.generateAllPendingGTTSNarrations,

    // Audio playback
    audioRef, handleAudioEnded,

    // F5-TTS / shared handlers
    handleFileUpload,
    startRecording,
    stopRecording,
    clearReferenceAudio,
    handleGenerateNarration,
    playAudio,
    downloadAllAudio,
    downloadAlignedAudio,
    cancelGeneration,
    retryF5TTSNarration,
    retryFailedNarrations,
    generateAllPendingF5TTSNarrations,
    handleExampleSelect
  };
};

export default useUnifiedNarration;
