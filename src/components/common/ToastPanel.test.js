import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import ToastPanel from './ToastPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback ?? _key }),
}));

beforeEach(() => {
  localStorage.clear();
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
