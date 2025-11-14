import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '../../styles/SettingsModal.css';
import '../../styles/settings/checkbox-fix.css';
import '../../styles/components/tab-content-animations.css';
import { DEFAULT_TRANSCRIPTION_PROMPT } from '../../services/geminiService';
import { getClientCredentials, hasValidTokens } from '../../services/youtubeApiService';
import { getAllKeys, saveAllKeys, getCurrentKey } from '../../services/gemini/keyManager';
import SettingsFooterControls from './SettingsFooterControls';
import CloseButton from '../common/CloseButton';
import { API_BASE_URL } from '../../config';

// Import modularized components
import ApiKeysTab from './tabs/ApiKeysTab';
import VideoProcessingTab from './tabs/VideoProcessingTab';
import PromptsTab from './tabs/PromptsTab';
import CacheTab from './tabs/CacheTab';
import AboutTab from './tabs/AboutTab';
import ModelManagementTab from './ModelManagementTab';

// Import icons
import { ApiKeyIcon, ProcessingIcon, PromptIcon, CacheIcon, AboutIcon, ModelIcon } from './icons/TabIcons';
import { getGitVersion, getLatestVersion, compareVersions } from '../../utils/gitVersion';
import LoadingIndicator from '../common/LoadingIndicator';

import initSettingsTabPillAnimation from '../../utils/settingsTabPillAnimation';
import initSettingsTabsDrag from '../../utils/settingsTabsDrag';

// Import Gemini effects functions for immediate toggle
import { initGeminiButtonEffects, disableGeminiButtonEffects } from '../../utils/geminiEffects';

const SettingsModal = ({ onClose, onSave, apiKeysSet, setApiKeysSet }) => {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState(() => {
    // Load last active tab from localStorage or default to 'api-keys'
    const savedTab = localStorage.getItem('settings_last_active_tab');
    // If the saved tab is 'gemini-settings', redirect to 'api-keys' since we removed that tab
    return (savedTab === 'gemini-settings') ? 'api-keys' : (savedTab || 'api-keys');
  });

  // Reference to the tabs container
  const tabsRef = useRef(null);

  // State for tracking when the modal is closing
  const [isClosing, setIsClosing] = useState(false);

  // State for tracking tab transitions
  const [previousTab, setPreviousTab] = useState(null);
  const [animationDirection, setAnimationDirection] = useState('center');


  // State for tracking which About background to show
  const [backgroundType, setBackgroundType] = useState(() => {
    // Initialize from localStorage
    return localStorage.getItem('about_background_type') || 'default';
  });

  // Update availability for About tab badge
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const current = await getGitVersion();
        const latest = await getLatestVersion();
        if (!mounted) return;
        if (current && latest) {
          const isNewer = compareVersions(latest.version, current.version);
          setUpdateAvailable(isNewer > 0);
        }
      } catch (e) {
        // Silent fail for badge; About tab shows detailed error state
      }
    };
    check();
    return () => { mounted = false; };
  }, []);


  // Initialize pill position and drag functionality on component mount
  useEffect(() => {
    if (tabsRef.current) {
      // Small delay to ensure the DOM is fully rendered
      setTimeout(() => {
        initSettingsTabPillAnimation('.settings-tabs');

        // Initialize drag functionality for tabs
        const cleanupDrag = initSettingsTabsDrag('.settings-tabs');

        // Return cleanup function
        return () => {
          if (cleanupDrag) cleanupDrag();
        };
      }, 50);
    }
  }, []);

  // Update pill position when active tab changes
  useEffect(() => {
    if (tabsRef.current) {
      // Reset wasActive and lastActive attributes on all tabs when active tab changes programmatically
      const tabButtons = tabsRef.current.querySelectorAll('.settings-tab');
      tabButtons.forEach(tab => {
        tab.dataset.wasActive = 'false';
        tab.dataset.lastActive = 'false';
      });

      // Determine animation direction based on tab order
      if (previousTab) {
        const tabOrder = ['api-keys', 'video-processing', 'prompts', 'cache', 'model-management', 'about'];
        const prevIndex = tabOrder.indexOf(previousTab);
        const currentIndex = tabOrder.indexOf(activeTab);

        if (prevIndex !== -1 && currentIndex !== -1) {
          if (prevIndex < currentIndex) {
            setAnimationDirection('left');
          } else if (prevIndex > currentIndex) {
            setAnimationDirection('right');
          } else {
            setAnimationDirection('center');
          }
        } else {
          setAnimationDirection('center');
        }
      }

      // Update previous tab for next change
      setPreviousTab(activeTab);

      // Small delay to ensure the active class is applied
      setTimeout(() => {
        initSettingsTabPillAnimation('.settings-tabs');
      }, 10);
    }
  }, [activeTab, previousTab]);

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
  const [geminiModel, setGeminiModel] = useState('gemini-2.0-flash'); // Default model
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

  // Thinking budget settings for each model
  const [thinkingBudgets, setThinkingBudgets] = useState({
    'gemini-2.5-pro': -1, // Dynamic thinking
    'gemini-2.5-flash': -1, // Dynamic thinking
    'gemini-2.5-flash-lite': -1 // Dynamic thinking
  });
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

  // Save active tab to localStorage when it changes
  useEffect(() => {
    localStorage.setItem('settings_last_active_tab', activeTab);
  }, [activeTab]);

  // Function to handle closing with animation
  const handleClose = useCallback(() => {
    // Start the closing animation
    setIsClosing(true);

    // Wait for the animation to complete before actually closing
    setTimeout(() => {
      onClose();
    }, 300); // Match this with the CSS transition duration
  }, [onClose]);

  // Add ESC key handler to close the modal
  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape' && !isClosing) {
        handleClose();
      }
    };

    // Add event listener when the component mounts
    document.addEventListener('keydown', handleEscKey);

    // Remove event listener when the component unmounts
    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [onClose, isClosing, handleClose]);

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
          return stored ? JSON.parse(stored) : {
            'gemini-2.5-pro': 128,
            'gemini-2.5-flash': 0,
            'gemini-2.5-flash-lite': 0
          };
        } catch (error) {
          console.error('Error parsing thinking budgets from localStorage:', error);
          return {
            'gemini-2.5-pro': 128,
            'gemini-2.5-flash': 0,
            'gemini-2.5-flash-lite': 0
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



  // Handle factory reset
  const handleFactoryReset = async () => {
    // Show toast with confirmation button instead of browser popup
    window.addToast(
      t('settings.confirmFactoryReset', 'Are you sure you want to perform a factory reset? This will clear all cache files and browser data. This cannot be undone.'),
      'warning',
      15000,
      null,
      {
        text: t('common.confirm', 'Confirm'),
        onClick: async () => {
          setIsFactoryResetting(true);

          try {
            // 1. Try to clear server-side cache (optional - app can run without server)
            try {
              const cacheResponse = await fetch(`${API_BASE_URL}/clear-cache`, {
                method: 'DELETE'
              });

              if (!cacheResponse.ok) {
                console.warn('Failed to clear server cache - server may not be running');
              }
            } catch (serverError) {
              console.warn('Server cache clearing skipped - server not available:', serverError.message);
            }

            // 2. Clear all localStorage items
            localStorage.clear();

            // 3. Clear IndexedDB if used
            const databases = await window.indexedDB.databases();
            databases.forEach(db => {
              window.indexedDB.deleteDatabase(db.name);
            });
            // 4. Reload the page to apply changes
            window.location.reload();
          } catch (error) {
            console.error('Error during factory reset:', error);
            window.addToast(
              t('settings.factoryResetError', 'Error during factory reset: {{errorMessage}}', { errorMessage: error.message }),
              'error',
              8000
            );
            setIsFactoryResetting(false);
          }
        }
      }
    );
  };

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

  // Handle save button click
  const handleSave = async () => {
    // Save settings to localStorage
    localStorage.setItem('segment_duration', segmentDuration.toString());
    localStorage.setItem('gemini_model', geminiModel);
    localStorage.setItem('genius_token', geniusApiKey);
    localStorage.setItem('time_format', timeFormat);
    localStorage.setItem('video_processing_max_words', favoriteMaxSubtitleLength.toString());
    localStorage.setItem('show_favorite_max_length', showFavoriteMaxLength.toString());

    localStorage.setItem('show_waveform_long_videos', showWaveformLongVideos.toString());
    localStorage.setItem('segment_offset_correction', segmentOffsetCorrection.toString());
    localStorage.setItem('transcription_prompt', transcriptionPrompt);
    localStorage.setItem('use_youtube_oauth', useOAuth.toString());
    localStorage.setItem('use_video_analysis', useVideoAnalysis.toString());
    localStorage.setItem('video_analysis_model', videoAnalysisModel);
    localStorage.setItem('video_analysis_timeout', videoAnalysisTimeout);
    localStorage.setItem('enable_gemini_effects', enableGeminiEffects.toString());
    
    // Apply Gemini effects immediately in the same window
    if (enableGeminiEffects) {
      initGeminiButtonEffects();
    } else {
      disableGeminiButtonEffects();
    }
    
    // Trigger listeners (same-document) to apply effects immediately
    window.dispatchEvent(new Event('storage'));

    // Save the user's video optimization preference
    localStorage.setItem('optimize_videos', optimizeVideos.toString());
    localStorage.setItem('optimized_resolution', optimizedResolution);
    localStorage.setItem('use_optimized_preview', useOptimizedPreview.toString());
    localStorage.setItem('use_cookies_for_download', useCookiesForDownload.toString());
    localStorage.setItem('enable_youtube_search', enableYoutubeSearch.toString());
    localStorage.setItem('auto_import_site_subtitles', autoImportSiteSubtitles.toString());
    localStorage.setItem('thinking_budgets', JSON.stringify(thinkingBudgets));
    localStorage.setItem('custom_gemini_models', JSON.stringify(customGeminiModels));
    // Save the Gemini API key to the key manager
    // The key manager will handle updating the legacy key for backward compatibility
    const allKeys = getAllKeys();
    if (geminiApiKey && !allKeys.includes(geminiApiKey)) {
      const updatedKeys = [...allKeys, geminiApiKey];
      saveAllKeys(updatedKeys);
    }

    localStorage.setItem('youtube_api_key', youtubeApiKey);

    // Save localStorage data to server (only if backend is available)
    if (localStorage.getItem('backend_available') === 'true') {
      try {
        // Collect all localStorage data
        const localStorageData = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          localStorageData[key] = localStorage.getItem(key);
        }

        // Add specific keys for the server
        localStorageData.gemini_token = geminiApiKey;
        localStorageData.genius_token = geniusApiKey;

        // Send to server - using unified port configuration
        const response = await fetch('http://127.0.0.1:3031/api/save-local-storage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(localStorageData),
        });

        if (!response.ok) {
          throw new Error('Failed to save settings to server');
        }


      } catch (error) {
        console.error('Error saving settings to server:', error);
      }
    }

    // Notify parent component about API keys, segment duration, model, time format, video optimization settings, and cookie setting
    // Note: optimizeVideos parameter removed since it's always enabled now
    onSave(geminiApiKey, youtubeApiKey, geniusApiKey, segmentDuration, geminiModel, timeFormat, undefined, optimizedResolution, useOptimizedPreview, useCookiesForDownload, enableYoutubeSearch, showWaveformLongVideos);

    // Update original settings to match current settings
    setOriginalSettings({
      geminiApiKey,
      youtubeApiKey,
      geniusApiKey,
      segmentDuration,
      geminiModel,
      timeFormat,
      showWaveformLongVideos,
      segmentOffsetCorrection,
      transcriptionPrompt,
      useOAuth,
      youtubeClientId,
      youtubeClientSecret,
      useVideoAnalysis,
      videoAnalysisModel,
      videoAnalysisTimeout,
      enableGeminiEffects,

      optimizeVideos,
      optimizedResolution,
      useOptimizedPreview,
      useCookiesForDownload,
      enableYoutubeSearch,
      autoImportSiteSubtitles,
      favoriteMaxSubtitleLength,
      showFavoriteMaxLength,
      thinkingBudgets,
      customGeminiModels
    });

    // Reset changes flag and mark settings as loaded
    setHasChanges(false);
    setIsSettingsLoaded(true);

    handleClose();
  };

  // Handler for clicking the overlay to close the modal
  const handleOverlayClick = (e) => {
    // Only close if the click was directly on the overlay, not on the modal content
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  return (
    <div className={`settings-modal-overlay ${isClosing ? 'closing' : ''}`} onClick={handleOverlayClick}>
      <div className={`settings-modal ${isClosing ? 'closing' : ''}`} noValidate data-no-autofill>
        <div className="settings-header">
          <h2>{t('settings.title', 'Settings')}</h2>

          {/* Tab Navigation */}
          <div className="settings-tabs" ref={tabsRef} title={t('settings.dragToScroll', 'Drag to scroll tabs')}>
            <div className="pill-background"></div>
            <button
              className={`settings-tab ${activeTab === 'api-keys' ? 'active' : ''}`}
              onClick={() => setActiveTab('api-keys')}
            >
              <ApiKeyIcon />
              {t('settings.apiKeys', 'API Keys')}
            </button>
            <button
              className={`settings-tab ${activeTab === 'video-processing' ? 'active' : ''}`}
              onClick={() => setActiveTab('video-processing')}
            >
              <ProcessingIcon />
              {t('settings.videoProcessing', 'Video Processing')}
            </button>
            <button
              className={`settings-tab ${activeTab === 'prompts' ? 'active' : ''}`}
              onClick={() => setActiveTab('prompts')}
            >
              <PromptIcon />
              {t('settings.prompts', 'Prompts')}
            </button>
            <button
              className={`settings-tab ${activeTab === 'cache' ? 'active' : ''}`}
              onClick={() => setActiveTab('cache')}
            >
              <CacheIcon />
              {t('settings.cache', 'Cache')}
            </button>
            <button
              className={`settings-tab ${activeTab === 'model-management' ? 'active' : ''}`}
              onClick={() => setActiveTab('model-management')}
            >
              <ModelIcon />
              {t('settings.modelManagement', 'Narration Models')}
            </button>
            <button
              className={`settings-tab ${activeTab === 'about' ? 'active' : ''}`}
              onClick={() => {
                // Select a random background when clicking on the About tab
                if (activeTab !== 'about') {
                  // Possible background types: default, alternative, 1, 2, 3, 4, 5
                  const allBackgroundOptions = ['default', 'alternative', '1', '2', '3', '4', '5'];

                  // Get the history of recently used backgrounds from localStorage
                  let recentBackgrounds = [];
                  try {
                    const storedHistory = localStorage.getItem('about_background_history');
                    if (storedHistory) {
                      recentBackgrounds = JSON.parse(storedHistory);
                    }
                  } catch (e) {
                    console.error('Error parsing background history:', e);
                    // If there's an error, just use an empty array
                    recentBackgrounds = [];
                  }

                  // Filter out recently used backgrounds (if we have enough options)
                  // We'll avoid reusing the last 3 backgrounds if possible
                  let availableOptions = [...allBackgroundOptions];

                  // Only filter if we have enough options to choose from
                  if (allBackgroundOptions.length > recentBackgrounds.length) {
                    availableOptions = allBackgroundOptions.filter(
                      option => !recentBackgrounds.includes(option)
                    );
                  }

                  // If we somehow filtered out all options, use all backgrounds
                  if (availableOptions.length === 0) {
                    availableOptions = [...allBackgroundOptions];
                  }

                  // Select a random background from available options
                  const randomBackground = availableOptions[Math.floor(Math.random() * availableOptions.length)];

                  // Update the history - add the new background and keep only the last 3
                  recentBackgrounds.unshift(randomBackground);
                  if (recentBackgrounds.length > 3) {
                    recentBackgrounds = recentBackgrounds.slice(0, 3);
                  }

                  // Save the updated history
                  localStorage.setItem('about_background_history', JSON.stringify(recentBackgrounds));

                  // Save the selected background
                  localStorage.setItem('about_background_type', randomBackground);

                  // Update the state
                  setBackgroundType(randomBackground);
                }
                setActiveTab('about');
              }}
            >
              <AboutIcon />
              {t('settings.about', 'About')}
              {updateAvailable && (
                <span
                  className="tab-badge"
                  role="status"
                  aria-label={t('settings.updateAvailable', 'A new version is available!')}
                  title={t('settings.updateAvailable', 'A new version is available!')}
                />
              )}
            </button>
          </div>

          <CloseButton
            onClick={handleClose}
            variant="settings"
            size="large"
          />
        </div>

        <div className="settings-content">
          {/* API Keys Tab Content */}
          <div key="settings-tab-api-keys" className={`settings-tab-content ${activeTab === 'api-keys' ? 'active' : ''} settings-tab-content-slide-${animationDirection}`}>
            <ApiKeysTab
              geminiApiKey={geminiApiKey}
              setGeminiApiKey={setGeminiApiKey}
              youtubeApiKey={youtubeApiKey}
              setYoutubeApiKey={setYoutubeApiKey}
              geniusApiKey={geniusApiKey}
              setGeniusApiKey={setGeniusApiKey}
              showGeminiKey={showGeminiKey}
              setShowGeminiKey={setShowGeminiKey}
              showYoutubeKey={showYoutubeKey}
              setShowYoutubeKey={setShowYoutubeKey}
              showGeniusKey={showGeniusKey}
              setShowGeniusKey={setShowGeniusKey}
              useOAuth={useOAuth}
              setUseOAuth={setUseOAuth}
              youtubeClientId={youtubeClientId}
              setYoutubeClientId={setYoutubeClientId}
              youtubeClientSecret={youtubeClientSecret}
              setYoutubeClientSecret={setYoutubeClientSecret}
              showClientId={showClientId}
              setShowClientId={setShowClientId}
              showClientSecret={showClientSecret}
              setShowClientSecret={setShowClientSecret}
              isAuthenticated={isAuthenticated}
              setIsAuthenticated={setIsAuthenticated}
              apiKeysSet={apiKeysSet}
              setApiKeysSet={setApiKeysSet}
              enableYoutubeSearch={enableYoutubeSearch}
            />
          </div>

          {/* Video Processing Tab Content */}
          <div key="settings-tab-video-processing" className={`settings-tab-content ${activeTab === 'video-processing' ? 'active' : ''} settings-tab-content-slide-${animationDirection}`}>
            <VideoProcessingTab
              segmentDuration={segmentDuration}
              setSegmentDuration={setSegmentDuration}
              geminiModel={geminiModel}
              setGeminiModel={setGeminiModel}
              timeFormat={timeFormat}
              setTimeFormat={setTimeFormat}
              showWaveformLongVideos={showWaveformLongVideos}
              setShowWaveformLongVideos={setShowWaveformLongVideos}
              useVideoAnalysis={useVideoAnalysis}
              setUseVideoAnalysis={setUseVideoAnalysis}
              videoAnalysisModel={videoAnalysisModel}
              setVideoAnalysisModel={setVideoAnalysisModel}
              videoAnalysisTimeout={videoAnalysisTimeout}
              setVideoAnalysisTimeout={setVideoAnalysisTimeout}

              optimizeVideos={optimizeVideos}
              setOptimizeVideos={setOptimizeVideos}
              optimizedResolution={optimizedResolution}
              setOptimizedResolution={setOptimizedResolution}
              useOptimizedPreview={useOptimizedPreview}
              setUseOptimizedPreview={setUseOptimizedPreview}
              useCookiesForDownload={useCookiesForDownload}
              setUseCookiesForDownload={setUseCookiesForDownload}
              enableYoutubeSearch={enableYoutubeSearch}
              setEnableYoutubeSearch={setEnableYoutubeSearch}
              autoImportSiteSubtitles={autoImportSiteSubtitles}
              setAutoImportSiteSubtitles={setAutoImportSiteSubtitles}
              thinkingBudgets={thinkingBudgets}
              setThinkingBudgets={setThinkingBudgets}
              customGeminiModels={customGeminiModels}
              setCustomGeminiModels={setCustomGeminiModels}
              enableGeminiEffects={enableGeminiEffects}
              setEnableGeminiEffects={setEnableGeminiEffects}
              favoriteMaxSubtitleLength={favoriteMaxSubtitleLength}
              setFavoriteMaxSubtitleLength={setFavoriteMaxSubtitleLength}
              showFavoriteMaxLength={showFavoriteMaxLength}
              setShowFavoriteMaxLength={setShowFavoriteMaxLength}
            />
          </div>

          {/* Prompts Tab Content */}
          <div key="settings-tab-prompts" className={`settings-tab-content ${activeTab === 'prompts' ? 'active' : ''} settings-tab-content-slide-${animationDirection}`}>
            <PromptsTab
              transcriptionPrompt={transcriptionPrompt}
              setTranscriptionPrompt={setTranscriptionPrompt}
            />
          </div>

          {/* Cache Management Tab Content */}
          <div key="settings-tab-cache" className={`settings-tab-content ${activeTab === 'cache' ? 'active' : ''} settings-tab-content-slide-${animationDirection}`}>
            <CacheTab isActive={activeTab === 'cache'} />
          </div>

          {/* Model Management Tab Content */}
          <div key="settings-tab-model-management" className={`settings-tab-content ${activeTab === 'model-management' ? 'active' : ''} settings-tab-content-slide-${animationDirection}`}>
            <ModelManagementTab activeTab={activeTab} />
          </div>

          {/* About Tab Content */}
          <div key="settings-tab-about" className={`settings-tab-content ${activeTab === 'about' ? 'active' : ''} settings-tab-content-slide-${animationDirection}`}>
            <AboutTab backgroundType={backgroundType} />
          </div>
        </div>

        <div className="settings-footer">
          <div className="settings-footer-left">
            {/* Theme toggle and language selector */}
            <SettingsFooterControls isDropup={true} showFontDropdown={true} />

            {/* Factory reset button */}
            <button
              className="factory-reset-btn"
              onClick={handleFactoryReset}
              disabled={isFactoryResetting}
              title={t('settings.factoryResetTooltip', 'Reset application to factory settings')}
            >
              {isFactoryResetting ? (
                <>
                  <LoadingIndicator size={16} theme="light" showContainer={false} />
                  {t('settings.resetting', 'Resetting...')}
                </>
              ) : (
                t('settings.factoryReset', 'Factory Reset')
              )}
            </button>
          </div>
          <div className="settings-footer-right">
            <button
              className="cancel-btn"
              onClick={handleClose}
              title={t('settings.pressEscToClose', 'Press ESC to close')}
            >
              {t('common.cancel', 'Cancel')} <span className="key-hint">(ESC)</span>
            </button>
            <button
              className="save-btn"
              onClick={handleSave}
              disabled={!hasChanges}
              title={!hasChanges ? t('settings.noChanges', 'No changes to save') : t('settings.saveChanges', 'Save changes')}
            >
              {t('common.save', 'Save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
