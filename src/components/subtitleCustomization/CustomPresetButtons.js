import React from 'react';
import { useTranslation } from 'react-i18next';
import { deleteCustomSubtitlePreset } from '../../utils/subtitlePresetUtils';

const CustomPresetButtons = ({ customization, onChange, customPresets, setCustomPresets }) => {
  const { t } = useTranslation();

  const applyCustomPreset = (preset) => {
    onChange({ ...preset.customization, preset: preset.id });
  };

  const handleDeletePreset = (presetId) => {
    const updatedPresets = deleteCustomSubtitlePreset(presetId);
    setCustomPresets(updatedPresets);
  };

  if (customPresets.length === 0) {
    return null;
  }

  return (
    <div className="custom-preset-buttons">
      {customPresets.map(preset => (
        <div key={preset.id} className="custom-preset-button-container">
          <button
            className={`pill-button secondary custom-preset-button ${customization.preset === preset.id ? 'primary' : ''}`}
            onClick={() => applyCustomPreset(preset)}
            title={preset.name}
          >
            <span className="material-symbols-rounded" style={{ fontSize: 16, marginRight: '4px' }}>person</span>
            {preset.name}
          </button>
          <button
            className="custom-preset-delete-button"
            onClick={() => handleDeletePreset(preset.id)}
            title={t('presetButtons.deleteCustomPreset', 'Delete custom preset')}
          >
            <span className="material-symbols-rounded">close</span>
          </button>
        </div>
      ))}
    </div>
  );
};

export default CustomPresetButtons;