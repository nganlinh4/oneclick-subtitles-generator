import { act, fireEvent, render, screen } from '@testing-library/react';

import { showErrorToast } from '../utils/toastUtils';
import AddSubtitlesButton from './AddSubtitlesButton';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key, fallback) => fallback,
  }),
}));
vi.mock('../utils/toastUtils', () => ({ showErrorToast: vi.fn() }));
vi.mock('./common/LoadingIndicator', () => ({ default: () => <span>loading</span> }));
vi.mock('./LyricsInputSection', () => ({
  default: ({ onLyricsReceived }) => (
    <button
      type="button"
      onClick={() => onLyricsReceived('Line one\n\nLine two', 'album-art', 'Song')}
    >
      Use lyrics
    </button>
  ),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

const openModal = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Add subtitles' }));
  return screen.getByPlaceholderText('Enter your subtitles here...');
};

test('ignores the obsolete browser copy and closes only after one native save settles', async () => {
  localStorage.setItem('user_provided_subtitles', 'stale subtitles from another project');
  let finishSave;
  const nativeSave = new Promise((resolve) => { finishSave = resolve; });
  const onSubtitlesAdd = vi.fn(() => nativeSave);
  render(<AddSubtitlesButton onSubtitlesAdd={onSubtitlesAdd} />);

  expect(screen.getByRole('button', { name: 'Add subtitles' })).toBeEnabled();
  const textarea = openModal();
  fireEvent.change(textarea, { target: { value: 'First line\n\nSecond line' } });

  const save = screen.getByRole('button', { name: 'Save Subtitles' });
  fireEvent.click(save);
  fireEvent.click(save);
  await act(async () => { await Promise.resolve(); });

  expect(onSubtitlesAdd).toHaveBeenCalledExactlyOnceWith('First line\nSecond line');
  expect(screen.getByRole('button', { name: /Saving\.\.\.$/ })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  fireEvent.keyDown(textarea, { key: 'Escape' });
  expect(screen.getByPlaceholderText('Enter your subtitles here...')).toBeInTheDocument();

  await act(async () => {
    finishSave();
    await nativeSave;
    await Promise.resolve();
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });

  expect(screen.queryByPlaceholderText('Enter your subtitles here...')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Subtitles added$/ })).toBeEnabled();
  expect(localStorage.getItem('user_provided_subtitles'))
    .toBe('stale subtitles from another project');
  expect(showErrorToast).not.toHaveBeenCalled();
});

test('keeps the draft open and retryable when native persistence fails', async () => {
  const onSubtitlesAdd = vi.fn().mockRejectedValue(new Error('private database path'));
  render(<AddSubtitlesButton onSubtitlesAdd={onSubtitlesAdd} />);
  const textarea = openModal();
  fireEvent.change(textarea, { target: { value: 'Unsaved reference' } });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save Subtitles' }));
    await Promise.resolve();
  });

  expect(screen.getByDisplayValue('Unsaved reference')).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Add subtitles' })).toBeEnabled();
  expect(showErrorToast).toHaveBeenCalledExactlyOnceWith(
    'The subtitles could not be saved. Please try again.',
    5_000,
  );
  expect(JSON.stringify(showErrorToast.mock.calls)).not.toContain('private database path');

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(150); });
  expect(screen.queryByDisplayValue('Unsaved reference')).not.toBeInTheDocument();
});

test('does not clear the visible project subtitles until native persistence succeeds', async () => {
  let finishClear;
  const nativeClear = new Promise((resolve) => { finishClear = resolve; });
  const onSubtitlesAdd = vi.fn(() => nativeClear);
  render(
    <AddSubtitlesButton
      onSubtitlesAdd={onSubtitlesAdd}
      hasSubtitles
      subtitlesText="Saved reference"
    />
  );

  fireEvent.click(screen.getByRole('button', { name: 'Clear subtitles' }));
  await act(async () => { await Promise.resolve(); });
  expect(onSubtitlesAdd).toHaveBeenCalledExactlyOnceWith('');
  expect(screen.getByRole('button', { name: /Processing\.\.\.$/ })).toBeDisabled();

  await act(async () => {
    finishClear();
    await nativeClear;
  });
  expect(screen.getByRole('button', { name: 'Add subtitles' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Clear subtitles' })).not.toBeInTheDocument();
});

test('keeps the saved project subtitles visible when native clearing fails', async () => {
  const onSubtitlesAdd = vi.fn().mockRejectedValue(new Error('private native failure'));
  render(
    <AddSubtitlesButton
      onSubtitlesAdd={onSubtitlesAdd}
      hasSubtitles
      subtitlesText="Saved reference"
    />
  );

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Clear subtitles' }));
    await Promise.resolve();
  });

  expect(onSubtitlesAdd).toHaveBeenCalledExactlyOnceWith('');
  expect(screen.getByRole('button', { name: /Subtitles added$/ })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Clear subtitles' })).toBeEnabled();
  expect(showErrorToast).toHaveBeenCalledExactlyOnceWith(
    'The subtitles could not be saved. Please try again.',
    5_000,
  );
  expect(JSON.stringify(showErrorToast.mock.calls)).not.toContain('private native failure');
});

test('starts background generation only after the exact cleaned lyrics are durable', async () => {
  let finishSave;
  const nativeSave = new Promise((resolve) => { finishSave = resolve; });
  const onSubtitlesAdd = vi.fn(() => nativeSave);
  const onGenerateBackground = vi.fn();
  render(
    <AddSubtitlesButton
      onSubtitlesAdd={onSubtitlesAdd}
      onGenerateBackground={onGenerateBackground}
    />
  );

  openModal();
  fireEvent.click(screen.getByRole('button', { name: /Fetch Song Lyrics$/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Use lyrics' }));
  fireEvent.click(screen.getByRole('button', {
    name: /Do you want to generate background image inspired from this album art and lyrics\?$/,
  }));
  await act(async () => { await Promise.resolve(); });

  expect(onSubtitlesAdd).toHaveBeenCalledExactlyOnceWith('Line one\nLine two');
  expect(onGenerateBackground).not.toHaveBeenCalled();

  await act(async () => {
    finishSave();
    await nativeSave;
    await Promise.resolve();
  });
  expect(onGenerateBackground).toHaveBeenCalledExactlyOnceWith(
    'Line one\nLine two',
    'album-art',
    'Song',
  );
});
