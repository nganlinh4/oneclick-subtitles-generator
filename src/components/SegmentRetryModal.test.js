import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ParallelProcessingStatus from './ParallelProcessingStatus';
import SegmentRetryModal from './SegmentRetryModal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, values = {}) => String(fallback ?? key).replace(
      /\{\{(\w+)\}\}/g,
      (_match, name) => String(values[name] ?? '')
    ),
  }),
}));
vi.mock('../utils/transcriptionRulesStore', () => ({
  getTranscriptionRules: () => null,
}));

const segments = [{ start: 5, end: 8, status: 'error' }];

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const advanceToRetry = () => {
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  return screen.getByRole('button', { name: /retry segment/i });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  window.addToast = vi.fn();
});

test('removes DOM-save and timeout success and locks every modal exit while retry is pending', async () => {
  vi.useFakeTimers();
  const saveButton = document.createElement('button');
  saveButton.className = 'lyrics-save-btn';
  const saveClick = vi.fn();
  saveButton.addEventListener('click', saveClick);
  document.body.appendChild(saveButton);
  const pending = deferred();
  const onClose = vi.fn();
  const onRetry = vi.fn(() => pending.promise);
  const { container } = render(
    <SegmentRetryModal
      isOpen
      onClose={onClose}
      segmentIndex={0}
      segments={segments}
      onRetry={onRetry}
    />
  );

  const retry = advanceToRetry();
  fireEvent.click(retry);
  fireEvent.click(retry);

  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(saveClick).not.toHaveBeenCalled();
  expect(retry).toBeDisabled();
  expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /close/i })).toBeDisabled();

  fireEvent.click(container.querySelector('.segment-retry-modal-overlay'));
  fireEvent.keyDown(window, { key: 'Escape' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => pending.resolve(false));
  expect(onClose).not.toHaveBeenCalled();
  expect(retry).not.toBeDisabled();
  saveButton.remove();
});

test('blocks synchronous Escape and overlay close attempts made inside onRetry', async () => {
  const pending = deferred();
  const onClose = vi.fn();
  let overlay = null;
  const onRetry = vi.fn(() => {
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(overlay);
    return pending.promise;
  });
  const { container } = render(
    <SegmentRetryModal
      isOpen
      onClose={onClose}
      segmentIndex={0}
      segments={segments}
      onRetry={onRetry}
    />
  );
  overlay = container.querySelector('.segment-retry-modal-overlay');

  fireEvent.click(advanceToRetry());
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => pending.resolve(false));
  expect(onClose).not.toHaveBeenCalled();
});

test.each([
  ['true', () => Promise.resolve(true), true],
  ['false', () => Promise.resolve(false), false],
  ['rejection', () => Promise.reject(new Error('retry failed')), false],
])('ParallelProcessingStatus propagates retry %s so the modal closes only on true', async (
  _name,
  retryResult,
  shouldClose
) => {
  const onRetrySegment = vi.fn(retryResult);
  const { container } = render(
    <ParallelProcessingStatus
      segments={segments}
      overallStatus=""
      statusType=""
      onRetrySegment={onRetrySegment}
      onRetryWithModel={vi.fn()}
      retryingSegments={[]}
    />
  );

  fireEvent.click(screen.getByTitle('Retry segment'));
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  fireEvent.click(screen.getByRole('button', { name: /retry segment/i }));

  await waitFor(() => expect(onRetrySegment).toHaveBeenCalledTimes(1));
  await waitFor(() => {
    expect(Boolean(container.querySelector('.segment-retry-modal'))).toBe(!shouldClose);
  });
});
