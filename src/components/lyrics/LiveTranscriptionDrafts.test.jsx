import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { beginLiveDrafts } from '../../platform/liveTranscriptionDrafts';
import LiveTranscriptionDrafts from './LiveTranscriptionDrafts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key) => key }),
}));

let session;
afterEach(() => {
  session?.dispose();
  session = undefined;
  vi.useRealTimers();
});

test('keeps every active window visibly separate before and during Live text', () => {
  vi.useFakeTimers();
  render(<LiveTranscriptionDrafts />);
  session = beginLiveDrafts('project-a');

  act(() => {
    session.open(0, { totalWindows: 4, windowStartMs: 0, windowEndMs: 60_000 });
    session.open(1, { totalWindows: 4, windowStartMs: 60_000, windowEndMs: 120_000 });
  });

  expect(screen.getByText('1/4')).toBeVisible();
  expect(screen.getByText('0:00 – 1:00')).toBeVisible();
  expect(screen.getByText('2/4')).toBeVisible();
  expect(screen.getByText('1:00 – 2:00')).toBeVisible();
  expect(screen.getAllByText('processing.liveDraftListening')).toHaveLength(2);

  act(() => {
    session.update(1, 'second window words', {
      totalWindows: 4,
      windowStartMs: 60_000,
      windowEndMs: 120_000,
    });
    vi.advanceTimersByTime(150);
  });
  expect(screen.getByText('second window words')).toBeVisible();
  expect(document.querySelector('.live-transcription-drafts-panel')).not.toBeNull();
});
