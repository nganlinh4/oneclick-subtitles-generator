import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DownloadOptionsModal from './DownloadOptionsModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('./ModelDropdown', () => ({ default: () => <div /> }));
vi.mock('./PromptEditor', () => ({ default: () => null }));
vi.mock('./common/SliderWithValue', () => ({ default: () => <div /> }));
vi.mock('../utils/tabPillAnimation', () => ({ default: vi.fn() }));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  window.addToast = vi.fn();
});

test('awaits the native save result and locks every dismissal path while pending', async () => {
  const pending = deferred();
  const onClose = vi.fn();
  const onDownload = vi.fn(() => pending.promise);
  const { container } = render(
    <DownloadOptionsModal
      isOpen
      onClose={onClose}
      onDownload={onDownload}
      onProcess={vi.fn()}
    />
  );

  const download = container.querySelector('.download-button');
  fireEvent.click(download);
  fireEvent.click(download);
  expect(onDownload).toHaveBeenCalledTimes(1);
  expect(download).toBeDisabled();
  expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /close/i })).toBeDisabled();

  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.mouseDown(container.querySelector('.modal-overlay'));
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => pending.resolve({ status: 'cancelled' }));
  expect(onClose).not.toHaveBeenCalled();
  expect(download).not.toBeDisabled();
});

test('closes exactly once only after a confirmed save and stays open on failure', async () => {
  const onClose = vi.fn();
  const onDownload = vi.fn()
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValueOnce({ status: 'saved' });
  const { container } = render(
    <DownloadOptionsModal
      isOpen
      onClose={onClose}
      onDownload={onDownload}
      onProcess={vi.fn()}
    />
  );

  fireEvent.click(container.querySelector('.download-button'));
  await waitFor(() => expect(window.addToast).toHaveBeenCalledWith('disk full', 'error', 8000));
  expect(onClose).not.toHaveBeenCalled();

  fireEvent.click(container.querySelector('.download-button'));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

test('releases the synchronous lease when failure notification itself throws', async () => {
  window.addToast = vi.fn(() => {
    throw new Error('toast unavailable');
  });
  const onDownload = vi.fn()
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValueOnce({ status: 'saved' });
  const onClose = vi.fn();
  const { container } = render(
    <DownloadOptionsModal
      isOpen
      onClose={onClose}
      onDownload={onDownload}
      onProcess={vi.fn()}
    />
  );

  const download = container.querySelector('.download-button');
  fireEvent.click(download);
  await waitFor(() => expect(download).not.toBeDisabled());
  fireEvent.click(download);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onDownload).toHaveBeenCalledTimes(2);
});
