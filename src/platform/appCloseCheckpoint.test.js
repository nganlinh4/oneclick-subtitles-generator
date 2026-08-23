import {
  CLOSE_CHECKPOINT_HANDLER,
  CLOSE_CHECKPOINT_PENDING,
  installAppCloseCheckpoint,
} from './appCloseCheckpoint';

const NONCE = '93f7d7b5-a1c1-41d5-a27f-0c849d9ab8b5';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

afterEach(() => {
  delete window[CLOSE_CHECKPOINT_HANDLER];
  delete window[CLOSE_CHECKPOINT_PENDING];
});

test('arms native close only after the durable editor queue finishes', async () => {
  const pending = deferred();
  const flush = vi.fn(() => pending.promise);
  const invoke = vi.fn().mockResolvedValue(true);
  installAppCloseCheckpoint({ nativeRuntime: () => true, flush, invoke });

  window[CLOSE_CHECKPOINT_HANDLER](NONCE);
  expect(flush).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalled();
  pending.resolve();

  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
    'app_close_checkpoint_complete',
    { nonce: NONCE },
  ));
  expect(invoke).toHaveBeenCalledWith('app_close_checkpoint_commit', { nonce: NONCE });
  expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder[1]);
});

test('replays a native close that arrived before the JavaScript bundle installed', async () => {
  window[CLOSE_CHECKPOINT_PENDING] = NONCE;
  const invoke = vi.fn().mockResolvedValue(true);
  installAppCloseCheckpoint({
    nativeRuntime: () => true,
    flush: vi.fn().mockResolvedValue(undefined),
    invoke,
  });

  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
    'app_close_checkpoint_complete',
    { nonce: NONCE },
  ));
  expect(invoke).toHaveBeenCalledWith('app_close_checkpoint_commit', { nonce: NONCE });
  expect(window[CLOSE_CHECKPOINT_PENDING]).toBeUndefined();
});

test('a failed durable write releases the attempt but never grants close', async () => {
  window[CLOSE_CHECKPOINT_PENDING] = NONCE;
  const invoke = vi.fn().mockResolvedValue(true);
  const showFailure = vi.fn();
  installAppCloseCheckpoint({
    nativeRuntime: () => true,
    flush: vi.fn().mockRejectedValue(new Error('database unavailable')),
    invoke,
    showFailure,
  });

  await vi.waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith(
    'app_close_checkpoint_failed',
    { nonce: NONCE },
  ));
  expect(invoke).not.toHaveBeenCalledWith('app_close_checkpoint_complete', expect.anything());
  expect(showFailure).toHaveBeenCalledTimes(1);
  expect(window[CLOSE_CHECKPOINT_PENDING]).toBeUndefined();
});

test('an explicit native close refusal is visible and cannot be mistaken for success', async () => {
  const invoke = vi.fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  const showFailure = vi.fn();
  installAppCloseCheckpoint({
    nativeRuntime: () => true,
    flush: vi.fn().mockResolvedValue(undefined),
    invoke,
    showFailure,
  });

  window[CLOSE_CHECKPOINT_HANDLER](NONCE);

  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith(
    'app_close_checkpoint_commit',
    { nonce: NONCE },
  ));
  await vi.waitFor(() => expect(showFailure).toHaveBeenCalledTimes(1));
});

test('repeated close dispatches share one in-flight checkpoint', async () => {
  const pending = deferred();
  const flush = vi.fn(() => pending.promise);
  const invoke = vi.fn().mockResolvedValue(true);
  installAppCloseCheckpoint({ nativeRuntime: () => true, flush, invoke });

  window[CLOSE_CHECKPOINT_HANDLER](NONCE);
  window[CLOSE_CHECKPOINT_HANDLER](NONCE);
  expect(flush).toHaveBeenCalledTimes(1);
  pending.resolve();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
});

test('a hung editor queue times out into a retryable refusal rather than trapping close forever', async () => {
  let expire;
  const schedule = vi.fn((callback) => {
    expire = callback;
    return 17;
  });
  const cancel = vi.fn();
  const invoke = vi.fn().mockResolvedValue(true);
  const showFailure = vi.fn();
  installAppCloseCheckpoint({
    nativeRuntime: () => true,
    flush: () => new Promise(() => undefined),
    invoke,
    schedule,
    cancel,
    showFailure,
    timeoutMs: 25,
  });

  window[CLOSE_CHECKPOINT_HANDLER](NONCE);
  expect(schedule).toHaveBeenCalledWith(expect.any(Function), 25);
  expire();

  await vi.waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith(
    'app_close_checkpoint_failed',
    { nonce: NONCE },
  ));
  expect(invoke).not.toHaveBeenCalledWith('app_close_checkpoint_complete', expect.anything());
  expect(cancel).not.toHaveBeenCalled();
  expect(showFailure).toHaveBeenCalledTimes(1);
});

test('browser mode and malformed capabilities cannot invoke a desktop command', async () => {
  const invoke = vi.fn();
  const flush = vi.fn();
  const dispose = installAppCloseCheckpoint({
    nativeRuntime: () => false,
    flush,
    invoke,
  });
  expect(window[CLOSE_CHECKPOINT_HANDLER]).toBeUndefined();
  dispose();

  installAppCloseCheckpoint({ nativeRuntime: () => true, flush, invoke });
  window[CLOSE_CHECKPOINT_HANDLER]('not-a-capability');
  await Promise.resolve();
  expect(flush).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});
