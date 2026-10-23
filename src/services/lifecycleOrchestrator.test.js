import { CHECKPOINT_SOURCE } from '../events/constants';
import { flushDurableLyricsHistory } from '../platform/durableLyricsCheckpoint';
import {
  CHECKPOINT_TIMEOUT_MS,
  CheckpointBeforeUpdateError,
  checkpointBeforeUpdate,
} from './lifecycleOrchestrator';

vi.mock('../platform/durableLyricsCheckpoint', () => ({
  flushDurableLyricsHistory: vi.fn(),
}));

beforeEach(() => {
  flushDurableLyricsHistory.mockReset();
  flushDurableLyricsHistory.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

it('uses one bounded 15-second production checkpoint deadline', () => {
  expect(CHECKPOINT_TIMEOUT_MS).toBe(15_000);
});

it.each([
  CHECKPOINT_SOURCE.SEGMENT_PROCESSING_START,
  CHECKPOINT_SOURCE.AUTO_GENERATION_START,
  CHECKPOINT_SOURCE.TRANSLATION_START,
])('resolves %s once the durable editor owner has flushed', async (source) => {
  await expect(checkpointBeforeUpdate({ source, runId: 'run-1' }, 100)).resolves.toBeUndefined();
  expect(flushDurableLyricsHistory).toHaveBeenCalledTimes(1);
});

it('refuses an unknown checkpoint source before flushing', () => {
  expect(() => checkpointBeforeUpdate({ source: 'manual' }, 100)).toThrow(TypeError);
  expect(flushDurableLyricsHistory).not.toHaveBeenCalled();
});

it('rejects a pending checkpoint immediately when its owning run stops', async () => {
  vi.useFakeTimers();
  flushDurableLyricsHistory.mockReturnValue(new Promise(() => {}));
  const controller = new AbortController();
  const checkpoint = checkpointBeforeUpdate({
    source: 'auto-generation-start',
    runId: 'auto-run-stop',
    signal: controller.signal,
  });

  controller.abort();

  await expect(checkpoint).rejects.toMatchObject({
    name: 'AbortError',
    code: 'autoGenerationAborted',
  });
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects a failed flush without reflecting its raw error', async () => {
  flushDurableLyricsHistory.mockRejectedValue(new Error('C:\\private\\media\\secret-token.txt'));

  const failure = checkpointBeforeUpdate({ source: 'video-processing-complete' }, 100);
  await expect(failure).rejects.toMatchObject({
    name: 'CheckpointBeforeUpdateError',
    code: 'checkpointSaveFailed',
    message: 'The subtitle checkpoint could not be saved',
  });
  await failure.catch((error) => {
    expect(error).toBeInstanceOf(CheckpointBeforeUpdateError);
    expect(String(error)).not.toContain('private');
    expect(String(error)).not.toContain('secret-token');
  });
});

it('rejects on timeout when the flush never settles', async () => {
  vi.useFakeTimers();
  flushDurableLyricsHistory.mockReturnValue(new Promise(() => {}));

  const checkpoint = checkpointBeforeUpdate({ source: 'segment-processing-start' }, 25);
  const rejection = expect(checkpoint).rejects.toMatchObject({
    code: 'checkpointSaveTimedOut',
    message: 'The subtitle checkpoint did not complete in time',
  });
  await vi.advanceTimersByTimeAsync(25);
  await rejection;
});
