import { act, renderHook } from '@testing-library/react';

import useNativePreviewToast from './useNativePreviewToast';

const { capability, retryManagedFont } = vi.hoisted(() => ({
  capability: { current: null },
  retryManagedFont: vi.fn(),
}));

vi.mock('../../../services/useFontReadiness', () => ({
  useFontReadiness: () => capability.current,
}));

vi.mock('../../../services/fontRepair', () => ({ retryManagedFont }));

const t = (_key, fallback, values = {}) => Object.entries(values).reduce(
  (message, [name, value]) => message.replace(`{{${name}}}`, String(value)),
  fallback,
);

beforeEach(() => {
  vi.useFakeTimers();
  window.addToast = vi.fn();
  window.removeToastByKey = vi.fn();
  capability.current = {
    published: true,
    managedPackInstalled: false,
    readiness: 'refused',
    reason: 'digest-mismatch',
    retryable: true,
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('does not blame an unrelated managed pack for a generic dormant prerequisite', () => {
  const view = renderHook((props) => useNativePreviewToast(props), {
    initialProps: {
      error: null,
      dormant: true,
      fontBlocked: false,
      onRetry: null,
      t,
    },
  });

  act(() => vi.advanceTimersByTime(1_200));
  expect(window.addToast).toHaveBeenLastCalledWith(
    'Subtitle preview is not ready. Try reopening this video.',
    'warning',
    8000,
    'native-subtitle-preview',
    undefined,
  );

  view.rerender({
    error: null,
    dormant: true,
    fontBlocked: true,
    onRetry: null,
    t,
  });
  act(() => vi.advanceTimersByTime(1_200));
  const fontToast = window.addToast.mock.calls.at(-1);
  expect(fontToast.slice(0, 4)).toEqual([
    'The subtitle font could not be installed (digest-mismatch), so subtitles cannot be drawn.',
    'warning',
    8000,
    'native-subtitle-preview',
  ]);
  expect(fontToast[4]).toMatchObject({ text: 'Install again', onClick: retryManagedFont });
});
