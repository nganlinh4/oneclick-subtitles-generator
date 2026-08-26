import {
  applyTranscriptionPromptPresetSelection,
  normalizeUserTranscriptionPromptPresets,
  resolveTranscriptionPromptPresetSelection,
} from './transcriptionPromptPresetSelection';

const DEFAULT_PROMPT = 'Default {contentType} prompt';
const PRESETS = [
  { id: 'general', prompt: DEFAULT_PROMPT },
  { id: 'hostile-duplicate', prompt: 'Before {contentType} after {contentType}' },
  { id: 'legacy-missing-token', prompt: 'Legacy preset' },
  { id: 'missing-prompt' },
];

const storage = (entries = {}) => {
  const values = new Map(Object.entries(entries));
  const operations = [];
  return {
    operations,
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => {
      operations.push(['set', key, String(value)]);
      values.set(key, String(value));
    },
    removeItem: (key) => {
      operations.push(['remove', key]);
      values.delete(key);
    },
  };
};

it('keeps the current normalized Settings prompt when custom has no prompt field', () => {
  const persistentStorage = storage({
    transcription_prompt: 'My exact {contentType} instructions',
  });
  const transientStorage = storage();

  const selection = applyTranscriptionPromptPresetSelection({
    requestedPresetId: 'custom',
    availablePresets: PRESETS,
    defaultPrompt: DEFAULT_PROMPT,
    persistentStorage,
  });

  expect(selection).toEqual(expect.objectContaining({
    id: 'custom',
    persistedPresetId: 'settings',
    prompt: 'My exact {contentType} instructions',
    source: 'settings',
  }));
  expect(persistentStorage.getItem('transcription_prompt'))
    .toBe('My exact {contentType} instructions');
  expect(persistentStorage.operations).toEqual([
    ['set', 'video_processing_prompt_preset', 'settings'],
  ]);
  expect(transientStorage.operations).toEqual([]);
});

it('normalizes a legacy Settings prompt without changing recommendation session state', () => {
  const persistentStorage = storage({ transcription_prompt: 'Legacy settings prompt  ' });
  const transientStorage = storage({
    current_session_preset_id: 'general',
    current_session_prompt: 'stale derived bytes',
  });

  const selection = applyTranscriptionPromptPresetSelection({
    requestedPresetId: 'custom',
    availablePresets: PRESETS,
    defaultPrompt: DEFAULT_PROMPT,
    persistentStorage,
  });

  expect(selection.prompt).toBe('Legacy settings prompt\n\n{contentType}');
  expect(persistentStorage.getItem('transcription_prompt'))
    .toBe('Legacy settings prompt  ');
  expect(transientStorage.operations).toEqual([]);
  expect(transientStorage.getItem('current_session_preset_id')).toBe('general');
  expect(transientStorage.getItem('current_session_prompt')).toBe('stale derived bytes');
});

it.each([
  ['hostile-duplicate', 'Before {contentType} after '],
  ['legacy-missing-token', 'Legacy preset\n\n{contentType}'],
])('normalizes preset %s while preserving the Settings-owned prompt', (presetId, expectedPrompt) => {
  const persistentStorage = storage({
    transcription_prompt: 'Do not overwrite {contentType}',
  });
  const transientStorage = storage({ current_session_preset_id: 'general' });

  const selection = applyTranscriptionPromptPresetSelection({
    requestedPresetId: presetId,
    availablePresets: PRESETS,
    defaultPrompt: DEFAULT_PROMPT,
    persistentStorage,
  });

  expect(selection).toEqual(expect.objectContaining({
    id: presetId,
    persistedPresetId: presetId,
    prompt: expectedPrompt,
    source: 'preset',
  }));
  expect(persistentStorage.getItem('transcription_prompt'))
    .toBe('Do not overwrite {contentType}');
  expect(persistentStorage.operations).toEqual([
    ['set', 'video_processing_prompt_preset', presetId],
  ]);
  expect(transientStorage.operations).toEqual([]);
  expect(transientStorage.getItem('current_session_preset_id')).toBe('general');
});

it.each(['missing-prompt', 'unknown', '', undefined])(
  'rejects invalid preset %s before any browser state mutates',
  (requestedPresetId) => {
    const persistentStorage = storage({
      transcription_prompt: 'Still safe {contentType}',
      video_processing_prompt_preset: 'general',
    });
    const transientStorage = storage({
      current_session_preset_id: 'general',
      current_session_prompt: 'still safe',
    });

    expect(() => applyTranscriptionPromptPresetSelection({
      requestedPresetId,
      availablePresets: PRESETS,
      defaultPrompt: DEFAULT_PROMPT,
      persistentStorage,
    })).toThrow(expect.objectContaining({ code: 'invalidTranscriptionPromptPreset' }));

    expect(persistentStorage.operations).toEqual([]);
    expect(transientStorage.operations).toEqual([]);
    expect(persistentStorage.getItem('video_processing_prompt_preset')).toBe('general');
    expect(transientStorage.getItem('current_session_prompt')).toBe('still safe');
  },
);

it('resolves the settings alias through the same custom authority', () => {
  expect(resolveTranscriptionPromptPresetSelection({
    requestedPresetId: 'settings',
    availablePresets: PRESETS,
    settingsPrompt: null,
    defaultPrompt: DEFAULT_PROMPT,
  })).toEqual(expect.objectContaining({
    id: 'custom',
    persistedPresetId: 'settings',
    prompt: DEFAULT_PROMPT,
  }));
});

it.each(['undefined', 'null'])(
  'recovers a legacy literal %s Settings value without persisting the sentinel again',
  (legacySentinel) => {
    const persistentStorage = storage({ transcription_prompt: legacySentinel });

    const selection = applyTranscriptionPromptPresetSelection({
      requestedPresetId: 'custom',
      availablePresets: PRESETS,
      defaultPrompt: DEFAULT_PROMPT,
      persistentStorage,
    });

    expect(selection.prompt).toBe(DEFAULT_PROMPT);
    expect(persistentStorage.operations).toEqual([
      ['set', 'video_processing_prompt_preset', 'settings'],
    ]);
    expect(persistentStorage.getItem('transcription_prompt')).toBe(legacySentinel);
  },
);

it('filters malformed, reserved, and duplicate user presets deterministically', () => {
  const first = { id: 'user-one', prompt: 'First {contentType}' };
  expect(normalizeUserTranscriptionPromptPresets([
    null,
    { id: ' ', prompt: 'Whitespace identifier {contentType}' },
    { id: 'general', prompt: 'Must not shadow built-in {contentType}' },
    first,
    { id: 'user-one', prompt: 'Must not shadow first user preset {contentType}' },
    { id: 'missing-prompt' },
  ], ['general'])).toEqual([first]);
});
