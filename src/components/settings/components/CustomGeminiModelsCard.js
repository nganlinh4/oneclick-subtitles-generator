import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
    if (!newModelId.trim()) return;

    // Check if model ID already exists
    if (customGeminiModels.some(model => model.id === newModelId.trim())) {
      alert(t('settings.customModels.modelExists', 'A model with this ID already exists'));
      return;
    }

    const newModel = {
      id: newModelId.trim(),
      name: newModelName.trim() || newModelId.trim(),
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
    if (!newModelId.trim()) return;

    // Check if new ID conflicts with existing models (excluding the one being edited)
    if (customGeminiModels.some(model => model.id === newModelId.trim() && model.id !== editingModelId)) {
      alert(t('settings.customModels.modelExists', 'A model with this ID already exists'));
      return;
    }

    const updatedModels = customGeminiModels.map(model => 
      model.id === editingModelId 
        ? { ...model, id: newModelId.trim(), name: newModelName.trim() || newModelId.trim() }
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
    if (window.confirm(t('settings.customModels.confirmDelete', 'Are you sure you want to delete this custom model?'))) {
      const updatedModels = customGeminiModels.filter(model => model.id !== modelId);
      setCustomGeminiModels(updatedModels);
      localStorage.setItem('custom_gemini_models', JSON.stringify(updatedModels));
    }
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
          {t('settings.customGeminiModels.description', 'Add custom Gemini model IDs to use in dropdowns throughout the application. These models will appear in all model selection menus.')}
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
                  placeholder={t('settings.customModels.modelIdPlaceholder', 'e.g., gemini-2.5-pro-preview-03-25')}
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
                  placeholder={t('settings.customModels.modelNamePlaceholder', 'e.g., Gemini 2.5 Pro Preview')}
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
