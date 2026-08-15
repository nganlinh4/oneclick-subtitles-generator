import { act, fireEvent, render, screen } from '@testing-library/react';

import { showErrorToast } from '../utils/toastUtils';
import TranscriptionRulesEditor from './TranscriptionRulesEditor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key, fallback) => fallback,
  }),
}));
vi.mock('../services/geminiService', () => ({
  PROMPT_PRESETS: [],
  getUserPromptPresets: () => [],
}));
vi.mock('./transcriptionRules/PresetSelector', () => ({ default: () => null }));
vi.mock('../utils/toastUtils', () => ({ showErrorToast: vi.fn() }));

const initialRules = {
  atmosphere: 'quiet',
  terminology: [],
  speakerIdentification: [],
  formattingConventions: [],
  spellingAndGrammar: [],
  relationships: [],
  additionalNotes: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

const editAtmosphere = () => {
  fireEvent.change(screen.getByPlaceholderText('Description of the setting or context...'), {
    target: { value: 'busy' },
  });
};

test('owns the modal until one native save succeeds, then closes exactly once', async () => {
  let resolveSave;
  const onSave = vi.fn().mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
  const onClose = vi.fn();
  render(
    <TranscriptionRulesEditor
      isOpen
      initialRules={initialRules}
      onSave={onSave}
      onClose={onClose}
      onCancel={vi.fn()}
    />
  );
  editAtmosphere();

  const save = screen.getByRole('button', { name: 'Save' });
  fireEvent.click(save);
  fireEvent.click(save);

  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ atmosphere: 'busy' }));
  expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();

  resolveSave();
  await act(async () => {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(onClose).toHaveBeenCalledExactlyOnceWith('save');
  expect(showErrorToast).not.toHaveBeenCalled();
});

test('keeps the editor open and cancellable when native persistence fails', async () => {
  const onSave = vi.fn().mockRejectedValue(new Error('private native detail'));
  const onClose = vi.fn();
  render(
    <TranscriptionRulesEditor
      isOpen
      initialRules={initialRules}
      onSave={onSave}
      onClose={onClose}
      onCancel={vi.fn()}
    />
  );
  editAtmosphere();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await Promise.resolve();
  });

  expect(onClose).not.toHaveBeenCalled();
  expect(showErrorToast).toHaveBeenCalledWith(
    'Transcription rules could not be saved.',
    5_000,
  );
  expect(JSON.stringify(showErrorToast.mock.calls)).not.toContain('private native detail');
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(onClose).toHaveBeenCalledExactlyOnceWith('cancel');
});
