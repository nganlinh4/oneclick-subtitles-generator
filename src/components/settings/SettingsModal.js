import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import '../../styles/SettingsModal.css';
import '../../styles/settings/checkbox-fix.css';
import '../../styles/components/tab-content-animations.css';
import SettingsFooterControls from './SettingsFooterControls';
import CloseButton from '../common/CloseButton';
import { clearCache } from '../../platform/cacheService';
import { clearCredentials } from '../../platform/credentialStateController';
import { clearMedia } from '../../platform/mediaService';
import { clearDesktopSettings } from '../../platform/settingsService';

// Import modularized components
import ApiKeysTab from './tabs/ApiKeysTab';
import VideoProcessingTab from './tabs/VideoProcessingTab';
import PromptsTab from './tabs/PromptsTab';
import CacheTab from './tabs/CacheTab';
import AboutTab from './tabs/AboutTab';
import ModelManagementTab from './ModelManagementTab';
import EnginesPanel from '../engines/EnginesPanel';

// Import icons
import { ApiKeyIcon, ProcessingIcon, PromptIcon, CacheIcon, AboutIcon, ModelIcon } from './icons/TabIcons';
import LoadingIndicator from '../common/LoadingIndicator';
import {
  refreshDesktopUpdateCheck,
  startStartupUpdateCheck,
  subscribeDesktopUpdateStatus,
} from '../../platform/startupUpdateCoordinator';

// Extracted hooks + helpers
import useSettingsState from './hooks/useSettingsState';
import useSettingsPersistence from './hooks/useSettingsPersistence';
import { useSettingsTabPillInit, useSettingsTabPillUpdate } from './utils/settingsAnimationHelpers';

export const clearNativeApplicationState = () => Promise.all([
  clearCache(),
  clearCredentials(),
  clearMedia(),
  clearDesktopSettings(),
]);

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
    const applyStatus = (status) => {
      if (mounted) setUpdateAvailable(Boolean(status?.configured && status.update));
    };
    const unsubscribe = subscribeDesktopUpdateStatus(applyStatus);
    startStartupUpdateCheck().then(applyStatus);
    return () => { mounted = false; unsubscribe(); };
  }, []);

  // Initialize pill position and drag functionality on component mount
  useSettingsTabPillInit(tabsRef);

  // Update pill position + animation direction when active tab changes
  useSettingsTabPillUpdate({
    tabsRef,
    activeTab,
    previousTab,
    setAnimationDirection,
    setPreviousTab,
  });

  // All settings state + setters, load/migration effect, and change detection
  const settings = useSettingsState();
  const {
    hasChanges,
    geminiApiKey, setGeminiApiKey,
    youtubeApiKey, setYoutubeApiKey,
    geniusApiKey, setGeniusApiKey,
    showGeminiKey, setShowGeminiKey,
    showYoutubeKey, setShowYoutubeKey,
    showGeniusKey, setShowGeniusKey,
    useOAuth, setUseOAuth,
    youtubeClientId, setYoutubeClientId,
    youtubeClientSecret, setYoutubeClientSecret,
    showClientId, setShowClientId,
    showClientSecret, setShowClientSecret,
    isAuthenticated, setIsAuthenticated,
    segmentDuration, setSegmentDuration,
    geminiModel, setGeminiModel,
    timeFormat, setTimeFormat,
    showWaveformLongVideos, setShowWaveformLongVideos,
    useVideoAnalysis, setUseVideoAnalysis,
    videoAnalysisModel, setVideoAnalysisModel,
    videoAnalysisTimeout, setVideoAnalysisTimeout,
    enableGeminiEffects, setEnableGeminiEffects,
    optimizeVideos, setOptimizeVideos,
    optimizedResolution, setOptimizedResolution,
    useOptimizedPreview, setUseOptimizedPreview,
    isFactoryResetting, setIsFactoryResetting,
    thinkingBudgets, setThinkingBudgets,
    transcriptionPrompt, setTranscriptionPrompt,
    useCookiesForDownload, setUseCookiesForDownload,
    enableYoutubeSearch, setEnableYoutubeSearch,
    autoImportSiteSubtitles, setAutoImportSiteSubtitles,
    favoriteMaxSubtitleLength, setFavoriteMaxSubtitleLength,
    showFavoriteMaxLength, setShowFavoriteMaxLength,
    customGeminiModels, setCustomGeminiModels,
  } = settings;

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
            // Native artifacts, credentials, media, and settings live outside WebView storage.
            await clearNativeApplicationState();

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

  // Handle save button click (localStorage + server persistence + callback dispatch)
  const { handleSave } = useSettingsPersistence({
    ...settings,
    onSave,
    handleClose,
  });

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
              className={`settings-tab ${activeTab === 'tools' ? 'active' : ''}`}
              onClick={() => setActiveTab('tools')}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 20 }}>build</span>
              {t('settings.tools', 'Tools')}
            </button>
            <button
              className={`settings-tab ${activeTab === 'about' ? 'active' : ''}`}
              onClick={() => {
                if (activeTab === 'about') {
                  refreshDesktopUpdateCheck().catch(() => undefined);
                }
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

          {/* Tools Tab Content (on-demand engines) */}
          <div key="settings-tab-tools" className={`settings-tab-content ${activeTab === 'tools' ? 'active' : ''} settings-tab-content-slide-${animationDirection}`}>
            <EnginesPanel />
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
