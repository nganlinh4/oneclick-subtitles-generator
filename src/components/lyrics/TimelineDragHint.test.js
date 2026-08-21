import { act, render, screen } from '@testing-library/react';

import TimelineDragHint from './TimelineDragHint';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('the empty-timeline gesture hint never obscures existing subtitle cues', () => {
  render(
    <TimelineDragHint
      onSegmentSelect={() => {}}
      hasDraggedInSession={false}
      hasLyrics
      t={(_key, fallback) => fallback}
    />,
  );

  act(() => vi.advanceTimersByTime(3_000));

  expect(screen.queryByText('(or Ctrl+A)')).not.toBeInTheDocument();
});

test('the gesture hint still teaches selection on a genuinely empty timeline', () => {
  render(
    <TimelineDragHint
      onSegmentSelect={() => {}}
      hasDraggedInSession={false}
      hasLyrics={false}
      t={(_key, fallback) => fallback}
    />,
  );

  act(() => vi.advanceTimersByTime(2_100));

  expect(screen.getByText('(or Ctrl+A)')).toBeInTheDocument();
});
