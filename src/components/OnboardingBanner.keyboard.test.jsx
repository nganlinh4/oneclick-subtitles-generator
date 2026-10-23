import { act, fireEvent, render, screen } from '@testing-library/react';

import OnboardingBanner from './OnboardingBanner';
import { readPreference, writePreference } from '../platform/preferences/store';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('../assets/onboarding-banner', () => ({ default: () => <svg /> }));
vi.mock('./OnboardingCursorInteraction', () => ({ default: ({ children }) => <>{children}</> }));
vi.mock('../platform/preferences/store', () => ({
  readPreference: vi.fn(),
  writePreference: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  readPreference.mockReturnValue(false);
  writePreference.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const finishCountdown = () => act(() => { vi.advanceTimersByTime(4000); });

test('the first-run banner ignores keys until its countdown ends', () => {
  render(<OnboardingBanner />);
  expect(screen.getByText(/Please wait/)).toHaveTextContent('Please wait 4seconds...');

  fireEvent.keyDown(window, { key: 'Enter' });
  act(() => { vi.advanceTimersByTime(2200); });
  expect(writePreference).not.toHaveBeenCalled();
});

test.each(['Enter', ' ', 'Escape'])('%j dismisses the first-run banner once it can be dismissed', (key) => {
  const { container } = render(<OnboardingBanner />);
  finishCountdown();
  expect(screen.getByText('Click anywhere to continue')).toBeInTheDocument();

  fireEvent.keyDown(window, { key });
  expect(container.querySelector('.onboarding-overlay')).toHaveClass('dismissing');

  act(() => { vi.advanceTimersByTime(2200); });
  expect(writePreference).toHaveBeenCalledWith('has_visited_site', true);
  expect(container.querySelector('.onboarding-overlay')).toBeNull();
});
