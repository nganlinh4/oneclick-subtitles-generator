import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import CustomDropdown from './CustomDropdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

const OPTIONS = [
  { value: 400, label: 'Normal' },
  { value: 700, label: 'Bold' },
];

const openDropdown = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Font weight' }));
  return screen.getByRole('option', { name: 'Normal' });
};

describe('CustomDropdown option activation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe() {}
      disconnect() {}
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('commits semantic click and keyboard-style activation without a preceding pointer gesture', () => {
    const onChange = vi.fn();
    render(
      <CustomDropdown
        value={700}
        onChange={onChange}
        options={OPTIONS}
        ariaLabel="Font weight"
        id="font-weight"
      />,
    );

    fireEvent.click(openDropdown());
    act(() => vi.runAllTimers());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(400);
  });

  it('does not commit twice when the existing pointer gesture is followed by its click event', () => {
    const onChange = vi.fn();
    render(
      <CustomDropdown
        value={700}
        onChange={onChange}
        options={OPTIONS}
        ariaLabel="Font weight"
        id="font-weight"
      />,
    );

    const option = openDropdown();
    fireEvent.mouseDown(option, { button: 0 });
    fireEvent.mouseUp(document, { button: 0 });
    fireEvent.click(option);
    act(() => vi.runAllTimers());

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(400);
  });
});
