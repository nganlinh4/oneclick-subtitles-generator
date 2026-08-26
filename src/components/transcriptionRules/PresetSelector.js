import { useTranslation } from 'react-i18next';
import CustomDropdown from '../common/CustomDropdown';
import { PROMPT_PRESETS } from '../../services/geminiService';
import {
  applyTranscriptionPromptPresetSelection,
  normalizeUserTranscriptionPromptPresets,
} from '../../services/gemini/transcriptionPromptPresetSelection';
import { getPresetIconComponent, getPresetTitle } from './presetIconMap';

/**
 * The prompt-preset dropdown section of the transcription rules editor.
 * Owns the single normalized preset-selection boundary and notifies the parent
 * with the resolved selection. The Settings-owned transcription prompt is not
 * copied or overwritten when the source changes.
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
  const usableUserPresets = normalizeUserTranscriptionPromptPresets(
    userPromptPresets,
    PROMPT_PRESETS.map(({ id }) => id),
  );

  // Handle changing the prompt preset
  const handleChangePrompt = (e) => {
    handleUserInteraction();
    const newPresetId = e.target.value;
    const selection = applyTranscriptionPromptPresetSelection({
      requestedPresetId: newPresetId,
      availablePresets: allPresets,
      defaultPrompt: PROMPT_PRESETS[0]?.prompt,
    });
    setCurrentPresetId(selection.editorPresetId);
    onChangePrompt?.(selection);
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
            ...usableUserPresets.map(preset => ({
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
