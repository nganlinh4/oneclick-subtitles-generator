import { act, fireEvent, render, screen } from '@testing-library/react';

import FontSettings from './FontSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback ?? _key }),
}));

const exactFontOptions = Object.freeze([
  Object.freeze({
    value: "'Arial', sans-serif",
    label: 'Arial',
    group: 'Sans-serif',
    resolvedWeight: 700,
  }),
  Object.freeze({
    value: "'Impact', sans-serif",
    label: 'Impact',
    group: 'Display',
    resolvedWeight: 400,
  }),
]);

const settings = Object.freeze({
  fontFamily: "'Arial', sans-serif",
  fontSize: '48',
  fontWeight: '700',
  lineSpacing: '1.4',
  letterSpacing: '0',
});

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}

    disconnect() {}
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('publishes a selected family and its exact weight in one atomic settings update', () => {
  vi.useFakeTimers();
  const handleSettingChange = vi.fn();
  const handleSettingsChange = vi.fn();
  const { container } = render(
    <FontSettings
      settings={settings}
      handleSettingChange={handleSettingChange}
      handleSettingsChange={handleSettingsChange}
      fontOptions={exactFontOptions}
      selectedFontValue={settings.fontFamily}
      fontWeightOptions={[
        { value: '400', label: 'Normal' },
        { value: '700', label: 'Bold' },
      ]}
    />,
  );

  expect(container.querySelector('#font-family')).toHaveAccessibleName('Font');
  expect(container.querySelector('#font-weight')).toHaveAccessibleName('Font Weight');
  expect(container.querySelector('#font-weight')).toHaveAttribute('data-value', '700');

  fireEvent.click(container.querySelector('.custom-dropdown-button'));
  fireEvent.mouseDown(screen.getByRole('option', { name: 'Impact' }));
  fireEvent.mouseUp(document);
  act(() => vi.runAllTimers());

  expect(handleSettingsChange).toHaveBeenCalledTimes(1);
  expect(handleSettingsChange).toHaveBeenCalledWith({
    fontFamily: "'Impact', sans-serif",
    fontWeight: '400',
  });
  expect(handleSettingChange).not.toHaveBeenCalled();
});
