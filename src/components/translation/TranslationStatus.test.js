import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import TranslationStatus from './TranslationStatus';

beforeEach(() => {
  window.addToast = vi.fn();
  window.removeToastByKey = vi.fn();
});

afterEach(() => {
  delete window.addToast;
  delete window.removeToastByKey;
});

test('publishes changing translation progress through one global toast and renders no inline UI', () => {
  const view = render(<TranslationStatus status="Translating chunk 1/6" />);
  expect(view.container).toBeEmptyDOMElement();
  expect(window.addToast).toHaveBeenLastCalledWith(
    'Translating chunk 1/6', 'info', 3_600_000, 'translation-progress'
  );

  view.rerender(<TranslationStatus status="Translating chunk 2/6" />);
  expect(view.container).toBeEmptyDOMElement();
  expect(window.addToast).toHaveBeenLastCalledWith(
    'Translating chunk 2/6', 'info', 3_600_000, 'translation-progress'
  );

  act(() => view.unmount());
  expect(window.removeToastByKey).toHaveBeenCalledWith('translation-progress');
});
