import { createFullMediaStreamingHandler } from './subtitleStreamingHandlers';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('ignores untimed Live text completely while preserving timed subtitle updates', () => {
  const publishRows = vi.fn();
  const handler = createFullMediaStreamingHandler(publishRows, vi.fn());
  const draft = (index, text) => handler([], true, {
    projectId: 'project',
    liveDraft: { windowIndex: index, windowStartMs: index * 60_000, windowEndMs: (index + 1) * 60_000, totalWindows: 4, text },
  });
  draft(3, 'fourth window');
  draft(0, 'first');
  draft(0, 'first window growing');
  vi.advanceTimersByTime(150);
  expect(publishRows).not.toHaveBeenCalled();
  handler([{ start: 1, end: 2, text: 'timed' }], true, { segmentComplete: true, segmentIndex: 0 });
  expect(publishRows).toHaveBeenLastCalledWith([{ start: 1, end: 2, text: 'timed' }]);
  handler.cancel();
  vi.advanceTimersByTime(1000);
  expect(publishRows).toHaveBeenCalledTimes(1);
});

test('a terminal callback cancels an older throttled partial update', () => {
  const setSubtitlesData = vi.fn();
  const setStatus = vi.fn();
  const handler = createFullMediaStreamingHandler(
    setSubtitlesData,
    setStatus,
    (_key, fallback) => fallback,
  );
  const first = [{ start: 0, end: 1, text: 'first' }];
  const stale = [{ start: 0, end: 1, text: 'stale' }];
  const finalRows = [{ start: 0, end: 2, text: 'final' }];

  handler(first, true);
  vi.advanceTimersByTime(100);
  handler(stale, true);
  handler(finalRows, false);
  vi.advanceTimersByTime(1_000);

  expect(setSubtitlesData).toHaveBeenCalledTimes(2);
  expect(setSubtitlesData).toHaveBeenLastCalledWith(finalRows);
});

test('cancelling provider work prevents a delayed partial from publishing after failure', () => {
  const setSubtitlesData = vi.fn();
  const handler = createFullMediaStreamingHandler(
    setSubtitlesData,
    vi.fn(),
    (_key, fallback) => fallback,
  );

  handler([{ start: 0, end: 1, text: 'first' }], true);
  vi.advanceTimersByTime(100);
  handler([{ start: 0, end: 1, text: 'pending' }], true);
  handler.cancel();
  vi.advanceTimersByTime(1_000);

  expect(setSubtitlesData).toHaveBeenCalledTimes(1);
});

test('native streaming publishes partial rows and restores the durable baseline on failure', () => {
  const setSubtitlesData = vi.fn();
  const setStatus = vi.fn();
  const baseline = [{ start: 0, end: 1, text: 'durable' }];
  const partial = [{ start: 0, end: 1, text: 'partial' }];
  const handler = createFullMediaStreamingHandler(
    setSubtitlesData,
    setStatus,
    (_key, fallback) => fallback,
    { rollbackRows: baseline },
  );
  handler(partial, true);
  expect(setSubtitlesData).toHaveBeenLastCalledWith(partial);
  expect(setStatus).toHaveBeenCalledWith({ message: 'Streaming...', type: 'loading' });
  handler.rollback();
  expect(setSubtitlesData).toHaveBeenLastCalledWith(baseline);
});

test('timed window updates reach subtitle state and cannot be obscured by later untimed drafts', () => {
  const publish = vi.fn();
  const baseline = [{ start: 0, end: 1, text: 'original' }];
  const handler = createFullMediaStreamingHandler(publish, vi.fn(), undefined, { rollbackRows: baseline });
  const draft = { windowIndex: 1, text: 'draft', windowStartMs: 60000, windowEndMs: 120000 };
  handler([], true, { projectId: 'project', liveDraft: draft });
  vi.advanceTimersByTime(150);
  const timed = [{ start: 61, end: 62, text: 'timed' }];
  handler(timed, true, { timedWindowIndex: 1 });
  handler(timed, true, { projectId: 'project', liveDraft: draft });
  vi.advanceTimersByTime(500);
  expect(publish).toHaveBeenLastCalledWith(timed);
  handler.rollback();
  expect(publish).toHaveBeenLastCalledWith(baseline);
});
