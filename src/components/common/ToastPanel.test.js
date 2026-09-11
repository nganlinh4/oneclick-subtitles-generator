import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ToastPanel from './ToastPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback ?? _key }),
}));

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

test('clean-install onboarding suppresses routine noise but never failures or actions', async () => {
  window.addToast('startup failure', 'error', 8000);
  render(<ToastPanel />);
  await waitFor(() => expect(window.addToast('routine status', 'info')).toBe(false));
  expect(screen.queryByText('routine status')).not.toBeInTheDocument();

  act(() => {
    window.addToast('font repair failed', 'error', 8000);
    window.addToast('credentials will be removed', 'warning', 30_000, 'confirm', {
      text: 'Confirm',
      onClick: vi.fn(),
    });
  });

  expect(await screen.findByText('font repair failed')).toBeInTheDocument();
  expect(screen.getByText('startup failure')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
});

test('event-backed failures remain visible during onboarding', async () => {
  render(<ToastPanel />);
  await waitFor(() => expect(typeof window.addToast).toBe('function'));

  act(() => window.dispatchEvent(new CustomEvent('aligned-narration-status', {
    detail: { status: 'error', message: 'alignment failed' },
  })));

  expect(await screen.findByText('alignment failed')).toBeInTheDocument();
});

test('a completed confirmation cannot be executed again from toast history', async () => {
  vi.useFakeTimers();
  localStorage.setItem('has_visited_site', 'true');
  localStorage.setItem('onboarding_controls_dismissed', 'true');
  const onConfirm = vi.fn();
  render(<ToastPanel />);

  act(() => window.addToast('Delete model?', 'warning', 30_000, 'delete-model', {
    text: 'Confirm',
    onClick: onConfirm,
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(500));

  fireEvent.click(screen.getByRole('button', { name: 'common.showToastHistory' }));
  expect(screen.getByText('Delete model?')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
  expect(onConfirm).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test('history persistence retains the newest 200 notifications', async () => {
  localStorage.setItem('has_visited_site', 'true');
  localStorage.setItem('onboarding_controls_dismissed', 'true');
  render(<ToastPanel />);

  act(() => {
    for (let index = 0; index < 205; index += 1) {
      window.addToast(`toast-${index}`, 'info', 60_000);
    }
  });

  await waitFor(() => {
    const history = JSON.parse(localStorage.getItem('toast_history_v1'));
    expect(history).toHaveLength(200);
    expect(history[0].message).toBe('toast-204');
    expect(history.at(-1).message).toBe('toast-5');
  });
});

test('coalesces only recent identical non-actionable successes', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-25T12:00:00Z'));
  localStorage.setItem('has_visited_site', 'true');
  localStorage.setItem('onboarding_controls_dismissed', 'true');
  render(<ToastPanel />);

  act(() => {
    window.addToast('Progress saved successfully', 'success', 60_000);
    window.addToast('Progress saved successfully', 'success', 60_000);
    window.addToast('A different success', 'success', 60_000);
    window.addToast('Save failed', 'error', 60_000);
    window.addToast('Save failed', 'error', 60_000);
  });

  expect(screen.getAllByText('Progress saved successfully')).toHaveLength(1);
  expect(screen.getAllByText('A different success')).toHaveLength(1);
  expect(screen.getAllByText('Save failed')).toHaveLength(2);

  act(() => {
    vi.advanceTimersByTime(3_001);
    window.addToast('Progress saved successfully', 'success', 60_000);
  });

  expect(screen.getAllByText('Progress saved successfully')).toHaveLength(2);
});

test('records every keyed update while updating one live toast in place', async () => {
  localStorage.setItem('has_visited_site', 'true');
  localStorage.setItem('onboarding_controls_dismissed', 'true');
  render(<ToastPanel />);

  act(() => {
    window.addToast('Downloading', 'info', 60_000, 'output-status');
    window.addToast('Transcribing', 'info', 60_000, 'output-status');
    window.addToast('Finished', 'success', 60_000, 'output-status');
  });

  expect(screen.queryByText('Downloading')).not.toBeInTheDocument();
  expect(screen.queryByText('Transcribing')).not.toBeInTheDocument();
  expect(screen.getByText('Finished')).toBeInTheDocument();
  await waitFor(() => expect(
    JSON.parse(localStorage.getItem('toast_history_v1')).map((toast) => toast.message)
  ).toEqual(['Finished', 'Transcribing', 'Downloading']));
});

test('records suppressed onboarding notifications without displaying them', async () => {
  render(<ToastPanel />);

  act(() => {
    expect(window.addToast('Routine startup status', 'info')).toBe(false);
    expect(window.addToast('Startup complete', 'success')).toBe(false);
  });

  expect(screen.queryByText('Routine startup status')).not.toBeInTheDocument();
  await waitFor(() => expect(
    JSON.parse(localStorage.getItem('toast_history_v1')).map((toast) => toast.message)
  ).toEqual(['Startup complete', 'Routine startup status']));
});

test('records repeated coalesced successes as separate history events', async () => {
  localStorage.setItem('has_visited_site', 'true');
  localStorage.setItem('onboarding_controls_dismissed', 'true');
  render(<ToastPanel />);

  act(() => {
    window.addToast('Saved', 'success', 60_000);
    window.addToast('Saved', 'success', 60_000);
  });

  expect(screen.getAllByText('Saved')).toHaveLength(1);
  await waitFor(() => expect(
    JSON.parse(localStorage.getItem('toast_history_v1')).filter((toast) => toast.message === 'Saved')
  ).toHaveLength(2));
});

test('records notifications displayed by an embedded application without duplicating them live', async () => {
  localStorage.setItem('has_visited_site', 'true');
  localStorage.setItem('onboarding_controls_dismissed', 'true');
  render(<ToastPanel />);

  act(() => window.recordToastHistory('Embedded music failed', 'error'));

  expect(screen.queryByText('Embedded music failed')).not.toBeInTheDocument();
  await waitFor(() => expect(
    JSON.parse(localStorage.getItem('toast_history_v1'))[0]
  ).toMatchObject({ message: 'Embedded music failed', type: 'error' }));
});

test('a keyed update during dismissal creates a fresh live toast and stable history entry', async () => {
  vi.useFakeTimers();
  localStorage.setItem('has_visited_site', 'true');
  localStorage.setItem('onboarding_controls_dismissed', 'true');
  render(<ToastPanel />);

  act(() => window.addToast('Starting', 'info', 1000, 'progress'));
  act(() => vi.advanceTimersByTime(1000));
  act(() => window.addToast('Completed', 'success', 60_000, 'progress'));
  act(() => vi.advanceTimersByTime(500));

  expect(screen.getByText('Completed').closest('.toast-item')).toHaveClass('live', 'show');
  const history = JSON.parse(localStorage.getItem('toast_history_v1'));
  expect(history[0]).toMatchObject({ message: 'Completed', type: 'success' });
  expect(history[0]).not.toHaveProperty('dismissing');
});

test('does not coalesce identical successes that carry independent actions', () => {
  vi.useFakeTimers();
  localStorage.setItem('has_visited_site', 'true');
  localStorage.setItem('onboarding_controls_dismissed', 'true');
  render(<ToastPanel />);

  act(() => {
    window.addToast('Export ready', 'success', 60_000, undefined, {
      text: 'Open first',
      onClick: vi.fn(),
    });
    window.addToast('Export ready', 'success', 60_000, undefined, {
      text: 'Open second',
      onClick: vi.fn(),
    });
  });

  expect(screen.getAllByText('Export ready')).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Open first' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open second' })).toBeInTheDocument();
});

test('blocks ambient history chrome over a modal while preserving live actionable toasts', () => {
  localStorage.setItem('has_visited_site', 'true');
  localStorage.setItem('onboarding_controls_dismissed', 'true');
  localStorage.setItem('toast_history_v1', JSON.stringify([{
    id: 'older-session-1',
    message: 'Earlier completed action',
    type: 'success',
    timestamp: Date.now() - 60_000,
  }]));
  const { rerender } = render(<ToastPanel />);

  const historyButton = screen.getByRole('button', { name: 'common.showToastHistory' });
  expect(historyButton).toBeEnabled();
  fireEvent.click(historyButton);
  expect(screen.getByText('Earlier completed action')).toBeInTheDocument();

  act(() => window.addToast('Confirm reset?', 'warning', 60_000, 'reset', {
    text: 'Confirm',
    onClick: vi.fn(),
  }));
  rerender(<ToastPanel backgroundControlsBlocked />);

  const blockedHistory = screen.getByRole('button', {
    name: 'common.hideToastHistory',
    hidden: true,
  });
  expect(blockedHistory).toBeDisabled();
  expect(blockedHistory).toHaveAttribute('tabindex', '-1');
  expect(blockedHistory.closest('.toast-history-button-container')).toHaveAttribute('hidden');
  expect(blockedHistory.closest('.toast-history-button-container')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.queryByText('Earlier completed action')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
});
