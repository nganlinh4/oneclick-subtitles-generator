import { normalizeTranscriptionPrompt } from './transcriptionPromptInvariant';

export const SETTINGS_PROMPT_PRESET_ID = 'settings';
export const CUSTOM_PROMPT_PRESET_ID = 'custom';

const invalidPreset = () => {
  const error = new Error('The selected transcription prompt preset is invalid.');
  error.code = 'invalidTranscriptionPromptPreset';
  return error;
};

const readStorage = (storage, key) => {
  if (!storage || typeof storage.getItem !== 'function') return null;
  return storage.getItem(key);
};

export const isUsableTranscriptionPromptPreset = (preset) => (
  preset !== null
  && typeof preset === 'object'
  && typeof preset.id === 'string'
  && preset.id.trim().length > 0
  && preset.id !== CUSTOM_PROMPT_PRESET_ID
  && preset.id !== SETTINGS_PROMPT_PRESET_ID
  && typeof preset.prompt === 'string'
  && preset.prompt.trim().length > 0
);

export const normalizeUserTranscriptionPromptPresets = (
  presets,
  reservedPresetIds = [],
) => {
  const seen = new Set(reservedPresetIds);
  if (!Array.isArray(presets)) return [];
  return presets.filter((preset) => {
    if (!isUsableTranscriptionPromptPreset(preset) || seen.has(preset.id)) return false;
    seen.add(preset.id);
    return true;
  });
};

/**
 * Resolve a rules-editor selection without treating its derived prompt as a
 * second settings value. `transcription_prompt` remains owned by Settings and
 * its native SQLite transaction; presets only select another prompt source.
 */
export const resolveTranscriptionPromptPresetSelection = ({
  requestedPresetId,
  availablePresets,
  settingsPrompt,
  defaultPrompt,
}) => {
  const presets = Array.isArray(availablePresets) ? availablePresets : [];
  const normalizedDefault = normalizeTranscriptionPrompt(defaultPrompt);
  const normalizedSettings = normalizeTranscriptionPrompt(
    settingsPrompt,
    normalizedDefault,
  );

  if (requestedPresetId === CUSTOM_PROMPT_PRESET_ID
      || requestedPresetId === SETTINGS_PROMPT_PRESET_ID) {
    return Object.freeze({
      id: CUSTOM_PROMPT_PRESET_ID,
      editorPresetId: CUSTOM_PROMPT_PRESET_ID,
      persistedPresetId: SETTINGS_PROMPT_PRESET_ID,
      prompt: normalizedSettings,
      source: SETTINGS_PROMPT_PRESET_ID,
    });
  }

  if (typeof requestedPresetId !== 'string' || requestedPresetId.length === 0) {
    throw invalidPreset();
  }
  const preset = presets.find((candidate) => candidate?.id === requestedPresetId);
  if (!isUsableTranscriptionPromptPreset(preset)) {
    throw invalidPreset();
  }

  return Object.freeze({
    id: preset.id,
    editorPresetId: preset.id,
    persistedPresetId: preset.id,
    prompt: normalizeTranscriptionPrompt(preset.prompt, normalizedDefault),
    source: 'preset',
  });
};

/**
 * The sole browser-persistence path for a rules-editor preset change. Persist
 * only source identity: the effective prompt is deterministically resolved at
 * the Gemini action boundary, so it must not be copied into local/session
 * storage where it could become stale or overwrite the Settings-owned prompt.
 */
export const applyTranscriptionPromptPresetSelection = ({
  requestedPresetId,
  availablePresets,
  defaultPrompt,
  persistentStorage = globalThis.localStorage,
}) => {
  const selection = resolveTranscriptionPromptPresetSelection({
    requestedPresetId,
    availablePresets,
    settingsPrompt: readStorage(persistentStorage, 'transcription_prompt'),
    defaultPrompt,
  });

  if (!persistentStorage || typeof persistentStorage.setItem !== 'function') {
    throw new TypeError('Persistent browser storage is unavailable.');
  }

  persistentStorage.setItem(
    'video_processing_prompt_preset',
    selection.persistedPresetId,
  );

  return selection;
};
