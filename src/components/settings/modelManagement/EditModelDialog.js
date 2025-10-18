import React from 'react';
import { useTranslation } from 'react-i18next';
import CustomModelDialog from '../CustomModelDialog';
import LanguageCodeInput from './LanguageCodeInput';
import CustomScrollbarTextarea from '../../common/CustomScrollbarTextarea';

/**
 * Component for editing a model
 * @param {Object} props - Component props
 * @param {boolean} props.isOpen - Whether the dialog is open
 * @param {Function} props.onClose - Function to call when dialog is closed
 * @param {Object} props.model - Model to edit
 * @param {Object} props.form - Form state
 * @param {Function} props.onFormChange - Function to call when form changes
 * @param {Function} props.onLanguageCodesChange - Function to call when language codes change
 * @param {Function} props.onEditModel - Function to call when edit button is clicked
 * @param {boolean} props.isEditing - Whether a model is being edited
 * @param {Object} props.storageInfo - Model storage information
 * @returns {JSX.Element} - Rendered component
 */
const EditModelDialog = ({
  isOpen,
  onClose,
  model,
  form,
  onFormChange,
  onLanguageCodesChange,
  onEditModel,
  isEditing,
  storageInfo
}) => {
  const { t } = useTranslation();

  if (!model) return null;

  return (
    <CustomModelDialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('settings.modelManagement.editModel')}
      footer={
        <>
          <button
            className="cancel-btn"
            onClick={onClose}
            disabled={isEditing}
          >
            {t('common.cancel')}
          </button>
          <button
            className="confirm-btn"
            onClick={onEditModel}
            disabled={isEditing}
          >
            {isEditing && <span className="spinner"></span>}
            {isEditing
              ? t('settings.modelManagement.updating')
              : t('settings.modelManagement.update')
            }
          </button>
        </>
      }
    >
      <p className="explanation">
        {t('settings.modelManagement.editModelExplanation', 'Edit the information for this model. Changes will be applied immediately.')}
      </p>

      <div className="form-field">
        <label htmlFor="modelName">{t('settings.modelManagement.modelName')}</label>
        <input
          id="modelName"
          type="text"
          value={form.name}
          onChange={(e) => onFormChange('name', e.target.value)}
          style={{
            borderRadius: '100px',
            height: '36px',
            padding: '0 16px',
            boxSizing: 'border-box'
          }}
          placeholder="Model Name"
        />
      </div>

      <div className="language-codes-section">
        <div className="section-header">
          <span className="material-symbols-rounded" style={{ fontSize: 24 }}>language</span>
          <h5>{t('settings.modelManagement.languageCodes', 'Supported Languages')}</h5>
        </div>
        <div className="helper-text">
          {t('settings.modelManagement.languageCodesHelp', 'Enter the language codes this model supports (e.g., en, fr, zh). Add multiple codes for multilingual models.')}
        </div>

        <LanguageCodeInput
          languageCodes={form.languageCodes || ['']}
          onChange={onLanguageCodesChange}
        />
      </div>

      <div className="form-field">
        <label htmlFor="editConfig">{t('settings.modelManagement.modelConfig')}</label>
        <CustomScrollbarTextarea
          id="editConfig"
          value={form.config}
          onChange={(e) => onFormChange('config', e.target.value)}
          rows={4}
          placeholder='{"sample_rate": 22050, "vocoder": "hifigan"}'
        />
        <div className="helper-text">
          {t('settings.modelManagement.modelConfigHelp')}
        </div>
      </div>

      {/* Display storage information only for symlinked models */}
      {storageInfo && storageInfo.is_symlink && (
        <div className="form-field storage-info">
          <div className="section-header">
            <span className="material-symbols-rounded" style={{ fontSize: 24 }}>link</span>
            <h5>{t('settings.modelManagement.storageInformation')}</h5>
          </div>

          <div className="download-status" style={{ marginBottom: '0.75rem' }}>
            <span className="material-symbols-rounded" aria-hidden="true">info</span>
            <span>{t('settings.modelManagement.usingSymlinks')}</span>
          </div>

          <p className="model-source">
            {t('settings.modelManagement.originalFiles')}:
          </p>
          <ul className="file-list">
            <li>
              {storageInfo.original_model_file}
            </li>
            {storageInfo.original_vocab_file && (
              <li>
                {storageInfo.original_vocab_file}
              </li>
            )}
          </ul>
        </div>
      )}
    </CustomModelDialog>
  );
};

export default EditModelDialog;
