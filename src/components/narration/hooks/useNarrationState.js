import { useState, useCallback } from 'react';
import { usePreference } from '../../../platform/preferences/store';
import { NARRATION_METHODS } from '../../../platform/preferences/narrationKeys';

export const normalizeNarrationMethod = (method) => (
  NARRATION_METHODS.includes(method) ? method : 'gemini'
);

/**
 * Custom hook for managing narration state. Engine choices and tuning are per-device preferences;
 * everything else is session state.
 * @param {Object} initialReferenceAudio - Initial reference audio
 * @returns {Object} - Narration state and setters
 */
const useNarrationState = (initialReferenceAudio) => {
  const [narrationMethod, setStoredNarrationMethod] = usePreference('narration_method');
  const setNarrationMethod = useCallback((method) => {
    setStoredNarrationMethod(normalizeNarrationMethod(method));
  }, [setStoredNarrationMethod]);
  const [isGeminiAvailable, setIsGeminiAvailable] = useState(false);
  // Managed engines are selectable capabilities from the first frame. Their verified package and
  // worker state is resolved on demand when the customer asks to generate.
  const [isChatterboxAvailable, setIsChatterboxAvailable] = useState(true);
  const [isEdgeTTSAvailable, setIsEdgeTTSAvailable] = useState(true);
  const [isGTTSAvailable, setIsGTTSAvailable] = useState(true);
  const [isCheckingAvailability, setIsCheckingAvailability] = useState(true);

  // Engine-specific settings
  const [selectedVoice, setSelectedVoice] = usePreference('gemini_voice');
  const [concurrentClients, setConcurrentClients] = usePreference('gemini_concurrent_clients');
  const [exaggeration, setExaggeration] = usePreference('chatterbox_exaggeration');
  const [cfgWeight, setCfgWeight] = usePreference('chatterbox_cfg_weight');
  const [chatterboxLanguage, setChatterboxLanguage] = usePreference('chatterbox_language');
  const [edgeTTSVoice, setEdgeTTSVoice] = usePreference('edge_tts_voice');
  const [edgeTTSRate, setEdgeTTSRate] = usePreference('edge_tts_rate');
  const [edgeTTSVolume, setEdgeTTSVolume] = usePreference('edge_tts_volume');
  const [edgeTTSPitch, setEdgeTTSPitch] = usePreference('edge_tts_pitch');
  const [gttsLanguage, setGttsLanguage] = usePreference('gtts_language');
  const [gttsTld, setGttsTld] = usePreference('gtts_tld');
  const [gttsSlow, setGttsSlow] = usePreference('gtts_slow');

  // Narration Settings state (for F5-TTS)
  const [referenceAudio, setReferenceAudio] = useState(initialReferenceAudio);
  const [referenceText, setReferenceText] = useState(initialReferenceAudio?.text || '');
  const [isRecording, setIsRecording] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [recordingStartTime, setRecordingStartTime] = useState(null);
  // recordedAudio is used in the handlers but not directly in this component
  const [recordedAudio, setRecordedAudio] = useState(null);
  const [isExtractingSegment, setIsExtractingSegment] = useState(false);
  const [segmentStartTime, setSegmentStartTime] = useState('');
  const [segmentEndTime, setSegmentEndTime] = useState('');
  const [autoRecognize, setAutoRecognize] = useState(true); // Default to true
  const [isRecognizing, setIsRecognizing] = useState(false);

  // Narration Generation state
  const [isAvailable, setIsAvailable] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [generationResults, setGenerationResults] = useState([]);
  // Result ownership is independent from the currently selected radio button. Keeping the source
  // beside the rows prevents a source switch from relabelling already-generated audio.
  const [generationResultSource, setGenerationResultSource] = useState('original');
  const [error, setError] = useState('');
  const [currentAudio, setCurrentAudio] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // Subtitle availability belongs to the active project. A browser-global preference can select
  // translated rows that do not exist in the next project, so each editor session starts safely.
  const [subtitleSource, setSubtitleSource] = useState('original');
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [detectedLanguage, setDetectedLanguage] = useState(null);
  const [storedNarrationModel, setStoredNarrationModel] = usePreference('last_used_narration_model');
  const selectedNarrationModel = storedNarrationModel || null;
  const setSelectedNarrationModel = useCallback((modelId) => {
    setStoredNarrationModel(modelId || '');
  }, [setStoredNarrationModel]);
  const [modelAvailabilityError, setModelAvailabilityError] = useState(null);
  const [originalLanguage, setOriginalLanguage] = useState(null);
  const [translatedLanguage, setTranslatedLanguage] = useState(null);
  const [retryingSubtitleId, setRetryingSubtitleId] = useState(null);
  const [useGroupedSubtitles, setUseGroupedSubtitles] = useState(false);
  const [groupedSubtitles, setGroupedSubtitles] = useState(null);
  const [isGroupingSubtitles, setIsGroupingSubtitles] = useState(false);
  const [groupingIntensity, setGroupingIntensity] = usePreference('grouping_intensity');
  const [advancedSettings, setAdvancedSettings] = usePreference('narration_advanced_settings');

  // Update local state when initialReferenceAudio changes - memoized to avoid identity changes across renders
  const updateReferenceAudio = useCallback((newReferenceAudio) => {
    if (newReferenceAudio) {
      setReferenceAudio(newReferenceAudio);
      setReferenceText(newReferenceAudio.text || '');
    }
  }, []);

  return {
    // Narration Method state
    narrationMethod,
    setNarrationMethod,
    isGeminiAvailable,
    setIsGeminiAvailable,
    isChatterboxAvailable,
    setIsChatterboxAvailable,
    isEdgeTTSAvailable,
    setIsEdgeTTSAvailable,
    isGTTSAvailable,
    setIsGTTSAvailable,
    isCheckingAvailability,
    setIsCheckingAvailability,

    // Gemini-specific settings
    selectedVoice,
    setSelectedVoice,
    concurrentClients,
    setConcurrentClients,

    // Chatterbox-specific settings
    exaggeration,
    setExaggeration,
    cfgWeight,
    setCfgWeight,
    chatterboxLanguage,
    setChatterboxLanguage,

    // Edge TTS-specific settings
    edgeTTSVoice,
    setEdgeTTSVoice,
    edgeTTSRate,
    setEdgeTTSRate,
    edgeTTSVolume,
    setEdgeTTSVolume,
    edgeTTSPitch,
    setEdgeTTSPitch,

    // gTTS-specific settings
    gttsLanguage,
    setGttsLanguage,
    gttsTld,
    setGttsTld,
    gttsSlow,
    setGttsSlow,

    // Narration Settings state (for F5-TTS)
    referenceAudio,
    setReferenceAudio,
    referenceText,
    setReferenceText,
    isRecording,
    setIsRecording,
    isStartingRecording,
    setIsStartingRecording,
    recordingStartTime,
    setRecordingStartTime,
    recordedAudio,
    setRecordedAudio,
    isExtractingSegment,
    setIsExtractingSegment,
    segmentStartTime,
    setSegmentStartTime,
    segmentEndTime,
    setSegmentEndTime,
    autoRecognize,
    setAutoRecognize,
    isRecognizing,
    setIsRecognizing,

    // Narration Generation state
    isAvailable,
    setIsAvailable,
    isGenerating,
    setIsGenerating,
    generationStatus,
    setGenerationStatus,
    generationResults,
    setGenerationResults,
    generationResultSource,
    setGenerationResultSource,
    error,
    setError,
    currentAudio,
    setCurrentAudio,
    isPlaying,
    setIsPlaying,
    subtitleSource,
    setSubtitleSource,
    showAdvancedSettings,
    setShowAdvancedSettings,
    detectedLanguage,
    setDetectedLanguage,
    selectedNarrationModel,
    setSelectedNarrationModel,
    modelAvailabilityError,
    setModelAvailabilityError,
    originalLanguage,
    setOriginalLanguage,
    translatedLanguage,
    setTranslatedLanguage,
    retryingSubtitleId,
    setRetryingSubtitleId,
    useGroupedSubtitles,
    setUseGroupedSubtitles,
    groupedSubtitles,
    setGroupedSubtitles,
    isGroupingSubtitles,
    setIsGroupingSubtitles,
    groupingIntensity,
    setGroupingIntensity,
    advancedSettings,
    setAdvancedSettings,

    // Helper functions
    updateReferenceAudio
  };
};

export default useNarrationState;
