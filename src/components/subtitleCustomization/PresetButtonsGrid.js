import { presets, presetOrder } from './presetDefinitions';

// Pure render of the preset buttons grid: predefined presets, custom presets,
// and the save-preset button. Props only — no internal state.
const PresetButtonsGrid = ({
  customization,
  customPresets,
  hasChanges,
  isSaving,
  onApplyPreset,
  onApplyCustomPreset,
  onDeleteCustomPreset,
  onSavePreset,
  t
}) => {
  return (
    <div className="preset-buttons">
      {/* Predefined preset buttons */}
      {presetOrder.map(preset => (
        <button
          key={preset}
          className={`pill-button ${customization.preset === preset ? 'primary' : 'secondary'}`}
          onClick={() => onApplyPreset(preset)}
          style={{ fontFamily: presets[preset].fontFamily }}
        >
          {preset.charAt(0).toUpperCase() + preset.slice(1)}
        </button>
      ))}

      {/* Custom preset buttons */}
      {customPresets.map(customPreset => (
        <div key={customPreset.id} className="custom-preset-button-container">
          <button
            className={`pill-button custom-preset-button ${customization.preset === customPreset.id ? 'primary' : 'secondary'}`}
            onClick={() => onApplyCustomPreset(customPreset)}
            title={customPreset.name}
            style={{ fontFamily: customPreset.customization.fontFamily }}
          >
            {customPreset.name}
          </button>
          <button
            className="custom-preset-delete-button pc-clear"
            onClick={() => onDeleteCustomPreset(customPreset.id)}
            title="Delete preset"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentColor">
              <path d="m480-384-67 66q-20 20-47.5 20.5T318-318q-20-20-20-48t20-47l66-67-67-67q-20-20-20-47.5t21-47.5q20-20 47.5-20t47.5 20l67 66 67-66q20-20 47.5-20t47.5 20q20 19 20 47t-20 48l-66 67 66 67q20 20 20 47.5T642-318q-19 19-47 19t-48-19l-67-66Z"/>
            </svg>
          </button>
        </div>
      ))}

      {/* Save preset button */}
      <button
        className={`pill-button save-preset-button ${hasChanges ? 'primary' : 'secondary'}`}
        onClick={onSavePreset}
        disabled={!hasChanges || isSaving}
        title={hasChanges ? t('subtitleSettings.presetButtons.saveCurrentSettings', 'Save current settings as preset') : t('subtitleSettings.presetButtons.noChangesToSave', 'No changes to save')}
      >
        <span className="material-symbols-rounded" style={{ fontSize: 16 }}>save</span>
        {t('subtitleSettings.presetButtons.savePreset', 'Save Preset')}
      </button>
    </div>
  );
};

export default PresetButtonsGrid;
