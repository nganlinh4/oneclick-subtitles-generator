import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import WavyProgressIndicator from '../../common/WavyProgressIndicator';
import { addModelFromHuggingFace, cancelModelDownload } from '../../../services/modelService';
import { invalidateModelsCache } from '../../../services/modelAvailabilityService';
import { AVAILABLE_MODELS, LANGUAGE_NAMES } from '../ModelList';
import { isDownloading, getDownloadProgress, isModelInstalled } from './modelManagementUtils';

/**
 * Component for displaying available models
 * @param {Object} props - Component props
 * @param {Array} props.installedModels - List of installed models
 * @param {Object} props.downloads - Download information
 * @param {Function} props.onModelAdded - Function to call when a model is added
 * @param {Function} props.onAddModelClick - Function to call when add model button is clicked
 * @param {Function} props.setDownloads - Function to update downloads state
 * @returns {JSX.Element} - Rendered component
 */
const AvailableModelsList = ({
  installedModels = [],
  downloads = {},
  onModelAdded,
  onAddModelClick,
  setDownloads,
  customModels = [],
  setCustomModels
}) => {
  const { t } = useTranslation();

  // Refs for WavyProgressIndicator animations (one per model)
  const wavyProgressRefs = useRef({});

  // Theme detection for WavyProgressIndicator colors
  const [theme, setTheme] = useState(() => {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  });

  useEffect(() => {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          const newTheme = document.documentElement.getAttribute('data-theme') || 'dark';
          setTheme(newTheme);
        }
      });
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });

    // Also listen for storage events (theme changes from other tabs)
    const handleStorageChange = () => {
      const newTheme = document.documentElement.getAttribute('data-theme') || 'dark';
      setTheme(newTheme);
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      observer.disconnect();
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  // Track download state changes for entrance/disappear animations
  const [previousDownloads, setPreviousDownloads] = useState({});

  useEffect(() => {
    // Check for newly started downloads (entrance animation)
    Object.keys(downloads).forEach(modelId => {
      const wasDownloading = isDownloading(modelId, previousDownloads);
      const isNowDownloading = isDownloading(modelId, downloads);

      if (!wasDownloading && isNowDownloading) {
        // Started downloading - trigger entrance animation
        const ref = wavyProgressRefs.current[modelId];
        if (ref) {
          ref.startEntranceAnimation();
        }
      }
    });

    // Check for completed/cancelled downloads (disappear animation)
    Object.keys(previousDownloads).forEach(modelId => {
      const wasDownloading = isDownloading(modelId, previousDownloads);
      const isNowDownloading = isDownloading(modelId, downloads);

      if (wasDownloading && !isNowDownloading) {
        // Stopped downloading - trigger disappear animation
        const ref = wavyProgressRefs.current[modelId];
        if (ref) {
          ref.startDisappearanceAnimation();
        }
      }
    });

    setPreviousDownloads(downloads);
  }, [downloads, previousDownloads]);

  // Create a list of installed model IDs for filtering
  const installedModelIds = React.useMemo(() => {
    return installedModels.map(model => model.id);
  }, [installedModels]);

  // Combine built-in models with custom models
  const allAvailableModels = React.useMemo(() => {
    return [...AVAILABLE_MODELS, ...customModels];
  }, [customModels]);

  // Handle downloading a model
  const handleDownload = async (model) => {
    try {
      // Check if the model is already installed
      if (isModelInstalled(model.id, installedModelIds)) {

        return;
      }

      // Update downloads state to show progress
      setDownloads(prev => ({
        ...prev,
        [model.id]: {
          status: 'downloading',
          progress: 0
        }
      }));

      // Prepare model data for API
      const modelData = {
        modelUrl: model.modelUrl,
        vocabUrl: model.vocabUrl,
        modelId: model.id,
        languageCodes: model.languages, // Include language codes
        config: model.config
      };

      // Call API to add model
      const response = await addModelFromHuggingFace(modelData);

      if (response.success) {
        // Invalidate the models cache to notify other components
        invalidateModelsCache();

        // Notify parent component
        if (onModelAdded) {
          onModelAdded(response.model_id);
        }
      }
    } catch (error) {
      console.error('Error downloading model:', error);
      
      // Update downloads state to show error
      setDownloads(prev => ({
        ...prev,
        [model.id]: {
          status: 'failed',
          error: error.message || t('settings.modelManagement.downloadFailed')
        }
      }));
    }
  };

  // Handle cancelling a model download
  const handleCancelDownload = async (modelId) => {
    try {
      // Trigger disappear animation first
      const ref = wavyProgressRefs.current[modelId];
      if (ref) {
        ref.startDisappearanceAnimation();
      }

      // Call API to cancel download
      const response = await cancelModelDownload(modelId);

      if (response.success) {
        // Wait for disappear animation to complete (400ms) before removing from state
        setTimeout(() => {
          // Remove from downloads state
          setDownloads(prev => {
            const newDownloads = { ...prev };
            delete newDownloads[modelId];
            return newDownloads;
          });

          // Invalidate the models cache to notify other components
          invalidateModelsCache();

          // Notify parent component to refresh the model list
          if (onModelAdded) {
            onModelAdded();
          }
        }, 450); // Slightly longer than animation duration (400ms)
      }
    } catch (error) {
      console.error('Error cancelling model download:', error);
    }
  };

  return (
    <div className="model-management-section">
      <div className="section-header">
        <h4>{t('settings.modelManagement.availableModels')}</h4>
      </div>

      <div className="model-cards-container">
        {allAvailableModels.filter(model => {
          // Always filter out models that are already installed
          if (isModelInstalled(model.id, installedModelIds)) {
            return false;
          }

          // Special case: F5-TTS v1 Base should not be shown in available models
          // if there are no installed models, as it's the default model
          if (model.id === 'f5tts-v1-base' && installedModelIds.length === 0) {
            return false;
          }

          return true;
        }).map((model) => (
          <div className="model-card" key={model.id}>
            <div className="model-card-content">
              <h5 className="model-title">{model.name}</h5>
              <p className="model-author">{t('settings.modelManagement.by')} {model.author}</p>

              <div className="model-languages">
                {model.languages.map(lang => (
                  <span
                    key={lang}
                    className={`language-chip ${lang}`}
                  >
                    {LANGUAGE_NAMES[lang] || lang}
                  </span>
                ))}
              </div>
            </div>

            {isDownloading(model.id, {}, downloads) ? (
              <div>

                {/* Move progress above the actions border */}
                <div className="model-card-progress" style={{ padding: '8px 0 0', width: '100%' }}>
                  <div style={{ width: '100%' }}>
                    <WavyProgressIndicator
                      ref={(ref) => {
                        if (ref) {
                          wavyProgressRefs.current[model.id] = ref;
                        } else {
                          delete wavyProgressRefs.current[model.id];
                        }
                      }}
                      height={12}
                      progress={Math.max(0, Math.min(1, (getDownloadProgress(model.id, downloads) || 0) / 100))}
                      animate={true}
                      showStopIndicator={true}
                      waveSpeed={1.2}
                      color={theme === 'dark' ? '#FFFFFF' : '#485E92'}
                      trackColor={theme === 'dark' ? 'rgba(255,255,255,0.3)' : '#D9DFF6'}
                    />
                  </div>
                </div>

                <div className="model-card-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span className="download-percent-label">
                    {getDownloadProgress(model.id, downloads) ? `${getDownloadProgress(model.id, downloads)}%` : ''}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {/* Show delete button for custom models */}
                    {customModels.some(cm => cm.id === model.id) && (
                      <button
                        className="delete-model-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          const updatedCustomModels = customModels.filter(cm => cm.id !== model.id);
                          setCustomModels(updatedCustomModels);
                          localStorage.setItem('customModels', JSON.stringify(updatedCustomModels));
                        }}
                        title={t('settings.modelManagement.deleteCustomModel', 'Delete custom model template')}
                      >
                        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                      </button>
                    )}
                    <button
                      className="cancel-download-btn"
                      onClick={() => handleCancelDownload(model.id)}
                      title={t('settings.modelManagement.cancelDownload', 'Cancel Download')}
                    >
                      <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="model-card-actions">
                <button
                  className="download-model-btn"
                  onClick={() => handleDownload(model)}
                  title={t('settings.modelManagement.downloadModel')}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 20 }}>download</span>
                  {t('settings.modelManagement.download')}
                </button>
                {/* Show delete button for custom models */}
                {customModels.some(cm => cm.id === model.id) && (
                  <button
                    className="delete-model-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      const updatedCustomModels = customModels.filter(cm => cm.id !== model.id);
                      setCustomModels(updatedCustomModels);
                      localStorage.setItem('customModels', JSON.stringify(updatedCustomModels));
                    }}
                    title={t('settings.modelManagement.deleteCustomModel', 'Delete custom model template')}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 16 }}>close</span>
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

        {/* Add model card */}
        <div className="add-model-card" onClick={onAddModelClick}>
          <div className="add-model-icon">
            <span className="material-symbols-rounded" style={{ fontSize: 35 }}>add</span>
          </div>
          <p>{t('settings.modelManagement.addCustomModel')}</p>
        </div>

        {allAvailableModels.filter(model => !isModelInstalled(model.id, installedModelIds)).length === 0 && (
          <div className="model-card">
            <p className="model-source" style={{ textAlign: 'center', padding: '2rem 0' }}>
              {t('settings.modelManagement.allModelsInstalled')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default AvailableModelsList;
