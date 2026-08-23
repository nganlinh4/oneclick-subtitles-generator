import { showConfirmationToast, showErrorToast } from './toastUtils';

beforeEach(() => {
  window.addToast = vi.fn();
});

test('turns a rejected non-blocking confirmation into an error toast', async () => {
  showConfirmationToast({
    message: 'Delete?',
    confirmText: 'Confirm',
    onConfirm: () => Promise.reject(new Error('delete failed')),
  });

  const confirmation = window.addToast.mock.calls[0][4];
  await expect(confirmation.onClick()).resolves.toBe(false);
  expect(window.addToast).toHaveBeenLastCalledWith('delete failed', 'error', 8000);
});

test('renders fallback messages as text instead of executable markup', () => {
  delete window.addToast;
  const toast = showErrorToast('<img src=x onerror="window.__toastInjected=true">');

  expect(toast.querySelector('img')).toBeNull();
  expect(toast.querySelector('.toast-message')).toHaveTextContent('<img src=x onerror');
  expect(window.__toastInjected).toBeUndefined();
  toast.remove();
});
