import React from 'react';
import { useTranslation } from 'react-i18next';
import CustomModelDialog from '../CustomModelDialog';
import LanguageCodeInput from './LanguageCodeInput';

/**
 * Component for adding a new model
 * @param {Object} props - Component props
 * @param {boolean} props.isOpen - Whether the dialog is open
 * @param {Function} props.onClose - Function to call when dialog is closed
 * @param {Object} props.form - Form state
 * @param {Function} props.onFormChange - Function to call when form changes
 * @param {Function} props.onSourceTypeChange - Function to call when source type changes
 * @param {Function} props.onToggleAdvanced - Function to call when advanced options are toggled
 * @param {Function} props.onLanguageCodesChange - Function to call when language codes change
 * @param {Function} props.onAddModel - Function to call when add button is clicked
 * @param {boolean} props.isAdding - Whether a model is being added
 * @returns {JSX.Element} - Rendered component
 */
const AddModelDialog = ({
  isOpen,
  onClose,
  form,
  onFormChange,
  onSourceTypeChange,
  onToggleAdvanced,
  onLanguageCodesChange,
  onAddModel,
  isAdding
}) => {
  const { t } = useTranslation();

  // Handle form input change
  const handleFormChange = (e) => {
    const { name, value } = e.target;
    onFormChange(name, value);
  };

  return (
    <CustomModelDialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('settings.modelManagement.addNewCustomModel')}
      footer={
        <>
          <button
            className="cancel-btn"
            onClick={onClose}
            disabled={isAdding}
          >
            {t('common.cancel')}
          </button>
          <button
            className="confirm-btn"
            onClick={onAddModel}
            disabled={!form.modelUrl || isAdding}
          >
            {isAdding && <span className="spinner"></span>}
            {isAdding
              ? t('settings.modelManagement.addingCustomModel')
              : t('settings.modelManagement.addCustomModel')
            }
          </button>
        </>
      }
    >
      <p className="explanation">
        {t('settings.modelManagement.addModelExplanation', 'Add a custom TTS model from Hugging Face or a direct URL. The model will be downloaded and made available for narration.')}
      </p>

      <div className="form-field">
        <label>{t('settings.modelManagement.modelSource')}</label>
        <div className="radio-group-base radio-group-horizontal">
          <div className="radio-option-base">
            <input
              type="radio"
              id="source-huggingface"
              name="sourceType"
              value="huggingface"
              checked={form.sourceType === 'huggingface'}
              onChange={onSourceTypeChange}
            />
            <label htmlFor="source-huggingface" className="radio-option-minimal">
              {t('settings.modelManagement.huggingFace')}
            </label>
          </div>
          <div className="radio-option-base">
            <input
              type="radio"
              id="source-url"
              name="sourceType"
              value="url"
              checked={form.sourceType === 'url'}
              onChange={onSourceTypeChange}
            />
            <label htmlFor="source-url" className="radio-option-minimal">
              {t('settings.modelManagement.directUrl')}
            </label>
          </div>
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="modelUrl">
          {form.sourceType === 'huggingface'
            ? t('settings.modelManagement.huggingFaceModelUrl')
            : t('settings.modelManagement.directModelUrl')}
        </label>
        <input
          id="modelUrl"
          name="modelUrl"
          type="text"
          value={form.modelUrl}
          onChange={handleFormChange}
          style={{
            borderRadius: '100px',
            height: '36px',
            padding: '0 16px',
            boxSizing: 'border-box'
          }}
          placeholder={form.sourceType === 'huggingface'
            ? "https://huggingface.co/erax-ai/EraX-Smile-UnixSex-F5/blob/main/models/model_42000.safetensors"
            : "https://example.com/model.bin"}
        />
        <div className="helper-text">
          {form.sourceType === 'huggingface'
            ? t('settings.modelManagement.huggingFaceModelUrlHelp')
            : t('settings.modelManagement.directModelUrlHelp')}
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="vocabUrl">
          {form.sourceType === 'huggingface'
            ? t('settings.modelManagement.huggingFaceVocabUrl')
            : t('settings.modelManagement.directVocabUrl')}
        </label>
        <input
          id="vocabUrl"
          name="vocabUrl"
          type="text"
          value={form.vocabUrl}
          onChange={handleFormChange}
          style={{
            borderRadius: '100px',
            height: '36px',
            padding: '0 16px',
            boxSizing: 'border-box'
          }}
          placeholder={form.sourceType === 'huggingface'
            ? "https://huggingface.co/erax-ai/EraX-Smile-UnixSex-F5/blob/main/models/vocab.txt"
            : "https://example.com/vocab.json"}
        />
        <div className="helper-text">
          {form.sourceType === 'huggingface'
            ? t('settings.modelManagement.huggingFaceVocabUrlHelp')
            : t('settings.modelManagement.directVocabUrlHelp')}
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="modelId">{t('settings.modelManagement.modelId')}</label>
        <input
          id="modelId"
          name="modelId"
          type="text"
          value={form.modelId}
          onChange={handleFormChange}
          style={{
            borderRadius: '100px',
            height: '36px',
            padding: '0 16px',
            boxSizing: 'border-box'
          }}
          placeholder="my-custom-tts-model"
        />
        <div className="helper-text">
          {t('settings.modelManagement.modelIdHelp')}
        </div>
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
          languageCodes={form.languageCodes}
          onChange={onLanguageCodesChange}
        />
      </div>

      <button
        className="advanced-options-toggle"
        onClick={onToggleAdvanced}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 20, marginRight: '8px' }}>tune</span>
        {form.showAdvanced
          ? t('settings.modelManagement.hideAdvancedOptions')
          : t('settings.modelManagement.showAdvancedOptions')
        }
        {form.showAdvanced
          ? <span className="material-symbols-rounded" style={{ fontSize: 20, marginLeft: '4px' }}>keyboard_arrow_up</span>
          : <span className="material-symbols-rounded" style={{ fontSize: 20, marginLeft: '4px' }}>keyboard_arrow_down</span>
        }
      </button>

      {form.showAdvanced && (
        <div className="form-field">
          <label htmlFor="config">{t('settings.modelManagement.modelConfig')}</label>
          <textarea
            id="config"
            name="config"
            value={form.config}
            onChange={handleFormChange}
            rows={4}
            placeholder='{"sample_rate": 22050, "vocoder": "hifigan"}'
          />
          <div className="helper-text">
            {t('settings.modelManagement.modelConfigHelp')}
          </div>
        </div>
      )}
    </CustomModelDialog>
  );
};

export default AddModelDialog;
