import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getThemeWithFallback } from '../../utils/systemDetection';
import { useSubtitles } from '../../hooks/useSubtitles';
import { getUserProvidedSubtitlesSync } from '../../utils/userSubtitlesStore';
import { getTranscriptionRulesSync } from '../../utils/transcriptionRulesStore';
import { cleanupInvalidBlobUrls } from '../../utils/videoUtils';
import { migrateStoredGeminiModels } from '../../config/geminiModels';
import {
  getCredentialAvailability,
  initializeCredentialState,
  subscribeCredentialState,
} from '../../platform/credentialStateController';
import { useNativeMediaSessionHydration } from '../../hooks/useNativeMediaSessionHydration';
import { readDownloadCookiePreference } from '../../platform/downloadCookiePreference';

const hasProjectSubtitles = (value) => (
  typeof value === 'string' && value.trim() !== ''
);

const initialActiveTab = () => {
  const preferred = localStorage.getItem('userPreferredTab');
  if (preferred) return preferred;
  const legacy = localStorage.getItem('lastActiveTab');
  return legacy && legacy !== 'file-upload' ? legacy : 'unified-url';
};

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
  const [activeTab, setActiveTab] = useState(initialActiveTab);
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
  const [useCookiesForDownload, setUseCookiesForDownload] = useState(
    () => readDownloadCookiePreference().enabled
  );
  const [enableYoutubeSearch, setEnableYoutubeSearch] = useState(localStorage.getItem('enable_youtube_search') === 'true'); // Default to false
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [currentDownloadId, setCurrentDownloadId] = useState(null);
  const [isAppReady] = useState(true); // App is always ready (onboarding removed)
  const [isRetrying, setIsRetrying] = useState(false);
  const [isSrtOnlyMode, setIsSrtOnlyMode] = useState(false);

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
    return hasProjectSubtitles(getUserProvidedSubtitlesSync());
  });

  // Transcription rules state
  const [transcriptionRules, setTranscriptionRulesState] = useState(() => {
    // Try to get rules synchronously via the utility function
    const savedRules = getTranscriptionRulesSync();

    return savedRules;
  });

  // Native project-backed stores hydrate asynchronously after a media cache alias is resolved.
  // Keep the existing state contract in sync without changing any rendered structure.
  useEffect(() => {
    const handleUserSubtitlesUpdate = (event) => {
      const subtitlesText = event.detail?.subtitlesText || '';
      setUserProvidedSubtitlesState(subtitlesText);
      setUseUserProvidedSubtitles(hasProjectSubtitles(subtitlesText));
    };
    const handleRulesUpdate = (event) => {
      setTranscriptionRulesState(event.detail?.rules ?? null);
    };

    window.addEventListener('userProvidedSubtitlesUpdated', handleUserSubtitlesUpdate);
    window.addEventListener('transcriptionRulesUpdated', handleRulesUpdate);
    return () => {
      window.removeEventListener('userProvidedSubtitlesUpdated', handleUserSubtitlesUpdate);
      window.removeEventListener('transcriptionRulesUpdated', handleRulesUpdate);
    };
  }, []);

  // Get subtitles hook
  const {
    subtitlesData,
    setSubtitlesData,
    status,
    statusEventId,
    setStatus,
    isGenerating,
    generateSubtitles,
    retryGeneration,
    retrySegment,
    retryingSegments
  } = useSubtitles(t);

  useNativeMediaSessionHydration({ setUploadedFile });

  // Initialize default values for settings
  useEffect(() => {
    migrateStoredGeminiModels(localStorage);

    // Clear status messages and video analysis state on mount
    // Clear any lingering status messages on page load
    setStatus({});

    // Clear video processing flag
    localStorage.removeItem('video_processing_in_progress');

    // Clean up invalid blob URLs from localStorage
    cleanupInvalidBlobUrls();

    // Purge the retired browser-era analysis modal payload. The active rules editor is opened by
    // a project-scoped in-memory context and durable rules; no serialized UI result is restorable.
    localStorage.removeItem('show_video_analysis');
    localStorage.removeItem('video_analysis_timestamp');
    localStorage.removeItem('video_analysis_result');
  }, [setStatus]);

  // Initialize credential availability from native, non-secret status metadata.
  useEffect(() => {
    let alive = true;
    const applySnapshot = (snapshot) => {
      if (!alive || !snapshot.initialized) return;
      const useOAuth = localStorage.getItem('use_youtube_oauth') === 'true';
      const availability = getCredentialAvailability(snapshot, { useOAuth });
      setApiKeysSet(availability);

      if (activeTab === 'youtube-search' && !availability.youtube) {
        let message;
        if (!availability.gemini) {
          message = t('errors.bothKeysRequired', 'Please set your Gemini API key and configure YouTube authentication in the settings to use this application.');
        } else if (useOAuth) {
          message = t('errors.youtubeAuthRequired', 'YouTube authentication required. Please set up OAuth in settings.');
        } else {
          message = t('errors.youtubeApiKeyRequired', 'Please set your YouTube API key in the settings to use this application.');
        }
        setStatus({ code: 'youtubeCredentialsRequired', message, type: 'info' });
      } else {
        setStatus((current) => current?.code === 'youtubeCredentialsRequired' ? {} : current);
      }
    };
    const unsubscribe = subscribeCredentialState(applySnapshot);
    initializeCredentialState().then(applySnapshot).catch(() => {
      if (alive) setApiKeysSet({ gemini: false, youtube: false, genius: false });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [setStatus, activeTab, t]);

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
    segmentsStatus, setSegmentsStatus,
    videoSegments, setVideoSegments,
    showRulesEditor, setShowRulesEditor,
    userProvidedSubtitles, setUserProvidedSubtitlesState,
    useUserProvidedSubtitles, setUseUserProvidedSubtitles,
    transcriptionRules, setTranscriptionRulesState,

    // Subtitles hook
    subtitlesData, setSubtitlesData,
    status, statusEventId, setStatus,
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
