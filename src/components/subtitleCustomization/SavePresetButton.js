import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { addCustomSubtitlePreset, hasCustomizationChanged } from '../../utils/subtitlePresetUtils';
import PresetNamingModal from './PresetNamingModal';

const SavePresetButton = ({ customization, onChange, predefinedPresets, setCustomPresets }) => {
  const { t } = useTranslation();
  const [isSaving, setIsSaving] = useState(false);
  const [showNamingModal, setShowNamingModal] = useState(false);

  const hasChanges = useMemo(() => {
    return hasCustomizationChanged(customization, predefinedPresets);
  }, [customization, predefinedPresets]);

  const handleSavePreset = () => {
    if (!hasChanges || isSaving) return;
    setShowNamingModal(true);
  };

  const handleModalSave = async (presetName) => {
    setIsSaving(true);

    try {
      const updatedPresets = addCustomSubtitlePreset({
        name: presetName,
        customization: { ...customization }
      });

      // Update the parent component's custom presets state
      setCustomPresets(updatedPresets);

      // Update the customization to reflect the new preset
      onChange({ ...customization, preset: updatedPresets[updatedPresets.length - 1].id });
    } catch (error) {
      console.error('Error saving custom preset:', error);
      alert(t('presetButtons.saveError', 'Failed to save custom preset.'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <button
        className={`pill-button ${hasChanges ? 'primary' : 'disabled'} save-preset-button`}
        onClick={handleSavePreset}
        disabled={!hasChanges || isSaving}
        title={hasChanges
          ? t('presetButtons.saveCurrentAsPreset', 'Save current settings as custom preset')
          : t('presetButtons.noChanges', 'No changes to save')
        }
      >
        <span className="material-symbols-rounded" style={{ fontSize: 16, marginRight: '4px' }}>
          {isSaving ? 'sync' : 'save'}
        </span>
        {isSaving
          ? t('presetButtons.saving', 'Saving...')
          : t('presetButtons.saveAsPreset', 'Save as Preset')
        }
      </button>

      <PresetNamingModal
        isOpen={showNamingModal}
        onClose={() => setShowNamingModal(false)}
        onSave={handleModalSave}
        currentCustomization={customization}
      />
    </>
  );
};

export default SavePresetButton;