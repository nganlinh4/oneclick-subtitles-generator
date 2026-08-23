import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { normalizeCustomGeminiModelId } from '../../../config/geminiModels';
import {
  showConfirmationToast,
  showWarningToast,
} from '../../../utils/toastUtils';
import '../../../styles/settings/customGeminiModels.css';

/**
 * Component for managing custom Gemini model IDs
 * @param {Object} props - Component props
 * @param {Array} props.customGeminiModels - Array of custom model objects
 * @param {Function} props.setCustomGeminiModels - Function to update custom models
 * @returns {JSX.Element} - Rendered component
 */
const CustomGeminiModelsCard = ({ customGeminiModels, setCustomGeminiModels }) => {
  const { t } = useTranslation();
  const [isAddingModel, setIsAddingModel] = useState(false);
  const [editingModelId, setEditingModelId] = useState(null);
  const [newModelId, setNewModelId] = useState('');
  const [newModelName, setNewModelName] = useState('');

  // Handle adding a new custom model
  const handleAddModel = () => {
    const normalizedId = normalizeCustomGeminiModelId(newModelId);
    if (!normalizedId) {
      showWarningToast(t('settings.customModels.invalidModelId', 'Enter a Gemini model ID such as gemini-3.8-flash'));
      return;
    }

    // Check if model ID already exists
    if (customGeminiModels.some(model => model.id === normalizedId)) {
      showWarningToast(t('settings.customModels.modelExists', 'A model with this ID already exists'));
      return;
    }

    const newModel = {
      id: normalizedId,
      name: newModelName.trim() || normalizedId,
      isCustom: true
    };

    const updatedModels = [...customGeminiModels, newModel];
    setCustomGeminiModels(updatedModels);
    localStorage.setItem('custom_gemini_models', JSON.stringify(updatedModels));

    // Reset form
    setNewModelId('');
    setNewModelName('');
    setIsAddingModel(false);
  };

  // Handle editing a model
  const handleEditModel = (modelId) => {
    const model = customGeminiModels.find(m => m.id === modelId);
    if (model) {
      setNewModelId(model.id);
      setNewModelName(model.name);
      setEditingModelId(modelId);
      setIsAddingModel(true);
    }
  };

  // Handle updating an existing model
  const handleUpdateModel = () => {
    const normalizedId = normalizeCustomGeminiModelId(newModelId);
    if (!normalizedId) {
      showWarningToast(t('settings.customModels.invalidModelId', 'Enter a Gemini model ID such as gemini-3.8-flash'));
      return;
    }

    // Check if new ID conflicts with existing models (excluding the one being edited)
    if (customGeminiModels.some(model => model.id === normalizedId && model.id !== editingModelId)) {
      showWarningToast(t('settings.customModels.modelExists', 'A model with this ID already exists'));
      return;
    }

    const updatedModels = customGeminiModels.map(model => 
      model.id === editingModelId 
        ? { ...model, id: normalizedId, name: newModelName.trim() || normalizedId }
        : model
    );

    setCustomGeminiModels(updatedModels);
    localStorage.setItem('custom_gemini_models', JSON.stringify(updatedModels));

    // Reset form
    setNewModelId('');
    setNewModelName('');
    setIsAddingModel(false);
    setEditingModelId(null);
  };

  // Handle deleting a model
  const handleDeleteModel = (modelId) => {
    showConfirmationToast({
      message: t('settings.customModels.confirmDelete', 'Are you sure you want to delete this custom model?'),
      confirmText: t('common.confirm', 'Confirm'),
      key: `custom-model-delete:${modelId}`,
      onConfirm: () => setCustomGeminiModels((currentModels) => {
        const updatedModels = currentModels.filter((model) => model.id !== modelId);
        localStorage.setItem('custom_gemini_models', JSON.stringify(updatedModels));
        return updatedModels;
      }),
    });
  };

  // Handle canceling add/edit
  const handleCancel = () => {
    setNewModelId('');
    setNewModelName('');
    setIsAddingModel(false);
    setEditingModelId(null);
  };

  return (
    <div className="settings-card custom-gemini-models-card">
      <div className="settings-card-header">
        <div className="settings-card-icon">
          <span className="material-symbols-rounded" style={{ fontSize: 20 }}>memory</span>
        </div>
        <h4>{t('settings.customGeminiModels.title', 'Custom Gemini Models')}</h4>
      </div>
      <div className="settings-card-content">
        <p className="setting-description">
          {t('settings.customGeminiModels.description', 'Add custom Gemini model IDs for text-only tools such as translation and document processing. Audio and video workflows use catalog-verified media models only.')}
        </p>

        {/* Custom models list */}
        {customGeminiModels.length > 0 && (
          <div className="custom-models-list">
            {customGeminiModels.map((model) => (
              <div key={model.id} className="custom-model-item">
                <div className="custom-model-info">
                  <div className="custom-model-name">{model.name}</div>
                  <div className="custom-model-id">{model.id}</div>
                </div>
                <div className="custom-model-actions">
                  <button
                    className="edit-model-btn"
                    onClick={() => handleEditModel(model.id)}
                    title={t('settings.customModels.edit', 'Edit model')}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>edit</span>
                  </button>
                  <button
                    className="delete-model-btn"
                    onClick={() => handleDeleteModel(model.id)}
                    title={t('settings.customModels.delete', 'Delete model')}
                  >
                    <span className="material-symbols-rounded" style={{ fontSize: 14 }}>delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add/Edit form */}
        {isAddingModel ? (
          <div className="add-model-form">
            <div className="form-row">
              <div className="form-field">
                <label htmlFor="model-id">
                  {t('settings.customModels.modelId', 'Model ID')} *
                </label>
                <input
                  id="model-id"
                  type="text"
                  value={newModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                  placeholder={t('settings.customModels.modelIdPlaceholder', 'e.g., gemini-3.8-flash')}
                  className="model-input"
                />
              </div>
              <div className="form-field">
                <label htmlFor="model-name">
                  {t('settings.customModels.modelName', 'Display Name')}
                </label>
                <input
                  id="model-name"
                  type="text"
                  value={newModelName}
                  onChange={(e) => setNewModelName(e.target.value)}
                  placeholder={t('settings.customModels.modelNamePlaceholder', 'e.g., My Gemini model')}
                  className="model-input"
                />
              </div>
            </div>
            <div className="form-actions">
              <button
                className="save-model-btn"
                onClick={editingModelId ? handleUpdateModel : handleAddModel}
                disabled={!newModelId.trim()}
              >
                {editingModelId 
                  ? t('settings.customModels.update', 'Update Model')
                  : t('settings.customModels.add', 'Add Model')
                }
              </button>
              <button
                className="cancel-model-btn"
                onClick={handleCancel}
              >
                {t('common.cancel', 'Cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            className="add-model-button"
            onClick={() => setIsAddingModel(true)}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16 }}>add</span>
            {t('settings.customModels.addNew', 'Add Custom Model')}
          </button>
        )}
      </div>
    </div>
  );
};

export default CustomGeminiModelsCard;
