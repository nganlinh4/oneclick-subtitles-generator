import { act, fireEvent, render, waitFor } from '@testing-library/react';

import { FONT_READINESS_EVENT } from '../../services/fontCapability';
import { MANAGED_FONT_PACKAGE } from '../../services/fontIdentity';
import { defaultCustomization } from './defaultCustomization';
import TextControls from './TextControls';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback ?? _key }),
}));

// This journey isolates managed-package readiness; system-face participation is a separate probe
// contract and jsdom has no real canvas with which to prove it.
vi.mock('../../platform/systemFontProbe', () => ({
  systemFontProbe: () => () => true,
}));

afterEach(() => {
  delete window.__OSG_FONT_READINESS__;
  vi.restoreAllMocks();
});

test('an open font selector follows late managed readiness without being reopened', async () => {
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows NT 10.0 Chrome');
  window.__OSG_FONT_READINESS__ = {
    schema: 1,
    state: 'repairing',
    family: MANAGED_FONT_PACKAGE.family,
    epoch: 1,
    reason: null,
    retryable: false,
    version: null,
  };
  const { container } = render(
    <TextControls customization={defaultCustomization} onChange={vi.fn()} />,
  );
  const selector = container.querySelector('.font-selector-button');
  expect(selector).toHaveAttribute('data-font-selection-status', 'unavailable');

  fireEvent.click(selector);
  expect([...container.querySelectorAll('.font-card .font-name')]
    .some(node => node.textContent === 'Google Sans')).toBe(false);

  act(() => {
    window.dispatchEvent(new CustomEvent(FONT_READINESS_EVENT, {
      detail: {
        schema: 1,
        state: 'ready',
        family: MANAGED_FONT_PACKAGE.family,
        epoch: 2,
        reason: null,
        retryable: false,
        version: MANAGED_FONT_PACKAGE.version,
      },
    }));
  });

  await waitFor(() => expect(selector).toHaveAttribute('data-font-selection-status', 'exact'));
  await waitFor(() => expect([...container.querySelectorAll('.font-card .font-name')]
    .some(node => node.textContent === 'Google Sans')).toBe(true));
});
