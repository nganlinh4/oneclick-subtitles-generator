import React from 'react';
import { useTranslation } from 'react-i18next';
import LoadingIndicator from '../common/LoadingIndicator';
import { addModelFromHuggingFace, cancelModelDownload } from '../../services/modelService';
import { invalidateModelsCache } from '../../services/modelAvailabilityService';
import '../../styles/settings/modelManagement.css';

// List of available models from F5-TTS SHARED.md
const AVAILABLE_MODELS = [
  {
    "id": "f5tts-de-marduk",
    "name": "F5-TTS German (marduk-ra)",
    "languages": ["de"],
    "author": "marduk-ra",
    "modelUrl": "https://huggingface.co/marduk-ra/F5-TTS-German/blob/main/f5_tts_german_1010000.safetensors", // Placeholder filename, needs verification
    "vocabUrl": "https://huggingface.co/marduk-ra/F5-TTS-German/blob/main/vocab.txt", // Placeholder filename, needs verification
    "config": {
      "dim": 1024,
      "depth": 22,
      "heads": 16,
      "ff_mult": 2,
      "text_dim": 512,
      "text_mask_padding": false,
      "conv_layers": 4,
      "pe_attn_head": 1
    }
  },
  {
    "id": "f5tts-v1-base", // Primarily zh, en
    "name": "F5-TTS v1 Base",
    "languages": ["zh", "en"],
    "author": "F5-TTS",
    "modelUrl": "https://huggingface.co/SWivid/F5-TTS/resolve/main/F5TTS_v1_Base/model_1250000.safetensors",
    "vocabUrl": "https://huggingface.co/SWivid/F5-TTS/resolve/main/F5TTS_v1_Base/vocab.txt",
    "config": {
      "dim": 1024,
      "depth": 22,
      "heads": 16,
      "ff_mult": 2,
      "text_dim": 512,
      "conv_layers": 4
    }
  },
  {
    "id": "f5tts-base-es",
    "name": "F5-TTS Base Spanish",
    "languages": ["es"],
    "author": "jpgallegoar",
    "modelUrl": "https://huggingface.co/jpgallegoar/F5-Spanish/resolve/main/model_1250000.safetensors",
    "vocabUrl": "https://huggingface.co/jpgallegoar/F5-Spanish/resolve/main/vocab.txt",
    "config": {
      "dim": 1024,
      "depth": 22,
      "heads": 16,
      "ff_mult": 2,
      "text_dim": 512,
      "text_mask_padding": false,
      "conv_layers": 4,
      "pe_attn_head": 1
    }
  },
  {
    "id": "f5tts-base-fi",
    "name": "F5-TTS Base Finnish",
    "languages": ["fi"],
    "author": "AsmoKoskinen",
    "modelUrl": "https://huggingface.co/AsmoKoskinen/F5-TTS_Finnish_Model/resolve/main/model_common_voice_fi_vox_populi_fi_20241206.safetensors",
    "vocabUrl": "https://huggingface.co/AsmoKoskinen/F5-TTS_Finnish_Model/resolve/main/vocab.txt",
    "config": {
      "dim": 1024,
      "depth": 22,
      "heads": 16,
      "ff_mult": 2,
      "text_dim": 512,
      "text_mask_padding": false,
      "conv_layers": 4,
      "pe_attn_head": 1
    }
  },
  {
    "id": "f5tts-small-hi",
    "name": "F5-TTS Small Hindi",
    "languages": ["hi"],
    "author": "SPRINGLab",
    "modelUrl": "https://huggingface.co/SPRINGLab/F5-Hindi-24KHz/resolve/main/model_2500000.safetensors",
    "vocabUrl": "https://huggingface.co/SPRINGLab/F5-Hindi-24KHz/resolve/main/vocab.txt",
    "config": {
      "dim": 768,
      "depth": 18,
      "heads": 12,
      "ff_mult": 2,
      "text_dim": 512,
      "text_mask_padding": false,
      "conv_layers": 4,
      "pe_attn_head": 1
    }
  },
  {
    "id": "f5tts-base-it",
    "name": "F5-TTS Base Italian",
    "languages": ["it"],
    "author": "alien79",
    "modelUrl": "https://huggingface.co/alien79/F5-TTS-italian/blob/main/model_159600.safetensors",
    "vocabUrl": "https://huggingface.co/alien79/F5-TTS-italian/blob/main/vocab.txt",
    "config": {
      "dim": 1024,
      "depth": 22,
      "heads": 16,
      "ff_mult": 2,
      "text_dim": 512,
      "text_mask_padding": false,
      "conv_layers": 4,
      "pe_attn_head": 1
    }
  },
  {
    "id": "f5tts-pl-en-de",
    "name": "F5-TTS English German Polish",
    "languages": ["pl"],
    "author": "Gregniuki",
    "modelUrl": "https://huggingface.co/Gregniuki/F5-tts_English_German_Polish/blob/main/Polish/model_270000.safetensors",
    "vocabUrl": "https://huggingface.co/Gregniuki/F5-tts_English_German_Polish/blob/main/Polish/vocab.txt",
    "config": {
      "dim": 1024,
      "depth": 22,
      "heads": 16,
      "ff_mult": 2,
      "text_dim": 512,
      "text_mask_padding": false,
      "conv_layers": 4,
      "pe_attn_head": 1
    }
  },
  {
    "id": "f5tts-base-ru",
    "name": "F5-TTS Base Russian",
    "languages": ["ru"],
    "author": "hotstone228",
    "modelUrl": "https://huggingface.co/hotstone228/F5-TTS-Russian/resolve/main/model_last.safetensors",
    "vocabUrl": "https://huggingface.co/hotstone228/F5-TTS-Russian/resolve/main/vocab.txt",
    "config": {
      "dim": 1024,
      "depth": 22,
      "heads": 16,
      "ff_mult": 2,
      "text_dim": 512,
      "text_mask_padding": false,
      "conv_layers": 4,
      "pe_attn_head": 1
    }
  },
  {
    "id": "hynt-vivoice",
    "name": "Hynt Vivoice F5 (Vietnamese)",
    "languages": ["vi"],
    "author": "hynt",
    "modelUrl": "https://huggingface.co/hynt/F5-TTS-Vietnamese-ViVoice/resolve/main/model_last.pt",
    "vocabUrl": "https://huggingface.co/hynt/F5-TTS-Vietnamese-ViVoice/resolve/main/config.json",
    "config": {
      "dim": 1024,
      "depth": 22,
      "heads": 16,
      "ff_mult": 2,
      "text_dim": 512,
      "text_mask_padding": false,
      "conv_layers": 4,
      "pe_attn_head": 1
    }
  }
];

// Language name mapping
const LANGUAGE_NAMES = {
  'ar': 'Arabic',
  'de': 'German',
  'en': 'English',
  'es': 'Spanish',
  'fi': 'Finnish',
  'fr': 'French',
  'hi': 'Hindi',
  'it': 'Italian',
  'ja': 'Japanese',
  'ms': 'Malay',
  'pl': 'Polish',
  'pt-br': 'Portuguese (BR)',
  'ru': 'Russian',
  'vi': 'Vietnamese',
  'zh': 'Chinese'
};

// Language color mapping
const LANGUAGE_COLORS = {
  'ar': 'warning',
  'de': 'info',
  'en': 'success',
  'es': 'success',
  'fi': 'info',
  'fr': 'secondary',
  'hi': 'warning',
  'it': 'error',
  'ja': 'default',
  'pl': 'error',
  'pt-br': 'warning',
  'ru': 'primary',
  'vi': 'secondary',
  'zh': 'primary'
};

const ModelList = ({ onModelAdded, downloadingModels = {}, installedModels = [], onAddModelClick }) => {
  const { t } = useTranslation();
  const [downloading, setDownloading] = React.useState({});

  // Create a list of installed model IDs for filtering
  const installedModelIds = React.useMemo(() => {
    return installedModels.map(model => model.id);
  }, [installedModels]);

  const handleDownload = async (model) => {
    try {
      // Check if the model is already installed
      if (isModelInstalled(model.id)) {

        return;
      }

      setDownloading(prev => ({ ...prev, [model.id]: true }));

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
    } finally {
      setDownloading(prev => ({ ...prev, [model.id]: false }));
    }
  };

  // Handle cancelling a model download
  const handleCancelDownload = async (modelId) => {
    try {
      // Call API to cancel download
      const response = await cancelModelDownload(modelId);

      if (response.success) {

        // Remove from local downloading state
        setDownloading(prev => {
          const newState = { ...prev };
          delete newState[modelId];
          return newState;
        });

        // Invalidate the models cache to notify other components
        invalidateModelsCache();

        // Notify parent component to refresh the model list
        if (onModelAdded) {
          onModelAdded();
        }
      }
    } catch (error) {
      console.error('Error cancelling model download:', error);
    }
  };

  // Check if a model is currently downloading
  const isDownloading = (modelId) => {
    return downloading[modelId] || (downloadingModels[modelId] && downloadingModels[modelId].status === 'downloading');
  };

  // Get download progress if available
  const getDownloadProgress = (modelId) => {
    if (downloadingModels[modelId] && downloadingModels[modelId].status === 'downloading') {
      // Use the progress value directly from the server
      return downloadingModels[modelId].progress || 0;
    }
    return 0;
  };

  // Check if a model is already installed
  const isModelInstalled = (modelId) => {
    return installedModelIds.includes(modelId);
  };

  return (
    <div className="model-management-section">
      <div className="section-header">
        <h4>{t('settings.modelManagement.availableModels')}</h4>
      </div>

      <div className="model-cards-container">
        {AVAILABLE_MODELS.filter(model => {
          // Always filter out models that are already installed
          if (isModelInstalled(model.id)) {
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

            {isDownloading(model.id) ? (
              <div>
                <div className="download-progress">
                  <div
                    className="download-progress-bar"
                    style={{
                      width: downloadingModels[model.id] && downloadingModels[model.id].progress !== undefined
                        ? `${downloadingModels[model.id].progress}%`
                        : '10%' // Default progress when no information is available
                    }}
                  ></div>
                </div>
                <div className="model-card-actions">
                  <div className="download-percentage">
                    <LoadingIndicator
                      theme="dark"
                      showContainer={false}
                      size={16}
                      className="download-progress-indicator"
                    />
                    <span>
                      {/* Always show percentage format only */}
                      {getDownloadProgress(model.id) ? `${getDownloadProgress(model.id)}%` : ''}
                    </span>
                  </div>
                  <button
                    className="cancel-download-btn"
                    onClick={() => handleCancelDownload(model.id)}
                    title={t('settings.modelManagement.cancelDownload', 'Cancel Download')}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 20 }}>close</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="model-card-actions">
                <button
                  className="download-model-btn"
                  onClick={() => handleDownload(model)}
                  title={t('settings.modelManagement.downloadModel')}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 16 }}>download</span>
                  {t('settings.modelManagement.download')}
                </button>
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

        {AVAILABLE_MODELS.filter(model => !isModelInstalled(model.id)).length === 0 && (
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

export { LANGUAGE_NAMES, LANGUAGE_COLORS, AVAILABLE_MODELS };
export default ModelList;
