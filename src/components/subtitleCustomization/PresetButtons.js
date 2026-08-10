import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { getCustomSubtitlePresets, deleteCustomSubtitlePreset, hasCustomizationChanged, addCustomSubtitlePreset } from '../../utils/subtitlePresetUtils';
import PresetNamingModal from './PresetNamingModal';
import PresetButtonsGrid from './PresetButtonsGrid';
import { presets } from './presetDefinitions';
import { resolvePreset, resolveCustomPreset, buildSavePayload } from './customPresetHandlers';

const PresetButtons = ({ customization, onChange }) => {
  const { t } = useTranslation();
  const [customPresets, setCustomPresets] = useState([]);
  const [showNamingModal, setShowNamingModal] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setCustomPresets(getCustomSubtitlePresets());
  }, []);

  const hasChanges = useMemo(() => {
    return hasCustomizationChanged(customization, presets);
  }, [customization]);

  const applyPreset = (preset) => {
    onChange(resolvePreset(preset));
  };

  const applyCustomPreset = (customPreset) => {
    onChange(resolveCustomPreset(customPreset));
  };

  const handleDeleteCustomPreset = (presetId) => {
    const updated = deleteCustomSubtitlePreset(presetId);
    setCustomPresets(updated);
  };

  const handleSavePreset = () => {
    if (!hasChanges || isSaving) return;
    setShowNamingModal(true);
  };

  const handleModalSave = async (presetName) => {
    setIsSaving(true);

    try {
      const updatedPresets = addCustomSubtitlePreset(buildSavePayload(presetName, customization));

      // Update the parent component's custom presets state
      setCustomPresets(updatedPresets);

      // Update the customization to reflect the new preset
      onChange({ ...customization, preset: updatedPresets[updatedPresets.length - 1].id });
    } catch (error) {
      console.error('Error saving custom preset:', error);
      alert(t('subtitleSettings.presetButtons.saveError', 'Failed to save custom preset.'));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="customization-row preset-row">
      <PresetButtonsGrid
        customization={customization}
        customPresets={customPresets}
        hasChanges={hasChanges}
        isSaving={isSaving}
        onApplyPreset={applyPreset}
        onApplyCustomPreset={applyCustomPreset}
        onDeleteCustomPreset={handleDeleteCustomPreset}
        onSavePreset={handleSavePreset}
        t={t}
      />

      {/* Preset naming modal */}
      <PresetNamingModal
        isOpen={showNamingModal}
        onClose={() => setShowNamingModal(false)}
        onSave={handleModalSave}
      />

    </div>
  );
};

export default PresetButtons;
