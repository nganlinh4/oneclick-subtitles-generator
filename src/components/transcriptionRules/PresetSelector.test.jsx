import { fireEvent, render, screen } from '@testing-library/react';

import PresetSelector from './PresetSelector';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('../../services/geminiService', () => ({
  PROMPT_PRESETS: [{
    id: 'general',
    title: 'General purpose',
    prompt: 'General {contentType} prompt',
  }],
}));
vi.mock('../common/CustomDropdown', () => ({
  default: ({ options, onChange }) => (
    <div>
      {options.map(({ value }) => (
        <button key={value} type="button" onClick={() => onChange(value)}>
          {value}
        </button>
      ))}
    </div>
  ),
}));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('transcription_prompt', 'Settings {contentType} prompt');
});
afterEach(() => {
  vi.restoreAllMocks();
});

const renderSelector = (props = {}) => {
  const setCurrentPresetId = vi.fn();
  const onChangePrompt = vi.fn();
  const handleUserInteraction = vi.fn();
  const allPresets = [
    {
      id: 'general',
      title: 'General purpose',
      prompt: 'General {contentType} prompt',
    },
    {
      id: 'user-hostile',
      title: 'User hostile',
      prompt: 'User {contentType} duplicate {contentType}',
    },
    { id: 'missing-prompt', title: 'Broken user preset' },
    { id: 'general', title: 'Shadow built-in', prompt: 'Shadow {contentType}' },
  ];
  render(
    <PresetSelector
      currentPresetId="custom"
      setCurrentPresetId={setCurrentPresetId}
      allPresets={allPresets}
      userPromptPresets={[allPresets[1], allPresets[2], allPresets[3]]}
      onChangePrompt={onChangePrompt}
      handleUserInteraction={handleUserInteraction}
      {...props}
    />,
  );
  return { setCurrentPresetId, onChangePrompt, handleUserInteraction };
};

it('does not expose a user preset that has no usable prompt', () => {
  renderSelector();

  expect(screen.queryByRole('button', { name: 'missing-prompt' })).not.toBeInTheDocument();
  expect(localStorage.getItem('video_processing_prompt_preset')).toBeNull();
});

it('selects custom without ever writing literal undefined over Settings', () => {
  const spies = renderSelector();
  const setItem = vi.spyOn(Storage.prototype, 'setItem');

  fireEvent.click(screen.getByRole('button', { name: 'custom' }));

  expect(localStorage.getItem('transcription_prompt'))
    .toBe('Settings {contentType} prompt');
  expect(localStorage.getItem('video_processing_prompt_preset')).toBe('settings');
  expect(setItem.mock.calls).toEqual([
    ['video_processing_prompt_preset', 'settings'],
  ]);
  expect(spies.setCurrentPresetId).toHaveBeenCalledExactlyOnceWith('custom');
  expect(spies.onChangePrompt).toHaveBeenCalledWith(expect.objectContaining({
    id: 'custom',
    prompt: 'Settings {contentType} prompt',
  }));
  expect(JSON.stringify(spies.onChangePrompt.mock.calls)).not.toContain('undefined');
});

it.each([
  ['general', 'General {contentType} prompt'],
  ['user-hostile', 'User {contentType} duplicate '],
])('routes preset %s through the same normalization authority', (presetId, prompt) => {
  const spies = renderSelector();
  const setItem = vi.spyOn(Storage.prototype, 'setItem');

  fireEvent.click(screen.getByRole('button', { name: presetId }));

  expect(localStorage.getItem('transcription_prompt'))
    .toBe('Settings {contentType} prompt');
  expect(localStorage.getItem('video_processing_prompt_preset')).toBe(presetId);
  expect(setItem.mock.calls).toEqual([
    ['video_processing_prompt_preset', presetId],
  ]);
  expect(spies.setCurrentPresetId).toHaveBeenCalledExactlyOnceWith(presetId);
  expect(spies.onChangePrompt).toHaveBeenCalledWith(expect.objectContaining({
    id: presetId,
    prompt,
  }));
});
