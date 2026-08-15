import {
  assertListenerLive,
  attachAbortBinding,
  detachAbortBinding,
  replayListenerCallback,
} from './nativeUrlDownloadSubscriber';

const createListener = (overrides = {}) => ({
  aborted: false,
  handleAbort: null,
  onProgress: undefined,
  onStarted: undefined,
  onSubtitle: undefined,
  settlementError: null,
  settled: false,
  signalAttached: false,
  signalBinding: null,
  validateOwnership: undefined,
  ...overrides,
});

const createBinding = (overrides = {}) => ({
  add: vi.fn(),
  remove: vi.fn(),
  target: { aborted: false },
  ...overrides,
});

it('treats a live subscriber with no validator as owned', async () => {
  await expect(assertListenerLive(createListener())).resolves.toBeUndefined();
});

it('raises the settlement error a subscriber was rejected with', async () => {
  const settlementError = Object.assign(new Error('source switched'), {
    code: 'autoGenerationOwnershipLost',
  });
  await expect(assertListenerLive(createListener({ settled: true, settlementError })))
    .rejects.toBe(settlementError);
});

it.each([
  ['a settled subscriber with no recorded error', { settled: true }],
  ['an aborted subscriber', { aborted: true }],
])('raises a fixed abort for %s', async (_label, overrides) => {
  await expect(assertListenerLive(createListener(overrides))).rejects.toMatchObject({
    name: 'AbortError',
    code: 'nativeDownloadAborted',
  });
});

it('propagates an ownership validator rejection unchanged', async () => {
  const ownershipError = Object.assign(new Error('run replaced'), {
    code: 'autoGenerationOwnershipLost',
  });
  const listener = createListener({
    validateOwnership: () => { throw ownershipError; },
  });
  await expect(assertListenerLive(listener)).rejects.toBe(ownershipError);
});

it('re-checks liveness after the ownership validator resolves', async () => {
  const listener = createListener();
  listener.validateOwnership = () => { listener.aborted = true; };
  await expect(assertListenerLive(listener)).rejects.toMatchObject({ name: 'AbortError' });
});

it('replays a callback between two liveness checks', async () => {
  const order = [];
  const listener = createListener({
    onProgress: (value) => { order.push(`progress:${value}`); },
    validateOwnership: () => { order.push('ownership'); },
  });

  await replayListenerCallback(listener, 'onProgress', 42);

  expect(order).toEqual(['ownership', 'progress:42', 'ownership']);
});

it('skips a missing callback without failing', async () => {
  await expect(replayListenerCallback(createListener(), 'onSubtitle', null))
    .resolves.toBeUndefined();
});

it('collapses a throwing subscriber callback to a fixed failure', async () => {
  const listener = createListener({
    onProgress: () => { throw new Error('subscriber internals'); },
  });
  await expect(replayListenerCallback(listener, 'onProgress', 1)).rejects.toMatchObject({
    name: 'NativeUrlDownloadError',
    code: 'downloadCallbackFailed',
  });
});

it('does not replay to a subscriber that lost ownership first', async () => {
  const onProgress = vi.fn();
  const listener = createListener({
    onProgress,
    validateOwnership: () => { throw new Error('lost'); },
  });
  await expect(replayListenerCallback(listener, 'onProgress', 1)).rejects.toThrow('lost');
  expect(onProgress).not.toHaveBeenCalled();
});

it('attaches nothing when the request carried no signal', () => {
  const listener = createListener();
  expect(() => attachAbortBinding(listener, null, () => undefined)).not.toThrow();
  expect(listener.signalAttached).toBe(false);
});

it('attaches once and records the binding', () => {
  const listener = createListener();
  const binding = createBinding();
  const onAbort = vi.fn();

  attachAbortBinding(listener, binding, onAbort);

  expect(binding.add).toHaveBeenCalledExactlyOnceWith('abort', onAbort, { once: true });
  expect(listener.signalAttached).toBe(true);
  expect(onAbort).not.toHaveBeenCalled();
});

it('fires the handler immediately for an already-aborted signal', () => {
  const listener = createListener();
  const binding = createBinding({ target: { aborted: true } });
  const onAbort = vi.fn();

  attachAbortBinding(listener, binding, onAbort);

  expect(onAbort).toHaveBeenCalledOnce();
  expect(listener.signalAttached).toBe(true);
});

it.each([
  ['registration throws', () => createBinding({
    add: vi.fn(() => { throw new Error('hostile add'); }),
  })],
  ['aborted is not a boolean', () => createBinding({ target: { aborted: 'yes' } })],
  ['aborted throws', () => createBinding({
    target: new Proxy({}, { get() { throw new Error('hostile aborted'); } }),
  })],
])('rolls registration back when %s', (_label, build) => {
  const listener = createListener();
  const binding = build();
  const onAbort = vi.fn();

  expect(() => attachAbortBinding(listener, binding, onAbort)).toThrow(
    expect.objectContaining({ code: 'invalidDownloadRequest' })
  );
  expect(listener.signalAttached).toBe(false);
  expect(binding.remove).toHaveBeenCalledWith('abort', onAbort);
});

it('still raises the fixed failure when hostile cleanup also throws', () => {
  const listener = createListener();
  const binding = createBinding({
    target: { aborted: 'yes' },
    remove: vi.fn(() => { throw new Error('hostile remove'); }),
  });

  expect(() => attachAbortBinding(listener, binding, vi.fn())).toThrow(
    expect.objectContaining({ code: 'invalidDownloadRequest' })
  );
  expect(listener.signalAttached).toBe(false);
});

it('detaches exactly once and tolerates a hostile remove', () => {
  const handleAbort = vi.fn();
  const remove = vi.fn(() => { throw new Error('hostile remove'); });
  const listener = createListener({
    handleAbort,
    signalAttached: true,
    signalBinding: createBinding({ remove }),
  });

  expect(() => detachAbortBinding(listener)).not.toThrow();
  expect(listener.signalAttached).toBe(false);
  expect(remove).toHaveBeenCalledExactlyOnceWith('abort', handleAbort);

  detachAbortBinding(listener);
  expect(remove).toHaveBeenCalledOnce();
});

it('detaching an unattached subscriber never touches the signal', () => {
  const binding = createBinding();
  detachAbortBinding(createListener({ signalBinding: binding }));
  expect(binding.remove).not.toHaveBeenCalled();
});
