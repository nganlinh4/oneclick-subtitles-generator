import { useState, useEffect, useCallback } from 'react';

/**
 * Custom hook for managing narration state
 * @param {Object} initialReferenceAudio - Initial reference audio
 * @returns {Object} - Narration state and setters
 */
const useNarrationState = (initialReferenceAudio) => {
  // Narration Method state - load from localStorage or default to Gemini
  const [narrationMethod, setNarrationMethod] = useState(() => {
    // Try to load from localStorage
    const savedMethod = localStorage.getItem('narration_method');
    return savedMethod || 'gemini'; // Default to Gemini if not set
  });
  const [isGeminiAvailable, setIsGeminiAvailable] = useState(true); // Assume Gemini is available by default
  const [isChatterboxAvailable, setIsChatterboxAvailable] = useState(false); // Start as unavailable, will be updated by availability check
  const [isCheckingAvailability, setIsCheckingAvailability] = useState(false); // Not using loading state

  // Gemini-specific settings
  const [selectedVoice, setSelectedVoice] = useState(() => {
    // Try to load from localStorage
    const savedVoice = localStorage.getItem('gemini_voice');
    return savedVoice || 'Aoede'; // Default to Aoede if not set
  });

  const [concurrentClients, setConcurrentClients] = useState(() => {
    // Try to load from localStorage
    const savedConcurrentClients = localStorage.getItem('gemini_concurrent_clients');
    return savedConcurrentClients ? parseInt(savedConcurrentClients, 10) : 5; // Default to 5 concurrent clients
  });

  // Chatterbox-specific settings
  const [exaggeration, setExaggeration] = useState(() => {
    // Try to load from localStorage
    const savedExaggeration = localStorage.getItem('chatterbox_exaggeration');
    // Default to 0.7 for more expressive speech as recommended in Chatterbox README
    return savedExaggeration ? parseFloat(savedExaggeration) : 0.7;
  });

  const [cfgWeight, setCfgWeight] = useState(() => {
    // Try to load from localStorage
    const savedCfgWeight = localStorage.getItem('chatterbox_cfg_weight');
    // Default to 0.3 for better pacing with expressive speech as recommended in Chatterbox README
    return savedCfgWeight ? parseFloat(savedCfgWeight) : 0.3;
  });

  // Edge TTS-specific settings
  const [edgeTTSVoice, setEdgeTTSVoice] = useState(() => {
    // Try to load from localStorage
    const savedVoice = localStorage.getItem('edge_tts_voice');
    return savedVoice || 'en-US-AriaNeural'; // Default to Aria Neural voice
  });

  const [edgeTTSRate, setEdgeTTSRate] = useState(() => {
    // Try to load from localStorage
    const savedRate = localStorage.getItem('edge_tts_rate');
    return savedRate || '+0%'; // Default to normal rate
  });

  const [edgeTTSVolume, setEdgeTTSVolume] = useState(() => {
    // Try to load from localStorage
    const savedVolume = localStorage.getItem('edge_tts_volume');
    return savedVolume || '+0%'; // Default to normal volume
  });

  const [edgeTTSPitch, setEdgeTTSPitch] = useState(() => {
    // Try to load from localStorage
    const savedPitch = localStorage.getItem('edge_tts_pitch');
    return savedPitch || '+0Hz'; // Default to normal pitch
  });

  // gTTS-specific settings
  const [gttsLanguage, setGttsLanguage] = useState(() => {
    // Try to load from localStorage
    const savedLanguage = localStorage.getItem('gtts_language');
    return savedLanguage || 'en'; // Default to English
  });

  // Chatterbox-specific: selected language code
  const [chatterboxLanguage, setChatterboxLanguage] = useState(() => {
    try {
      return localStorage.getItem('chatterbox_language') || 'en';
    } catch {
      return 'en';
    }
  });

  const [gttsTld, setGttsTld] = useState(() => {
    // Try to load from localStorage
    const savedTld = localStorage.getItem('gtts_tld');
    return savedTld || 'com'; // Default to .com
  });

  const [gttsSlow, setGttsSlow] = useState(() => {
    // Try to load from localStorage
    const savedSlow = localStorage.getItem('gtts_slow');
    return savedSlow === 'true'; // Default to false
  });

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
  const [isAvailable, setIsAvailable] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [generationResults, setGenerationResults] = useState([]);
  const [error, setError] = useState('');
  const [currentAudio, setCurrentAudio] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [subtitleSource, setSubtitleSource] = useState(() => {
    // Try to load from localStorage
    const savedSubtitleSource = localStorage.getItem('subtitle_source');
    return savedSubtitleSource || 'original'; // Default to 'original' if not set
  });
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [detectedLanguage, setDetectedLanguage] = useState(null);
  const [selectedNarrationModel, setSelectedNarrationModel] = useState(() => {
    // Load last used narration model from localStorage
    try {
      return localStorage.getItem('last_used_narration_model') || null;
    } catch (error) {
      console.error('Error loading last used narration model:', error);
      return null;
    }
  });
  const [modelAvailabilityError, setModelAvailabilityError] = useState(null);
  const [originalLanguage, setOriginalLanguage] = useState(null);
  const [translatedLanguage, setTranslatedLanguage] = useState(null);
  const [retryingSubtitleId, setRetryingSubtitleId] = useState(null);
  const [useGroupedSubtitles, setUseGroupedSubtitles] = useState(false);
  const [groupedSubtitles, setGroupedSubtitles] = useState(null);
  const [isGroupingSubtitles, setIsGroupingSubtitles] = useState(false);
  const [groupingIntensity, setGroupingIntensity] = useState(() => {
    // Try to load from localStorage
    const savedGroupingIntensity = localStorage.getItem('grouping_intensity');
    return savedGroupingIntensity || 'moderate'; // Default to 'moderate' if not set
  });
  const [advancedSettings, setAdvancedSettings] = useState(() => {
    // Try to load from localStorage
    try {
      const savedSettings = localStorage.getItem('narration_advanced_settings');
      if (savedSettings) {
        return JSON.parse(savedSettings);
      }
    } catch (error) {
      // Silently fail if settings can't be loaded
    }

    // Default settings
    return {
      // Voice Style Controls - only speechRate is supported
      speechRate: 1.1,
  
      // Generation Quality Controls
      nfeStep: '32',  // Number of Function Evaluations (diffusion steps)
      swayCoef: -1.0, // Sway Sampling Coefficient
      cfgStrength: 2.0, // Classifier-Free Guidance Strength
  
      // Seed Control
      useRandomSeed: true,
      seed: 42,
  
      // Audio Processing Options - only removeSilence is supported
      removeSilence: true,
  
      // Output Format Options
      sampleRate: '44100',
      audioFormat: 'wav',
  
      // Batch Processing Options
      batchSize: '8',
      mergeOutput: false
    };
  });

  // Save advanced settings to localStorage when they change
  useEffect(() => {
    if (advancedSettings) {
      try {
        localStorage.setItem('narration_advanced_settings', JSON.stringify(advancedSettings));
      } catch (error) {
        console.error('Error saving advanced settings to localStorage:', error);
      }
    }
  }, [advancedSettings]);

  // Save grouping intensity to localStorage when it changes
  useEffect(() => {
    if (groupingIntensity) {
      try {
        localStorage.setItem('grouping_intensity', groupingIntensity);
      } catch (error) {
        console.error('Error saving grouping intensity to localStorage:', error);
      }
    }
  }, [groupingIntensity]);

  // Save Edge TTS settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem('edge_tts_voice', edgeTTSVoice);
  }, [edgeTTSVoice]);

  useEffect(() => {
    localStorage.setItem('edge_tts_rate', edgeTTSRate);
  }, [edgeTTSRate]);

  useEffect(() => {
    localStorage.setItem('edge_tts_volume', edgeTTSVolume);
  }, [edgeTTSVolume]);

  useEffect(() => {
    localStorage.setItem('edge_tts_pitch', edgeTTSPitch);
  }, [edgeTTSPitch]);

  // Save gTTS settings to localStorage when they change
  useEffect(() => {
    localStorage.setItem('gtts_language', gttsLanguage);
  }, [gttsLanguage]);

  // Save Chatterbox language to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('chatterbox_language', chatterboxLanguage);
  }, [chatterboxLanguage]);

  useEffect(() => {
    localStorage.setItem('gtts_tld', gttsTld);
  }, [gttsTld]);

  useEffect(() => {
    localStorage.setItem('gtts_slow', gttsSlow.toString());
  }, [gttsSlow]);

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
