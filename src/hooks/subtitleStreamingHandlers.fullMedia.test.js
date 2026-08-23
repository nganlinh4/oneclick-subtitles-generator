import {
  createFullMediaStreamingHandler,
  createStagedFullMediaStreamingHandler,
} from './subtitleStreamingHandlers';

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

test('native staging reports progress without publishing uncommitted rows', () => {
  const setStatus = vi.fn();
  const handler = createStagedFullMediaStreamingHandler(
    setStatus,
    (_key, fallback) => fallback,
  );
  handler([{ start: 0, end: 1, text: 'partial' }], true);
  expect(setStatus).toHaveBeenCalledWith({ message: 'Streaming...', type: 'loading' });
});
