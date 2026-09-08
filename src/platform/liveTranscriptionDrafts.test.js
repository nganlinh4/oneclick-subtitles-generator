import { beginLiveDrafts, getLiveDrafts } from './liveTranscriptionDrafts';

test('Live replaces drafts, orders parallel windows, and rejects late events after promotion or cancellation', () => {
  vi.useFakeTimers();
  const session = beginLiveDrafts('project-a');
  session.update(1, 'second');
  session.update(0, 'hel');
  session.update(0, 'hello');
  vi.advanceTimersByTime(150);
  expect(getLiveDrafts().map((row) => row.text)).toEqual(['hello', 'second']);
  session.finalize(0);
  session.update(0, 'late overwrite');
  vi.advanceTimersByTime(150);
  expect(getLiveDrafts().map((row) => row.text)).toEqual(['second']);
  session.dispose();
  session.update(1, 'late cancellation');
  vi.advanceTimersByTime(150);
  expect(getLiveDrafts()).toEqual([]);
  vi.useRealTimers();
});
