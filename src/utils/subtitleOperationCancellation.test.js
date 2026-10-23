import { isSubtitleOperationCancellation } from './subtitleOperationCancellation';

test('only an AbortError counts as a user cancellation', () => {
  const aborted = new Error('stopped');
  aborted.name = 'AbortError';
  expect(isSubtitleOperationCancellation(aborted)).toBe(true);
  expect(isSubtitleOperationCancellation(new Error('quota exceeded'))).toBe(false);
  expect(isSubtitleOperationCancellation(null)).toBe(false);
});
