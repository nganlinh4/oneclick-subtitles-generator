import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  deleteModel,
  updateModelInfo,
  getModelStorageInfo,
  cancelModelDownload
} from '../../../services/modelService';
// invalidateModelsCache is imported but not used in this component
// import { invalidateModelsCache } from '../../../services/modelAvailabilityService';
import { showErrorToast, showSuccessToast, showInfoToast } from '../../../utils/toastUtils';
import InstalledModelsList from './InstalledModelsList';
import AvailableModelsList from './AvailableModelsList';
import AddModelDialog from './AddModelDialog';
import EditModelDialog from './EditModelDialog';
import DeleteModelDialog from './DeleteModelDialog';
import { useModels, useDownloads } from './modelManagementHooks';
import { getInitialAddModelForm, getInitialEditModelForm } from './modelManagementUtils';

/**
 * Component for managing narration models
 * @param {string} activeTab - The currently active tab in settings modal
 * @returns {JSX.Element} - Rendered component
 */
const ModelManagementTab = ({ activeTab }) => {
  const { t } = useTranslation();

  // Custom hooks for models and downloads
  const {
    models,
    loading,
    error,
    isScanning,
    modelSizes,
    isServiceAvailable,
    fetchModels,
    scanForModels
  } = useModels();

  // updateDownloads is defined but not used in this component
  const { downloads, setDownloads } = useDownloads(fetchModels);

  // Note: Removed isCheckingAvailability state as dialogs no longer depend on service availability

  // Dialog states
  const [openAddDialog, setOpenAddDialog] = useState(false);
  const [openDeleteDialog, setOpenDeleteDialog] = useState(false);
  const [openEditDialog, setOpenEditDialog] = useState(false);

  // Model states
  const [modelToDelete, setModelToDelete] = useState(null);
  const [modelToEdit, setModelToEdit] = useState(null);
  const [modelStorageInfo, setModelStorageInfo] = useState({});

  // Form states
  const [addModelForm, setAddModelForm] = useState(getInitialAddModelForm());
  const [editModelForm, setEditModelForm] = useState({
    name: '',
    language: '',
    languageCodes: [''],
    config: ''
  });

  // Custom models state (persisted in localStorage)
  const [customModels, setCustomModels] = useState(() => {
    try {
      const saved = localStorage.getItem('customModels');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Loading states
  const [addingModel, setAddingModel] = useState(false);
  const [editingModel, setEditingModel] = useState(false);

  // Show error toast when error occurs
  useEffect(() => {
    if (error) {
      showErrorToast(error);
    }
  }, [error]);

  // Show warning toast when service is unavailable (only when on the model-management tab)
  useEffect(() => {
    if (activeTab !== 'model-management') {
      // Remove toast if switching away from the tab
      if (window.removeToastByKey) {
        window.removeToastByKey('model-service-unavailable');
      }
      return;
    }

    if (!isServiceAvailable) {
      if (window.addToast) {
        window.addToast(
          t('narration.f5ttsUnavailable', '(Service unavailable - Model downloads require F5-TTS service)'),
          'warning',
          999999999, // Very long duration to make it persistent
          'model-service-unavailable'
        );
      }
    } else {
      if (window.removeToastByKey) {
        window.removeToastByKey('model-service-unavailable');
      }
    }
  }, [isServiceAvailable, t, activeTab]);

  // Handle opening add model dialog
  const handleOpenAddDialog = () => {
    setAddModelForm(getInitialAddModelForm());
    setOpenAddDialog(true);
  };

  // Handle closing add model dialog
  const handleCloseAddDialog = () => {
    setOpenAddDialog(false);
  };

  // Handle form input change for add model
  const handleAddFormChange = (name, value) => {
    setAddModelForm(prev => ({
      ...prev,
      [name]: value
    }));
  };

  // Handle source type change
  const handleSourceTypeChange = (e) => {
    setAddModelForm(prev => ({
      ...prev,
      sourceType: e.target.value
    }));
  };

  // Toggle advanced options
  const toggleAdvancedOptions = () => {
    setAddModelForm(prev => ({
      ...prev,
      showAdvanced: !prev.showAdvanced
    }));
  };

  // Handle language codes change for add model
  const handleAddLanguageCodesChange = (languageCodes) => {
    setAddModelForm(prev => ({
      ...prev,
      languageCodes
    }));
  };

  // Handle adding a new model template to available models
  const handleAddModel = async () => {
    try {
      setAddingModel(true);

      // Parse config if provided
      let configObj = {};
      if (addModelForm.config) {
        try {
          configObj = JSON.parse(addModelForm.config);
        } catch (err) {
          throw new Error(t('settings.modelManagement.invalidConfigFormat'));
        }
      }

      // Generate model ID if not provided
      const modelId = addModelForm.modelId ||
        `custom-${addModelForm.modelUrl.split('/').pop().replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`;

      // Create new model template
      const newModelTemplate = {
        id: modelId,
        name: addModelForm.modelId || t('settings.modelManagement.customModel'),
        languages: addModelForm.languageCodes.filter(code => code.trim() !== ''),
        author: t('settings.modelManagement.customAuthor'),
        modelUrl: addModelForm.modelUrl,
        vocabUrl: addModelForm.vocabUrl,
        config: configObj
      };

      // Add to custom models and persist to localStorage
      const updatedCustomModels = [...customModels, newModelTemplate];
      setCustomModels(updatedCustomModels);
      localStorage.setItem('customModels', JSON.stringify(updatedCustomModels));

      // Close dialog
      handleCloseAddDialog();

      // Show success message
      showSuccessToast(t('settings.modelManagement.modelTemplateAdded', 'Model template added successfully! It will appear in Available Models.'));

      // Reset form
      setAddModelForm(getInitialAddModelForm());

    } catch (err) {
      showErrorToast(err.message || t('settings.modelManagement.errorAddingModel'));
    } finally {
      setAddingModel(false);
    }
  };

  // Handle opening delete confirmation dialog
  const handleOpenDeleteDialog = (model) => {
    setModelToDelete(model);
    setOpenDeleteDialog(true);
  };

  // Handle closing delete confirmation dialog
  const handleCloseDeleteDialog = () => {
    setOpenDeleteDialog(false);
    setModelToDelete(null);
  };

  // State for tracking model deletion
  const [isDeletingModel, setIsDeletingModel] = useState(false);

  // Handle deleting a model
  const handleDeleteModel = async () => {
    if (!modelToDelete) return;

    try {
      setIsDeletingModel(true);
      await deleteModel(modelToDelete.id, true); // Always delete from cache without asking

      // Close dialog and refresh models
      handleCloseDeleteDialog();
      await fetchModels();

      // Show success message
      showSuccessToast(t('settings.modelManagement.modelDeletedSuccess'));
    } catch (err) {
      showErrorToast(err.message || t('settings.modelManagement.errorDeletingModel'));
    } finally {
      setIsDeletingModel(false);
    }
  };

  // Handle opening edit dialog
  const handleOpenEditDialog = async (model) => {
    setModelToEdit(model);
    setEditModelForm(getInitialEditModelForm(model));

    // Fetch storage information for this model
    try {
      const storageInfo = await getModelStorageInfo(model.id);
      setModelStorageInfo(prevState => ({
        ...prevState,
        [model.id]: storageInfo
      }));
    } catch (error) {
      console.error('Error fetching model storage info:', error);
    }

    setOpenEditDialog(true);
  };

  // Handle closing edit dialog
  const handleCloseEditDialog = () => {
    setOpenEditDialog(false);
    setModelToEdit(null);
  };

  // Handle form input change for edit model
  const handleEditFormChange = (name, value) => {
    setEditModelForm(prev => ({
      ...prev,
      [name]: value
    }));
  };

  // Handle language codes change for edit model
  const handleEditLanguageCodesChange = (languageCodes) => {
    setEditModelForm(prev => ({
      ...prev,
      languageCodes
    }));
  };

  // Handle editing a model
  const handleEditModel = async () => {
    if (!modelToEdit) return;

    try {
      setEditingModel(true);

      // Parse config if provided
      let configObj = {};
      if (editModelForm.config) {
        try {
          configObj = JSON.parse(editModelForm.config);
        } catch (err) {
          throw new Error(t('settings.modelManagement.invalidConfigFormat'));
        }
      }

      // Ensure languageCodes is an array
      const languageCodes = Array.isArray(editModelForm.languageCodes) ? editModelForm.languageCodes : [''];

      // Prepare model data
      const modelInfo = {
        name: editModelForm.name,
        language: languageCodes[0] || '', // Set primary language to first language code
        languages: languageCodes.filter(code => code.trim() !== ''), // Include all language codes
        config: configObj
      };

      // Update model
      await updateModelInfo(modelToEdit.id, modelInfo);

      // Close dialog and refresh models
      handleCloseEditDialog();
      await fetchModels();

      // Show success message
      showSuccessToast(t('settings.modelManagement.modelUpdatedSuccess'));
    } catch (err) {
      showErrorToast(err.message || t('settings.modelManagement.errorUpdatingModel'));
    } finally {
      setEditingModel(false);
    }
  };

  // Handle cancelling a model download
  const handleCancelDownload = async (modelId) => {
    try {
      // Call API to cancel download
      const response = await cancelModelDownload(modelId);

      if (response.success) {


        // Update downloads state to remove the cancelled download
        setDownloads(prev => {
          const newDownloads = { ...prev };
          delete newDownloads[modelId];
          return newDownloads;
        });

        // Show success message
        showInfoToast(t('settings.modelManagement.downloadCancelled', 'Download cancelled successfully'));

        // Refresh models to update the UI
        await fetchModels();
      }
    } catch (err) {
      console.error('Error cancelling model download:', err);
      showErrorToast(err.message || t('settings.modelManagement.errorCancellingDownload', 'Error cancelling download'));
    }
  };


  // Create a style for the unavailable content (only for actual downloads, not modal access)
  const unavailableContentStyle = !isServiceAvailable ? {
    opacity: 0.38,
    pointerEvents: 'none',
    userSelect: 'none',
    cursor: 'not-allowed'
  } : {};

  return (
    <div className="model-management-section" id="model-management">
      <div style={unavailableContentStyle}>
        <p className="model-management-description">
          {t('settings.modelManagement.description')}
        </p>


        {/* Available Models List */}
        <AvailableModelsList
          onModelAdded={fetchModels}
          downloads={downloads}
          setDownloads={setDownloads}
          installedModels={models}
          onAddModelClick={handleOpenAddDialog}
          customModels={customModels}
          setCustomModels={setCustomModels}
        />

        <hr style={{ margin: '2rem 0', border: 'none', borderTop: '1px solid var(--border-color)' }} />

        {/* Installed Models List */}
        <InstalledModelsList
          models={models}
          modelSizes={modelSizes}
          downloads={downloads}
          loading={loading}
          isScanning={isScanning}
          onScan={scanForModels}
          onEdit={handleOpenEditDialog}
          onDelete={handleOpenDeleteDialog}
          onCancelDownload={handleCancelDownload}
        />
      </div>

      {/* Add Model Dialog */}
      <AddModelDialog
        isOpen={openAddDialog}
        onClose={handleCloseAddDialog}
        form={addModelForm}
        onFormChange={handleAddFormChange}
        onSourceTypeChange={handleSourceTypeChange}
        onToggleAdvanced={toggleAdvancedOptions}
        onLanguageCodesChange={handleAddLanguageCodesChange}
        onAddModel={handleAddModel}
        isAdding={addingModel}
      />

      {/* Delete Confirmation Dialog */}
      <DeleteModelDialog
        isOpen={openDeleteDialog}
        onClose={handleCloseDeleteDialog}
        model={modelToDelete}
        onDelete={handleDeleteModel}
        isDeleting={isDeletingModel}
      />

      {/* Edit Model Dialog */}
      <EditModelDialog
        isOpen={openEditDialog}
        onClose={handleCloseEditDialog}
        model={modelToEdit}
        form={editModelForm}
        onFormChange={handleEditFormChange}
        onLanguageCodesChange={handleEditLanguageCodesChange}
        onEditModel={handleEditModel}
        isEditing={editingModel}
        storageInfo={modelToEdit ? modelStorageInfo[modelToEdit.id] : null}
      />

    </div>
  );
};

export default ModelManagementTab;
