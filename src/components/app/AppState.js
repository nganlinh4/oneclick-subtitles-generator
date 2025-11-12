import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getThemeWithFallback } from '../../utils/systemDetection';
import { useSubtitles } from '../../hooks/useSubtitles';
import { getUserProvidedSubtitlesSync } from '../../utils/userSubtitlesStore';
import { getTranscriptionRulesSync } from '../../utils/transcriptionRulesStore';
import { hasValidTokens } from '../../services/youtubeApiService';
import { PROMPT_PRESETS } from '../../services/geminiService';
import { cleanupInvalidBlobUrls } from '../../utils/videoUtils';
import { getAllKeys } from '../../services/gemini/keyManager';

/**
 * Custom hook for managing application state
 */
export const useAppState = () => {
  const { t } = useTranslation();

  // API Keys and authentication state
  const [apiKeysSet, setApiKeysSet] = useState({
    gemini: false,
    youtube: false,
    genius: false
  });

  // UI state
  const [showSettings, setShowSettings] = useState(false);
  const [activeTab, setActiveTab] = useState(localStorage.getItem('userPreferredTab') || 'unified-url');
  const [theme, setTheme] = useState(() => getThemeWithFallback());
  const [timeFormat, setTimeFormat] = useState(localStorage.getItem('time_format') || 'hms');
  const [showWaveformLongVideos, setShowWaveformLongVideos] = useState(localStorage.getItem('show_waveform_long_videos') === 'true');

  // Video processing state
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null);
  // Video optimization setting - default to false (no optimization)
  const [optimizeVideos, setOptimizeVideos] = useState(() => {
    const saved = localStorage.getItem('optimize_videos');
    // Default to false if not set (no optimization by default)
    return saved === 'true';
  });
  const [optimizedResolution, setOptimizedResolution] = useState(localStorage.getItem('optimized_resolution') || '360p');
  const [useOptimizedPreview, setUseOptimizedPreview] = useState(localStorage.getItem('use_optimized_preview') === 'true');
  const [useCookiesForDownload, setUseCookiesForDownload] = useState(localStorage.getItem('use_cookies_for_download') === 'true');
  const [enableYoutubeSearch, setEnableYoutubeSearch] = useState(localStorage.getItem('enable_youtube_search') === 'true'); // Default to false
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [currentDownloadId, setCurrentDownloadId] = useState(null);
  const [isAppReady] = useState(true); // App is always ready (onboarding removed)
  const [isRetrying, setIsRetrying] = useState(false);
  const [isSrtOnlyMode, setIsSrtOnlyMode] = useState(false);

  // Video analysis state
  const [showVideoAnalysis, setShowVideoAnalysis] = useState(false);
  const [videoAnalysisResult, setVideoAnalysisResult] = useState(null);
  const [autoSelectDefaultPreset, setAutoSelectDefaultPreset] = useState(localStorage.getItem('auto_select_default_preset') === 'true');

  // Segments state
  const [segmentsStatus, setSegmentsStatus] = useState([]);
  const [videoSegments, setVideoSegments] = useState([]);

  // Video processing workflow state
  const [isUploading, setIsUploading] = useState(false);
  const [selectedSegment, setSelectedSegment] = useState(null);
  const [showProcessingModal, setShowProcessingModal] = useState(false);
  const [uploadedFileData, setUploadedFileData] = useState(null);
  const [isProcessingSegment, setIsProcessingSegment] = useState(false);

  // Rules editor state
  const [showRulesEditor, setShowRulesEditor] = useState(false);

  // User-provided subtitles state
  const [userProvidedSubtitles, setUserProvidedSubtitlesState] = useState(() => {
    // Try to get user-provided subtitles synchronously
    const savedSubtitles = getUserProvidedSubtitlesSync();
    return savedSubtitles || '';
  });

  // Track whether user-provided subtitles are being used
  const [useUserProvidedSubtitles, setUseUserProvidedSubtitles] = useState(() => {
    return localStorage.getItem('use_user_provided_subtitles') === 'true';
  });

  // Transcription rules state
  const [transcriptionRules, setTranscriptionRulesState] = useState(() => {
    // Try to get rules synchronously via the utility function
    const savedRules = getTranscriptionRulesSync();

    return savedRules;
  });

  // Get subtitles hook
  const {
    subtitlesData,
    setSubtitlesData,
    status,
    setStatus,
    isGenerating,
    generateSubtitles,
    retryGeneration,
    retrySegment,
    retryingSegments
  } = useSubtitles(t);

  // Initialize default values for settings
  useEffect(() => {
    // Migration: If user doesn't have userPreferredTab but has lastActiveTab, migrate it
    // But only if lastActiveTab is not 'file-upload' (which would be from auto-conversion)
    if (!localStorage.getItem('userPreferredTab')) {
      const lastTab = localStorage.getItem('lastActiveTab');
      if (lastTab && lastTab !== 'file-upload') {
        localStorage.setItem('userPreferredTab', lastTab);
      } else {
        // Default to unified-url if no valid preference exists
        localStorage.setItem('userPreferredTab', 'unified-url');
      }
    }

    // Set onboarding as completed
    localStorage.setItem('onboarding_completed', 'true');

    // Set default preset if not already set
    if (!localStorage.getItem('selected_preset_id')) {
      localStorage.setItem('selected_preset_id', 'general');
    }

    // Set default model if not already set
    if (!localStorage.getItem('gemini_model')) {
      localStorage.setItem('gemini_model', 'gemini-2.0-flash');
    }

    // Set default transcription prompt if not already set
    if (!localStorage.getItem('transcription_prompt')) {
      const defaultPreset = PROMPT_PRESETS.find(preset => preset.id === 'general');
      if (defaultPreset) {
        localStorage.setItem('transcription_prompt', defaultPreset.prompt);
      }
    }

    // Clear status messages and video analysis state on mount
    // Clear any lingering status messages on page load
    setStatus({});

    // Clear video processing flag
    localStorage.removeItem('video_processing_in_progress');

    // Clean up invalid blob URLs from localStorage
    cleanupInvalidBlobUrls();

    // Check if there's an active video analysis in progress
    const showAnalysis = localStorage.getItem('show_video_analysis') === 'true';
    const timestamp = localStorage.getItem('video_analysis_timestamp');

    // Check if the analysis is stale (older than 5 minutes)
    const isStale = timestamp && (Date.now() - parseInt(timestamp, 10) > 5 * 60 * 1000);

    // Always clear video analysis data on page refresh
    // Check if this is a page refresh using a more modern approach
    const pageWasReloaded = window.performance &&
      (window.performance.getEntriesByType('navigation')[0]?.type === 'reload' ||
       document.referrer === document.location.href);

    if (isStale || pageWasReloaded) {
      // Clear analysis data
      localStorage.removeItem('show_video_analysis');
      localStorage.removeItem('video_analysis_timestamp');
      localStorage.removeItem('video_analysis_result');
      setShowVideoAnalysis(false);
      setVideoAnalysisResult(null);
      return;
    }

    if (showAnalysis && !isStale) {
      setShowVideoAnalysis(true);

      try {
        const analysisResult = JSON.parse(localStorage.getItem('video_analysis_result'));
        if (analysisResult) {
          setVideoAnalysisResult(analysisResult);
        }
      } catch (error) {
        console.error('Error parsing video analysis result from localStorage on mount:', error);
        // Clear invalid data
        localStorage.removeItem('show_video_analysis');
        localStorage.removeItem('video_analysis_timestamp');
        localStorage.removeItem('video_analysis_result');
        setShowVideoAnalysis(false);
        setVideoAnalysisResult(null);
      }
    }
  }, [setStatus]);

  // Initialize API keys and OAuth status from localStorage
  useEffect(() => {
    const geminiKeys = getAllKeys();
    const youtubeApiKey = localStorage.getItem('youtube_api_key');
    const geniusApiKey = localStorage.getItem('genius_token');
    const useOAuth = localStorage.getItem('use_youtube_oauth') === 'true';
    const hasOAuthTokens = hasValidTokens();

    setApiKeysSet({
      gemini: geminiKeys.length > 0,
      youtube: useOAuth ? hasOAuthTokens : !!youtubeApiKey,
      genius: !!geniusApiKey
    });

    // Check API keys status and show message if needed (only for YouTube-specific messages)
    // The general Gemini API key message is handled by the reactive useEffect below
    // eslint-disable-next-line no-mixed-operators
    if (activeTab === 'youtube-search' && ((!youtubeApiKey && !useOAuth) || (useOAuth && !hasOAuthTokens))) {
      let message;

      // eslint-disable-next-line no-mixed-operators
      if (geminiKeys.length === 0 && ((!youtubeApiKey && !useOAuth) || (useOAuth && !hasOAuthTokens))) {
        message = t('errors.bothKeysRequired', 'Please set your Gemini API key and configure YouTube authentication in the settings to use this application.');
      } else if (useOAuth && !hasOAuthTokens) {
        message = t('errors.youtubeAuthRequired', 'YouTube authentication required. Please set up OAuth in settings.');
      } else {
        message = t('errors.youtubeApiKeyRequired', 'Please set your YouTube API key in the settings to use this application.');
      }

      if (message) {
        setStatus({ message, type: 'info' });
      }
    }
  }, [setStatus, activeTab, t]);

  // Reactively update status messages based on API key changes
  useEffect(() => {
    // If we have a Gemini API key and the current status is an API key required message, clear it
    if (apiKeysSet.gemini && status?.message) {
      const isApiKeyRequiredMessage =
        status.message.includes('Please set your API key') ||
        status.message.includes('Vui lòng cài đặt khóa API') ||
        status.message.includes('먼저 설정에서 API 키를 설정하세요') ||
        status.message.includes('API key') ||
        status.message.includes('khóa API') ||
        status.message.includes('API 키');

      if (isApiKeyRequiredMessage) {
        setStatus({});
      }
    }
  }, [apiKeysSet.gemini, status, setStatus, t]);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return {
    // State
    apiKeysSet, setApiKeysSet,
    showSettings, setShowSettings,
    activeTab, setActiveTab,
    theme, setTheme,
    timeFormat, setTimeFormat,
    showWaveformLongVideos, setShowWaveformLongVideos,
    selectedVideo, setSelectedVideo,
    uploadedFile, setUploadedFile,
    optimizeVideos, setOptimizeVideos,
    optimizedResolution, setOptimizedResolution,
    useOptimizedPreview, setUseOptimizedPreview,
    useCookiesForDownload, setUseCookiesForDownload,
    enableYoutubeSearch, setEnableYoutubeSearch,
    isDownloading, setIsDownloading,
    downloadProgress, setDownloadProgress,
    currentDownloadId, setCurrentDownloadId,
    isAppReady,
    isRetrying, setIsRetrying,
    isSrtOnlyMode, setIsSrtOnlyMode,
    showVideoAnalysis, setShowVideoAnalysis,
    videoAnalysisResult, setVideoAnalysisResult,
    autoSelectDefaultPreset, setAutoSelectDefaultPreset,
    segmentsStatus, setSegmentsStatus,
    videoSegments, setVideoSegments,
    showRulesEditor, setShowRulesEditor,
    userProvidedSubtitles, setUserProvidedSubtitlesState,
    useUserProvidedSubtitles, setUseUserProvidedSubtitles,
    transcriptionRules, setTranscriptionRulesState,

    // Subtitles hook
    subtitlesData, setSubtitlesData,
    status, setStatus,
    isGenerating,
    generateSubtitles,
    retryGeneration,
    retrySegment,
    retryingSegments,

    // Video processing workflow
    isUploading, setIsUploading,
    selectedSegment, setSelectedSegment,
    showProcessingModal, setShowProcessingModal,
    uploadedFileData, setUploadedFileData,
    isProcessingSegment, setIsProcessingSegment
  };
};
