import React from 'react';
import { useTranslation } from 'react-i18next';
import LoadingIndicator from '../../common/LoadingIndicator';
import ModelCard from './ModelCard';

/**
 * Component for displaying installed models
 * @param {Object} props - Component props
 * @param {Array} props.models - List of installed models
 * @param {Object} props.modelSizes - Model sizes
 * @param {Object} props.downloads - Download information
 * @param {boolean} props.loading - Whether models are loading
 * @param {boolean} props.isScanning - Whether models are being scanned
 * @param {Function} props.onScan - Function to call when scan button is clicked
 * @param {Function} props.onEdit - Function to call when edit button is clicked
 * @param {Function} props.onDelete - Function to call when delete button is clicked
 * @param {Function} props.onCancelDownload - Function to call when download is cancelled
 * @returns {JSX.Element} - Rendered component
 */
const InstalledModelsList = ({
  models,
  modelSizes,
  downloads,
  loading,
  isScanning,
  onScan,
  onEdit,
  onDelete,
  onCancelDownload
}) => {
  const { t } = useTranslation();

  return (
    <>
      <div className="section-header">
        <h4>{t('settings.modelManagement.installedModels')}</h4>
        <button
          className="refresh-models-btn"
          onClick={onScan}
          disabled={isScanning}
          title={t('settings.modelManagement.refreshModels', 'Scan for new models')}
        >
          <span className={`material-symbols-rounded ${isScanning ? 'spinning' : ''}`}>refresh</span>
          {t('settings.modelManagement.refresh', 'Refresh')}
        </button>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
          <LoadingIndicator theme="dark" showContainer={false} size={32} />
        </div>
      ) : models.length === 0 && Object.keys(downloads).length === 0 ? (
        <p className="model-source" style={{ textAlign: 'center', padding: '1rem' }}>
          {t('settings.modelManagement.noModelsInstalled')}
        </p>
      ) : (
        <div className="model-cards-container">
          {models.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              modelSize={modelSizes[model.id]}
              downloadInfo={downloads[model.id]}
              onEdit={onEdit}
              onDelete={onDelete}
              onCancelDownload={onCancelDownload}
            />
          ))}
        </div>
      )}
    </>
  );
};

export default InstalledModelsList;
