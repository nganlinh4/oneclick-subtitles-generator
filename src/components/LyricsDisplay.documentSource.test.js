import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LyricsDisplay from './LyricsDisplay';

const mocks = vi.hoisted(() => ({ summarize: vi.fn(), downloadText: vi.fn() }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('../services/geminiService', () => ({ summarizeDocument: mocks.summarize }));
vi.mock('../utils/fileUtils', async (importOriginal) => ({
  ...await importOriginal(),
  downloadTextDocument: mocks.downloadText,
}));
vi.mock('./lyrics/TimelineVisualization', () => ({ default: () => null }));
vi.mock('./lyrics/LyricsHeader', () => ({ default: () => null }));
vi.mock('./LyricsVirtualizedList', () => ({
  default: ({ onTextEdit }) => <button onClick={() => onTextEdit(0, 'Edited original')}>Edit cue</button>,
}));
vi.mock('./DownloadOptionsModal', () => ({
  default: ({ isOpen, onProcess }) => isOpen && <>
    <button onClick={() => onProcess('original', 'summarize', 'document-model', 0, null)}>Summarize original</button>
    <button onClick={() => onProcess('translated', 'summarize', 'document-model', 0, null)}>Summarize translated</button>
  </>,
}));

test('Download Center captures the chosen subtitle source after switching or editing', async () => {
  mocks.summarize.mockImplementation(async (text) => `Summary: ${text}`);
  mocks.downloadText.mockResolvedValue({ status: 'saved' });
  render(<LyricsDisplay
    matchedLyrics={[{ id: 'one', start: 0, end: 1, text: 'Original' }]}
    translatedSubtitles={[
      { id: 'one', start: 0, end: 1, text: 'Translated first' },
      { id: 'two', start: 1, end: 2, text: 'Translated second' },
    ]}
    currentTime={0}
    duration={2}
    onUpdateLyrics={vi.fn()}
    onLyricClick={vi.fn()}
  />);
  fireEvent.click(screen.getByRole('button', { name: /Download Center/ }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Summarize original' })));
  await waitFor(() => expect(mocks.downloadText).toHaveBeenLastCalledWith(
    'Summary: Original', expect.any(String),
  ));

  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Summarize translated' })));
  await waitFor(() => expect(mocks.downloadText).toHaveBeenLastCalledWith(
    'Summary: Translated first\n\nTranslated second', expect.any(String),
  ));

  fireEvent.click(screen.getByRole('button', { name: 'Edit cue' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Summarize original' })));
  await waitFor(() => expect(mocks.downloadText).toHaveBeenLastCalledWith(
    'Summary: Edited original', expect.any(String),
  ));
});
