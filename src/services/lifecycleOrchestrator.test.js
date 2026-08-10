import { EVENTS } from '../events/constants';
import {
  CHECKPOINT_TIMEOUT_MS,
  CheckpointBeforeUpdateError,
  checkpointBeforeUpdate,
} from './lifecycleOrchestrator';

const respondToCheckpoint = (detailFor) => {
  const listener = (event) => {
    window.removeEventListener(EVENTS.SAVE_BEFORE_UPDATE, listener);
    window.dispatchEvent(new CustomEvent(EVENTS.SAVE_COMPLETE, {
      detail: detailFor(event.detail),
    }));
  };
  window.addEventListener(EVENTS.SAVE_BEFORE_UPDATE, listener);
  return () => window.removeEventListener(EVENTS.SAVE_BEFORE_UPDATE, listener);
};

afterEach(() => {
  vi.useRealTimers();
});

it('uses one bounded 15-second production checkpoint deadline', () => {
  expect(CHECKPOINT_TIMEOUT_MS).toBe(15_000);
});

it('resolves only an exactly successful response for the matching checkpoint', async () => {
  const removeListener = respondToCheckpoint((request) => {
    expect(request.checkpointId).toMatch(/^checkpoint-[0-9a-z]{10}-[0-9a-z]{6}$/);
    return {
      source: request.source,
      checkpointId: request.checkpointId,
      success: true,
    };
  });

  await expect(checkpointBeforeUpdate({
    source: 'segment-processing-start',
    segment: { start: 1, end: 2 },
    runId: 'run-1',
  }, 100)).resolves.toBeUndefined();
  removeListener();
});

it.each([false, 'true', 1, undefined])(
  'rejects a matched checkpoint whose success is %j without reflecting its raw error',
  async (success) => {
    const removeListener = respondToCheckpoint((request) => ({
      source: request.source,
      checkpointId: request.checkpointId,
      success,
      error: 'C:\\private\\media\\secret-token.txt',
    }));

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
    removeListener();
  }
);

it('ignores another checkpoint response and rejects on timeout', async () => {
  vi.useFakeTimers();
  const listener = (event) => {
    window.dispatchEvent(new CustomEvent(EVENTS.SAVE_COMPLETE, {
      detail: {
        source: event.detail.source,
        checkpointId: `${event.detail.checkpointId}-other`,
        success: true,
      },
    }));
  };
  window.addEventListener(EVENTS.SAVE_BEFORE_UPDATE, listener);

  const checkpoint = checkpointBeforeUpdate({ source: 'segment-processing-start' }, 25);
  const rejection = expect(checkpoint).rejects.toMatchObject({
    code: 'checkpointSaveTimedOut',
    message: 'The subtitle checkpoint did not complete in time',
  });
  await vi.advanceTimersByTimeAsync(25);
  await rejection;
  window.removeEventListener(EVENTS.SAVE_BEFORE_UPDATE, listener);
});
