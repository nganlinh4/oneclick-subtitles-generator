import { fireEvent, render, waitFor } from '@testing-library/react';

import { MANAGED_FONT_PACKAGE } from '../../services/fontIdentity';
import { defaultCustomization } from './defaultCustomization';
import TextControls from './TextControls';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback ?? _key }),
}));

vi.mock('../../platform/systemFontProbe', () => ({
  systemFontProbe: () => () => true,
}));

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    disconnect() {}
  });
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
  window.__OSG_FONT_READINESS__ = {
    schema: 1,
    state: 'ready',
    family: MANAGED_FONT_PACKAGE.family,
    epoch: 1,
    reason: null,
    retryable: false,
    version: MANAGED_FONT_PACKAGE.version,
  };
});

afterEach(() => {
  delete window.__OSG_FONT_READINESS__;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test('the Render control cannot select a weight outside the exact Impact face', () => {
  const { container } = render(
    <TextControls
      customization={{
        ...defaultCustomization,
        fontFamily: "'Impact', sans-serif",
        fontWeight: 400,
      }}
      onChange={vi.fn()}
    />,
  );

  const weightButton = container.querySelector('.font-weight-slider .custom-dropdown-button');
  expect(weightButton).toBeDisabled();
  expect(weightButton).toHaveTextContent('Normal');
  expect(weightButton).toHaveAttribute('id', 'font-weight-slider');
  expect(weightButton).toHaveAttribute('data-osg-setting', 'font-weight');
  expect(weightButton).toHaveAttribute('data-value', '400');
  expect(weightButton).toHaveAccessibleName('Font Weight');
});

test('the Render font picker publishes family and its compatible weight as one patch', () => {
  const onChange = vi.fn();
  const initial = {
    ...defaultCustomization,
    fontFamily: "'Arial', sans-serif",
    fontWeight: 700,
  };
  const { container } = render(<TextControls customization={initial} onChange={onChange} />);

  fireEvent.click(container.querySelector('.font-selector-button'));
  const impactCard = [...container.querySelectorAll('.font-card')]
    .find(card => card.querySelector('.font-name')?.textContent === 'Impact');
  expect(impactCard).toBeTruthy();
  fireEvent.click(impactCard);

  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange.mock.calls[0][0](initial)).toMatchObject({
    fontFamily: "'Impact', sans-serif",
    fontWeight: 400,
    preset: 'custom',
  });
});

test('the public Render alignment control exposes and commits native justification', async () => {
  const onChange = vi.fn();
  const initial = { ...defaultCustomization, textAlign: 'center' };
  render(<TextControls customization={initial} onChange={onChange} />);

  fireEvent.click(document.querySelector('#render-text-align'));
  const options = [...document.querySelectorAll('#render-text-align-listbox [role="option"]')];
  expect(options.map(option => option.textContent)).toEqual(['Left', 'Center', 'Right', 'Justify']);
  fireEvent.mouseDown(options[3]);
  fireEvent.mouseUp(document);

  await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  expect(onChange.mock.calls[0][0](initial)).toMatchObject({
    textAlign: 'justify',
    preset: 'custom',
  });
});
