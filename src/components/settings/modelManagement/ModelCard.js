import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatBytes } from '../../../utils/formatUtils';
import DownloadProgress from './DownloadProgress';
import { LANGUAGE_NAMES } from '../ModelList';

/**
 * Component for displaying a model card
 * @param {Object} props - Component props
 * @param {Object} props.model - Model data
 * @param {number} props.modelSize - Model size in bytes
 * @param {Object} props.downloadInfo - Download information
 * @param {Function} props.onEdit - Function to call when edit button is clicked
 * @param {Function} props.onDelete - Function to call when delete button is clicked
 * @param {Function} props.onCancelDownload - Function to call when download is cancelled
 * @returns {JSX.Element} - Rendered component
 */
const ModelCard = ({ 
  model, 
  modelSize, 
  downloadInfo, 
  onEdit, 
  onDelete, 
  onCancelDownload 
}) => {
  const { t } = useTranslation();

  return (
    <div className="model-card installed-model" key={model.id}>
      <div className="model-card-content">
        <h5 className="model-title">{model.name}</h5>
        <p className="model-source">{t('settings.modelManagement.source')}: {model.source}</p>

        {/* Show model size for all models except F5-TTS v1 Base */}
        {model.id !== 'f5tts-v1-base' && modelSize ? (
          <p className="model-size">{formatBytes(modelSize)}</p>
        ) : (
          /* Add an empty placeholder with the same height for the default model to maintain consistent spacing */
          <p className="model-size empty-size">&nbsp;</p>
        )}

        <div className="model-languages">
          {model.languages && model.languages.length > 0 ? (
            model.languages.map(lang => (
              <span
                key={lang}
                className={`language-chip ${lang}`}
              >
                {LANGUAGE_NAMES[lang] || lang}
              </span>
            ))
          ) : model.language && model.language !== 'unknown' && (
            <span className={`language-chip ${model.language}`}>
              {model.language}
            </span>
          )}
        </div>

        {/* Show download status if this model is being downloaded */}
        {downloadInfo && (
          <DownloadProgress 
            downloadInfo={downloadInfo} 
            modelId={model.id} 
            onCancel={onCancelDownload} 
          />
        )}
      </div>

      <div className="model-card-actions">
        <button
          className="edit-model-btn"
          onClick={() => onEdit(model)}
          title={t('settings.modelManagement.editModel', 'Edit model information')}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 20 }}>edit</span>
        </button>

        {/* Hide delete button for F5-TTS v1 Base model */}
        {model.id !== 'f5tts-v1-base' && (
          <button
            className="delete-model-btn"
            onClick={() => onDelete(model)}
            title={t('settings.modelManagement.deleteModel', 'Delete model')}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 20 }}>delete</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default ModelCard;
