import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getThemeWithFallback } from '../../utils/systemDetection';
import { useSubtitles } from '../../hooks/useSubtitles';
import { getUserProvidedSubtitlesSync } from '../../utils/userSubtitlesStore';
import {
  getCredentialAvailability,
  initializeCredentialState,
  subscribeCredentialState,
} from '../../platform/credentialStateController';
import { useNativeMediaSessionHydration } from '../../hooks/useNativeMediaSessionHydration';
import { readPreference, usePreference } from '../../platform/preferences/store';

const hasProjectSubtitles = (value) => (
  typeof value === 'string' && value.trim() !== ''
);

const initialActiveTab = () => {
  const preferred = readPreference('userPreferredTab');
  if (preferred) return preferred;
  const last = readPreference('lastActiveTab');
  return last && last !== 'file-upload' ? last : 'unified-url';
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
  // Settings-owned values follow the preference store; only the Settings modal changes them.
  const [timeFormat] = usePreference('time_format');
  const [showWaveformLongVideos] = usePreference('show_waveform_long_videos');

  // Video processing state
  const [selectedVideo, setSelectedVideo] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [optimizeVideos] = usePreference('optimize_videos');
  const [optimizedResolution] = usePreference('optimized_resolution');
  const [useOptimizedPreview] = usePreference('use_optimized_preview');
  const [useCookiesForDownload] = usePreference('use_cookies_for_download');
  const [enableYoutubeSearch] = usePreference('enable_youtube_search');
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [currentDownloadId, setCurrentDownloadId] = useState(null);
  const [isAppReady] = useState(true); // App is always ready (onboarding removed)
  const [isRetrying, setIsRetrying] = useState(false);
  const [isSrtOnlyMode, setIsSrtOnlyMode] = useState(false);

  // Video processing workflow state
  const [isUploading, setIsUploading] = useState(false);
  const [selectedSegment, setSelectedSegment] = useState(null);
  const [showProcessingModal, setShowProcessingModal] = useState(false);
  const [uploadedFileData, setUploadedFileData] = useState(null);
  const [isProcessingSegment, setIsProcessingSegment] = useState(false);

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

  // The native project-backed store hydrates asynchronously after a media cache alias resolves.
  useEffect(() => {
    const handleUserSubtitlesUpdate = (event) => {
      const subtitlesText = event.detail?.subtitlesText || '';
      setUserProvidedSubtitlesState(subtitlesText);
      setUseUserProvidedSubtitles(hasProjectSubtitles(subtitlesText));
    };

    window.addEventListener('userProvidedSubtitlesUpdated', handleUserSubtitlesUpdate);
    return () => {
      window.removeEventListener('userProvidedSubtitlesUpdated', handleUserSubtitlesUpdate);
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
    retryGeneration
  } = useSubtitles(t);

  useNativeMediaSessionHydration({ setUploadedFile, setIsSrtOnlyMode });

  // Clear any lingering status message on mount
  useEffect(() => {
    setStatus({});
  }, [setStatus]);

  // Initialize credential availability from native, non-secret status metadata.
  useEffect(() => {
    let alive = true;
    const applySnapshot = (snapshot) => {
      if (!alive || !snapshot.initialized) return;
      const useOAuth = readPreference('use_youtube_oauth');
      const availability = getCredentialAvailability(snapshot, { useOAuth });
      setApiKeysSet(availability);
    };
    const unsubscribe = subscribeCredentialState(applySnapshot);
    initializeCredentialState().then(applySnapshot).catch(() => {
      if (alive) setApiKeysSet({ gemini: false, youtube: false, genius: false });
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

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
    timeFormat,
    showWaveformLongVideos,
    selectedVideo, setSelectedVideo,
    uploadedFile, setUploadedFile,
    optimizeVideos,
    optimizedResolution,
    useOptimizedPreview,
    useCookiesForDownload,
    enableYoutubeSearch,
    isDownloading, setIsDownloading,
    downloadProgress, setDownloadProgress,
    currentDownloadId, setCurrentDownloadId,
    isAppReady,
    isRetrying, setIsRetrying,
    isSrtOnlyMode, setIsSrtOnlyMode,
    userProvidedSubtitles, setUserProvidedSubtitlesState,
    useUserProvidedSubtitles, setUseUserProvidedSubtitles,

    // Subtitles hook
    subtitlesData, setSubtitlesData,
    status, statusEventId, setStatus,
    isGenerating,
    generateSubtitles,
    retryGeneration,

    // Video processing workflow
    isUploading, setIsUploading,
    selectedSegment, setSelectedSegment,
    showProcessingModal, setShowProcessingModal,
    uploadedFileData, setUploadedFileData,
    isProcessingSegment, setIsProcessingSegment
  };
};
