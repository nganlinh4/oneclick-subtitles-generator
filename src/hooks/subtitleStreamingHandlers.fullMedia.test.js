import { createFullMediaStreamingHandler } from './subtitleStreamingHandlers';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

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
