import { useState, useEffect } from 'react';

// NOTE: this file lives in src/components/settings/hooks/, one level deeper than
// SettingsModal.js (src/components/settings/), so '../../X' from the modal
// becomes '../../../X' here.
import { DEFAULT_TRANSCRIPTION_PROMPT } from '../../../services/geminiService';
import { getClientCredentials, hasValidTokens } from '../../../services/youtubeApiService';
import { getCurrentKey } from '../../../services/gemini/keyManager';
import { getDefaultThinkingBudgets } from '../../../config/geminiModels';

/**
 * Custom hook owning all SettingsModal settings state: initialization,
 * the load/migration effect, original-settings tracking, and change detection.
 * Returns every piece of state + setter the modal render needs.
 */
const useSettingsState = () => {
  const [hasChanges, setHasChanges] = useState(false); // Track if any settings have changed
  const [isSettingsLoaded, setIsSettingsLoaded] = useState(false); // Track if settings have been loaded
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [youtubeApiKey, setYoutubeApiKey] = useState('');
  const [geniusApiKey, setGeniusApiKey] = useState('');
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showYoutubeKey, setShowYoutubeKey] = useState(false);
  const [showGeniusKey, setShowGeniusKey] = useState(false);
  const [useOAuth, setUseOAuth] = useState(false);
  const [youtubeClientId, setYoutubeClientId] = useState('');
  const [youtubeClientSecret, setYoutubeClientSecret] = useState('');
  const [showClientId, setShowClientId] = useState(false);
  const [showClientSecret, setShowClientSecret] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [segmentDuration, setSegmentDuration] = useState(5); // Default to 5 minutes
  const [geminiModel, setGeminiModel] = useState('gemini-2.5-flash'); // Default model
  const [timeFormat, setTimeFormat] = useState('hms'); // Default to HH:MM:SS format

  const [showWaveformLongVideos, setShowWaveformLongVideos] = useState(false); // Default to NOT showing waveform for long videos
  const [segmentOffsetCorrection, setSegmentOffsetCorrection] = useState(-3.0); // Default offset correction for second segment
  const [useVideoAnalysis, setUseVideoAnalysis] = useState(true); // Default to using video analysis
  const [videoAnalysisModel, setVideoAnalysisModel] = useState('gemini-2.5-flash-lite'); // Default to Gemini 2.5 Flash Lite
  const [videoAnalysisTimeout, setVideoAnalysisTimeout] = useState('10'); // Default to 10 seconds timeout

  // New: Show Gemini star effects setting (default ON)
  const [enableGeminiEffects, setEnableGeminiEffects] = useState(() => localStorage.getItem('enable_gemini_effects') !== 'false');

  const [optimizeVideos, setOptimizeVideos] = useState(false); // Default to no optimization
  const [optimizedResolution, setOptimizedResolution] = useState('360p'); // Default to 360p
  const [useOptimizedPreview, setUseOptimizedPreview] = useState(false); // Default to original video in preview
  const [isFactoryResetting, setIsFactoryResetting] = useState(false); // State for factory reset process

  // Thinking budget settings for each model — defaults from central config
  const [thinkingBudgets, setThinkingBudgets] = useState(getDefaultThinkingBudgets);
  const [transcriptionPrompt, setTranscriptionPrompt] = useState(DEFAULT_TRANSCRIPTION_PROMPT); // Custom transcription prompt
  const [useCookiesForDownload, setUseCookiesForDownload] = useState(false); // Default to not using cookies
  const [enableYoutubeSearch, setEnableYoutubeSearch] = useState(false); // Default to disabling YouTube search
  // New: Auto-import site subtitles (default ON)
  const [autoImportSiteSubtitles, setAutoImportSiteSubtitles] = useState(() => {
    const saved = localStorage.getItem('auto_import_site_subtitles');
    return saved === null ? true : saved === 'true';
  });
  const [favoriteMaxSubtitleLength, setFavoriteMaxSubtitleLength] = useState(() => {
    const saved = localStorage.getItem('video_processing_max_words');
    return saved ? parseInt(saved, 10) : 12; // Default to 12 words
  }); // Favorite max subtitle length
  const [showFavoriteMaxLength, setShowFavoriteMaxLength] = useState(() => {
    const saved = localStorage.getItem('show_favorite_max_length');
    return saved === null ? true : saved === 'true'; // Default to true (showing)
  }); // Toggle for showing favorite max length setting

  // Custom Gemini models state
  const [customGeminiModels, setCustomGeminiModels] = useState(() => {
    try {
      const saved = localStorage.getItem('custom_gemini_models');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Store original settings for comparison
  const [originalSettings, setOriginalSettings] = useState({
    geminiApiKey: '',
    youtubeApiKey: '',
    geniusApiKey: '',
    segmentDuration: 5,
    geminiModel: 'gemini-2.5-flash',
    timeFormat: 'hms',
    showWaveform: true,
    showWaveformLongVideos: false,
    segmentOffsetCorrection: -3.0,
    transcriptionPrompt: DEFAULT_TRANSCRIPTION_PROMPT,
    useOAuth: false,
    youtubeClientId: '',
    youtubeClientSecret: '',
    useVideoAnalysis: true,
    videoAnalysisModel: 'gemini-2.5-flash-lite',
    videoAnalysisTimeout: '10',
    enableGeminiEffects: true,

    optimizeVideos: false,
    optimizedResolution: '360p',
    useOptimizedPreview: false,
    thinkingBudgets: {
      'gemini-2.5-pro': -1,
      'gemini-2.5-flash': -1,
      'gemini-2.5-flash-lite': -1
    },
    useCookiesForDownload: false,
    enableYoutubeSearch: false,
    favoriteMaxSubtitleLength: 12,
    showFavoriteMaxLength: true,
    customGeminiModels: []
  });

  // Load saved settings on component mount
  useEffect(() => {
    const loadSettings = () => {
      // Check for settings migration
      const settingsVersion = localStorage.getItem('settings_version') || '1.0';

      // Migration for video analysis model default change
      if (settingsVersion === '1.0') {
        const currentVideoAnalysisModel = localStorage.getItem('video_analysis_model');
        // If user has the old default, update it to the new default
        if (currentVideoAnalysisModel === 'gemini-2.0-flash') {
          localStorage.setItem('video_analysis_model', 'gemini-2.5-flash-lite');
        }
        // Update settings version
        localStorage.setItem('settings_version', '1.1');
      }

      // Migration: replace deprecated gemini-2.0-flash with gemini-2.5-flash
      if (!settingsVersion || settingsVersion === '1.0' || settingsVersion === '1.1') {
        const currentModel = localStorage.getItem('gemini_model');
        if (currentModel === 'gemini-2.0-flash' || currentModel === 'gemini-2.0-flash-lite') {
          localStorage.setItem('gemini_model', 'gemini-2.5-flash');
        }
        const currentTranslationModel = localStorage.getItem('translation_model');
        if (currentTranslationModel === 'gemini-2.0-flash' || currentTranslationModel === 'gemini-2.0-flash-lite') {
          localStorage.setItem('translation_model', 'gemini-2.5-flash');
        }
        localStorage.setItem('settings_version', '1.2');
      }

      // Get the current active Gemini API key from the key manager
      const savedGeminiKey = getCurrentKey() || '';
      const savedYoutubeKey = localStorage.getItem('youtube_api_key') || '';
      const savedGeniusKey = localStorage.getItem('genius_token') || '';
      const savedSegmentDuration = parseInt(localStorage.getItem('segment_duration') || '5');
      const savedGeminiModel = localStorage.getItem('gemini_model') || 'gemini-2.5-flash';
      const savedTimeFormat = localStorage.getItem('time_format') || 'hms';

      const savedShowWaveformLongVideos = localStorage.getItem('show_waveform_long_videos') === 'true'; // Default to false if not set
      const savedOffsetCorrection = parseFloat(localStorage.getItem('segment_offset_correction') || '-3.0');
      const savedEnableGeminiEffects = localStorage.getItem('enable_gemini_effects') !== 'false';
      const savedUseVideoAnalysis = true; // Video analysis is always enabled
      const savedVideoAnalysisModel = localStorage.getItem('video_analysis_model') || 'gemini-2.5-flash-lite'; // Default to 2.5 Flash Lite
      const savedVideoAnalysisTimeout = localStorage.getItem('video_analysis_timeout') || '10'; // Default to 10 seconds timeout
      const savedAutoSelectDefaultPreset = localStorage.getItem('auto_select_default_preset') === 'true'; // Default to false
      const savedTranscriptionPrompt = localStorage.getItem('transcription_prompt') || DEFAULT_TRANSCRIPTION_PROMPT;
      const savedUseOAuth = localStorage.getItem('use_youtube_oauth') === 'true';
      const savedOptimizeVideos = localStorage.getItem('optimize_videos') === 'true'; // Default to false if not set
      const savedOptimizedResolution = localStorage.getItem('optimized_resolution') || '360p';
      const savedUseOptimizedPreview = localStorage.getItem('use_optimized_preview') === 'true'; // Default to false if not set
      const savedUseCookiesForDownload = localStorage.getItem('use_cookies_for_download') === 'true';
      const savedEnableYoutubeSearch = localStorage.getItem('enable_youtube_search') === 'true'; // Default to false
      const savedAutoImportSiteSubtitles = (() => {
        const v = localStorage.getItem('auto_import_site_subtitles');
        return v === null ? true : v === 'true';
      })();
      const savedFavoriteMaxSubtitleLength = parseInt(localStorage.getItem('video_processing_max_words') || '12');
      const savedShowFavoriteMaxLength = localStorage.getItem('show_favorite_max_length') === null ? true : localStorage.getItem('show_favorite_max_length') === 'true';

      // Load custom Gemini models
      const savedCustomGeminiModels = (() => {
        try {
          const stored = localStorage.getItem('custom_gemini_models');
          return stored ? JSON.parse(stored) : [];
        } catch (error) {
          console.error('Error parsing custom Gemini models from localStorage:', error);
          return [];
        }
      })(); // Default to false if not set

      // Load thinking budgets from localStorage
      const savedThinkingBudgets = (() => {
        try {
          const stored = localStorage.getItem('thinking_budgets');
          const defaults = {
            'gemini-2.5-pro': 128,
            'gemini-2.5-flash': 0,
            'gemini-2.5-flash-lite': 0,
            'gemini-3.5-flash': 'high',
            'gemini-3-flash-preview': 'high',
            'gemini-3.1-flash-lite-preview': 'minimal',
            'gemini-3.1-pro-preview': 'high'
          };
          return stored ? { ...defaults, ...JSON.parse(stored) } : defaults;
        } catch (error) {
          console.error('Error parsing thinking budgets from localStorage:', error);
          return {
            'gemini-2.5-pro': 128,
            'gemini-2.5-flash': 0,
            'gemini-2.5-flash-lite': 0,
            'gemini-3.5-flash': 'high',
            'gemini-3-flash-preview': 'high',
            'gemini-3.1-flash-lite-preview': 'minimal',
            'gemini-3.1-pro-preview': 'high'
          };
        }
      })();
      const { clientId, clientSecret } = getClientCredentials();
      const authenticated = hasValidTokens();

      // Original settings will be set after all state updates

      setGeminiApiKey(savedGeminiKey);
      setYoutubeApiKey(savedYoutubeKey);
      setGeniusApiKey(savedGeniusKey);
      setSegmentDuration(savedSegmentDuration);
      setGeminiModel(savedGeminiModel);
      setTimeFormat(savedTimeFormat);
      setShowWaveformLongVideos(savedShowWaveformLongVideos);
      setSegmentOffsetCorrection(savedOffsetCorrection);
      setUseVideoAnalysis(savedUseVideoAnalysis);
      setVideoAnalysisModel(savedVideoAnalysisModel);
      setVideoAnalysisTimeout(savedVideoAnalysisTimeout);
      setEnableGeminiEffects(savedEnableGeminiEffects);

      setTranscriptionPrompt(savedTranscriptionPrompt);
      setUseOAuth(savedUseOAuth);
      setYoutubeClientId(clientId);
      setYoutubeClientSecret(clientSecret);
      setIsAuthenticated(authenticated);
      setOptimizeVideos(savedOptimizeVideos);
      setOptimizedResolution(savedOptimizedResolution);
      setUseOptimizedPreview(savedUseOptimizedPreview);
      setUseCookiesForDownload(savedUseCookiesForDownload);
      setEnableYoutubeSearch(savedEnableYoutubeSearch);
      setAutoImportSiteSubtitles(savedAutoImportSiteSubtitles);
      setFavoriteMaxSubtitleLength(savedFavoriteMaxSubtitleLength);
      setShowFavoriteMaxLength(savedShowFavoriteMaxLength);
      setThinkingBudgets(savedThinkingBudgets);
      setCustomGeminiModels(savedCustomGeminiModels);
      setHasChanges(false); // Reset changes flag when loading settings

      // Set original settings to match loaded settings
      setOriginalSettings({
        geminiApiKey: savedGeminiKey,
        youtubeApiKey: savedYoutubeKey,
        geniusApiKey: savedGeniusKey,
        segmentDuration: savedSegmentDuration,
        geminiModel: savedGeminiModel,
        timeFormat: savedTimeFormat,
        showWaveformLongVideos: savedShowWaveformLongVideos,
        segmentOffsetCorrection: savedOffsetCorrection,
        transcriptionPrompt: savedTranscriptionPrompt,
        useOAuth: savedUseOAuth,
        youtubeClientId: clientId,
        youtubeClientSecret: clientSecret,
        useVideoAnalysis: savedUseVideoAnalysis,
        videoAnalysisModel: savedVideoAnalysisModel,
        videoAnalysisTimeout: savedVideoAnalysisTimeout,
        autoSelectDefaultPreset: savedAutoSelectDefaultPreset,
        enableGeminiEffects: savedEnableGeminiEffects,
        optimizeVideos: savedOptimizeVideos,
        optimizedResolution: savedOptimizedResolution,
        useOptimizedPreview: savedUseOptimizedPreview,
        useCookiesForDownload: savedUseCookiesForDownload,
        enableYoutubeSearch: savedEnableYoutubeSearch,
        autoImportSiteSubtitles: savedAutoImportSiteSubtitles,
        favoriteMaxSubtitleLength: savedFavoriteMaxSubtitleLength,
        showFavoriteMaxLength: savedShowFavoriteMaxLength,
        thinkingBudgets: savedThinkingBudgets,
        customGeminiModels: savedCustomGeminiModels
      });

      // Mark settings as loaded
      setIsSettingsLoaded(true);
    };

    // Load settings initially
    loadSettings();

    // Check for OAuth success flag
    const oauthSuccess = localStorage.getItem('oauth_auth_success') === 'true';
    if (oauthSuccess) {
      // Refresh authentication status
      setIsAuthenticated(hasValidTokens());
    }

    // Set up event listener for storage changes
    const handleStorageChange = (event) => {
      if (event.key === 'youtube_oauth_token' || event.key === 'oauth_auth_success') {
        setIsAuthenticated(hasValidTokens());
      }
    };

    window.addEventListener('storage', handleStorageChange);

    // Clean up
    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effect to check for changes in settings
  useEffect(() => {
    // Only check for changes if settings have been loaded
    if (!isSettingsLoaded) return;

    // Compare current settings with original settings
    const settingsChanged =
      geminiApiKey !== originalSettings.geminiApiKey ||
      youtubeApiKey !== originalSettings.youtubeApiKey ||
      geniusApiKey !== originalSettings.geniusApiKey ||
      segmentDuration !== originalSettings.segmentDuration ||
      geminiModel !== originalSettings.geminiModel ||
      timeFormat !== originalSettings.timeFormat ||
      showWaveformLongVideos !== originalSettings.showWaveformLongVideos ||
      segmentOffsetCorrection !== originalSettings.segmentOffsetCorrection ||
      transcriptionPrompt !== originalSettings.transcriptionPrompt ||
      useOAuth !== originalSettings.useOAuth ||
      youtubeClientId !== originalSettings.youtubeClientId ||
      youtubeClientSecret !== originalSettings.youtubeClientSecret ||
      useVideoAnalysis !== originalSettings.useVideoAnalysis ||
      videoAnalysisModel !== originalSettings.videoAnalysisModel ||
      videoAnalysisTimeout !== originalSettings.videoAnalysisTimeout ||
      enableGeminiEffects !== (originalSettings.enableGeminiEffects ?? true) ||

      optimizeVideos !== originalSettings.optimizeVideos ||
      optimizedResolution !== originalSettings.optimizedResolution ||
      useOptimizedPreview !== originalSettings.useOptimizedPreview ||
      useCookiesForDownload !== originalSettings.useCookiesForDownload ||
      enableYoutubeSearch !== originalSettings.enableYoutubeSearch ||
      autoImportSiteSubtitles !== (originalSettings.autoImportSiteSubtitles ?? true) ||
      favoriteMaxSubtitleLength !== originalSettings.favoriteMaxSubtitleLength ||
      showFavoriteMaxLength !== originalSettings.showFavoriteMaxLength ||
      JSON.stringify(thinkingBudgets) !== JSON.stringify(originalSettings.thinkingBudgets) ||
      JSON.stringify(customGeminiModels) !== JSON.stringify(originalSettings.customGeminiModels);

    setHasChanges(settingsChanged);
  }, [isSettingsLoaded, geminiApiKey, youtubeApiKey, geniusApiKey, segmentDuration, geminiModel, timeFormat, showWaveformLongVideos,
      segmentOffsetCorrection, transcriptionPrompt, useOAuth, youtubeClientId,
      youtubeClientSecret, useVideoAnalysis, videoAnalysisModel, videoAnalysisTimeout, enableGeminiEffects,
      optimizeVideos, optimizedResolution, useOptimizedPreview, useCookiesForDownload, enableYoutubeSearch, autoImportSiteSubtitles, favoriteMaxSubtitleLength, showFavoriteMaxLength, thinkingBudgets, customGeminiModels, originalSettings]);

  return {
    // change/load tracking
    hasChanges,
    setHasChanges,
    isSettingsLoaded,
    setIsSettingsLoaded,
    // API keys
    geminiApiKey,
    setGeminiApiKey,
    youtubeApiKey,
    setYoutubeApiKey,
    geniusApiKey,
    setGeniusApiKey,
    showGeminiKey,
    setShowGeminiKey,
    showYoutubeKey,
    setShowYoutubeKey,
    showGeniusKey,
    setShowGeniusKey,
    // OAuth / YouTube client
    useOAuth,
    setUseOAuth,
    youtubeClientId,
    setYoutubeClientId,
    youtubeClientSecret,
    setYoutubeClientSecret,
    showClientId,
    setShowClientId,
    showClientSecret,
    setShowClientSecret,
    isAuthenticated,
    setIsAuthenticated,
    // video processing
    segmentDuration,
    setSegmentDuration,
    geminiModel,
    setGeminiModel,
    timeFormat,
    setTimeFormat,
    showWaveformLongVideos,
    setShowWaveformLongVideos,
    segmentOffsetCorrection,
    setSegmentOffsetCorrection,
    useVideoAnalysis,
    setUseVideoAnalysis,
    videoAnalysisModel,
    setVideoAnalysisModel,
    videoAnalysisTimeout,
    setVideoAnalysisTimeout,
    enableGeminiEffects,
    setEnableGeminiEffects,
    optimizeVideos,
    setOptimizeVideos,
    optimizedResolution,
    setOptimizedResolution,
    useOptimizedPreview,
    setUseOptimizedPreview,
    isFactoryResetting,
    setIsFactoryResetting,
    thinkingBudgets,
    setThinkingBudgets,
    transcriptionPrompt,
    setTranscriptionPrompt,
    useCookiesForDownload,
    setUseCookiesForDownload,
    enableYoutubeSearch,
    setEnableYoutubeSearch,
    autoImportSiteSubtitles,
    setAutoImportSiteSubtitles,
    favoriteMaxSubtitleLength,
    setFavoriteMaxSubtitleLength,
    showFavoriteMaxLength,
    setShowFavoriteMaxLength,
    customGeminiModels,
    setCustomGeminiModels,
    // original settings tracking
    originalSettings,
    setOriginalSettings,
  };
};

export default useSettingsState;
