import { useTranslation } from 'react-i18next';
import ModelDropdown from '../ModelDropdown';

/**
 * Model selection component
 * @param {Object} props - Component props
 * @param {string} props.selectedModel - Currently selected model
 * @param {Function} props.onModelSelect - Function to handle model selection
 * @param {boolean} props.disabled - Whether the model selection is disabled
 * @returns {JSX.Element} - Rendered component
 */
const ModelSelection = ({ selectedModel, onModelSelect, disabled = false }) => {
  const { t } = useTranslation();

  return (
    <div className="translation-row model-row">
      <div className="row-label">
        <label>{t('translation.modelSelection', 'Model')}:</label>
      </div>
      <div className="row-content">
        <ModelDropdown
          onModelSelect={onModelSelect}
          selectedModel={selectedModel}
          buttonClassName="translate-model-dropdown"
          headerText={t('translation.selectModel', 'Select model for translation')}
          isTranslationSection={true}
          disabled={disabled}
        />
      </div>
    </div>
  );
};

export default ModelSelection;
