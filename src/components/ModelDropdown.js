import { useTranslation } from 'react-i18next';
import CustomDropdown from './common/CustomDropdown';
import {
  DEFAULT_GEMINI_MODEL_ID,
  DOCUMENT_MODELS,
  TRANSLATION_MODELS,
  buildGeminiModelOption,
  normalizeCustomGeminiModels,
  sortModelsForDisplay,
} from '../config/geminiModels';
import { usePreference } from '../platform/preferences/store';


/** Model data adapter only; all menu layout and interaction belongs to CustomDropdown. */
const ModelDropdown = ({
  onModelSelect,
  selectedModel = DEFAULT_GEMINI_MODEL_ID,
  buttonClassName = '',
  headerText,
  isTranslationSection = false,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [storedCustomModels] = usePreference('custom_gemini_models');
  const customModels = normalizeCustomGeminiModels(storedCustomModels);

  const models = isTranslationSection ? TRANSLATION_MODELS : DOCUMENT_MODELS;
  const options = sortModelsForDisplay([...models, ...customModels])
    .map((model) => buildGeminiModelOption(model, t));

  return (
    <CustomDropdown
      value={selectedModel}
      onChange={onModelSelect}
      options={options}
      className={buttonClassName}
      ariaLabel={headerText || t('common.selectModel', 'Select model')}
      placeholder={selectedModel}
      disabled={disabled}
    />
  );
};

export default ModelDropdown;
