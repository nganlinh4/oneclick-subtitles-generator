import { useTranslation } from 'react-i18next';
import CustomDropdown from '../common/CustomDropdown';
import { PROMPT_PRESETS } from '../../services/geminiService';
import { getPresetIconComponent, getPresetTitle } from './presetIconMap';

/**
 * The prompt-preset dropdown section of the transcription rules editor.
 * Owns its own change handler, which persists the selection to localStorage
 * and notifies the parent via `onChangePrompt`.
 */
const PresetSelector = ({
  currentPresetId,
  setCurrentPresetId,
  allPresets,
  userPromptPresets,
  onChangePrompt,
  handleUserInteraction
}) => {
  const { t } = useTranslation();

  // Handle changing the prompt preset
  const handleChangePrompt = (e) => {
    handleUserInteraction();
    const newPresetId = e.target.value;
    setCurrentPresetId(newPresetId);

    // SIMPLE: Just save to localStorage directly
    if (newPresetId === 'custom') {
      // Custom means use settings prompt
      localStorage.setItem('video_processing_prompt_preset', 'settings');
      console.log('[TranscriptionRulesEditor] User selected settings prompt');

      if (onChangePrompt) {
        onChangePrompt({ id: 'custom' });
      }
    } else {
      // Save the selected preset
      localStorage.setItem('video_processing_prompt_preset', newPresetId);
      console.log('[TranscriptionRulesEditor] User selected preset:', newPresetId);

      // Find the preset and notify parent
      const preset = allPresets.find(p => p.id === newPresetId);
      if (preset && onChangePrompt) {
        onChangePrompt(preset);
      }
    }
  };

  return (
    <div className="prompt-preset-selector">
      <div className="prompt-preset-label">
        {t('rulesEditor.currentPrompt', 'Current Prompt Preset')}:
      </div>
      <div className="prompt-preset-dropdown">
        <CustomDropdown
          value={currentPresetId}
          onChange={(value) => handleChangePrompt({ target: { value } })}
          onClick={handleUserInteraction}
          style={{ maxWidth: '215px' }}
          options={[
            // Prompt from settings option with sliders/settings icon
            {
              value: 'custom',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <span
                    className="material-symbols-rounded"
                    style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '6px', fontSize: 16 }}
                    aria-hidden="true"
                  >
                    settings
                  </span>
                  {t('settings.promptFromSettings', 'Prompt from settings')}
                </span>
              )
            },

            // Built-in presets with unique SVG icons
            ...PROMPT_PRESETS.map(preset => {
              // Create unique SVG icon for each preset as React element
              const IconComponent = getPresetIconComponent(preset);

              return {
                value: preset.id,
                label: (
                  <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                    {IconComponent && <IconComponent />}
                    {getPresetTitle(preset.id, allPresets, t)}
                  </span>
                )
              };
            }),
            // User presets with user icon
            ...userPromptPresets.map(preset => ({
              value: preset.id,
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <span
                    className="material-symbols-rounded"
                    style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '6px', fontSize: 16 }}
                    aria-hidden="true"
                  >
                    person
                  </span>
                  {preset.title}
                </span>
              )
            }))
          ]}
          placeholder={t('settings.selectPreset', 'Select Preset')}
        />
      </div>
    </div>
  );
};

export default PresetSelector;
