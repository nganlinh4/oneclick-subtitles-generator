const mocks = vi.hoisted(() => ({
  rulesCacheId: 'cache-a',
  subtitlesCacheId: 'cache-a',
  projectId: 'project-a',
  resolveProjectForCache: vi.fn(),
}));

vi.mock('./transcriptionRulesStore', () => ({
  getCurrentCacheId: () => mocks.rulesCacheId,
}));
vi.mock('./userSubtitlesStore', () => ({
  getCurrentCacheId: () => mocks.subtitlesCacheId,
}));
vi.mock('../platform/subtitleProjectStore', () => ({
  resolveProjectForCache: mocks.resolveProjectForCache,
}));

import {
  SubtitleOperationOwnershipError,
  acquireSubtitleProjectOperationLease,
  abortableSubtitleOperationDelay,
  assertSubtitleOperationCurrent,
  assertSubtitleOperationDurable,
  captureSubtitleOperationContext,
  finishSubtitleOperationContext,
  releaseSubtitleProjectOperationLease,
} from './subtitleOperationOwnership';

const capture = (runId = 'run-a', segment = { start: 4, end: 8 }) => {
  const controller = new AbortController();
  return captureSubtitleOperationContext({ runId, segment, controller });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  localStorage.setItem('current_file_cache_id', 'asset-a');
  mocks.rulesCacheId = 'cache-a';
  mocks.subtitlesCacheId = 'cache-a';
  mocks.projectId = 'project-a';
  mocks.resolveProjectForCache.mockImplementation(async () => ({
    projectId: mocks.projectId,
  }));
});

test('captures an immutable run and rejects a same-project same-segment duplicate', async () => {
  const first = await capture();

  await expect(capture('run-b')).rejects.toMatchObject({
    code: 'subtitleOperationAlreadyActive',
  });
  expect(Object.isFrozen(first)).toBe(true);
  expect(first).toMatchObject({
    runId: 'run-a',
    cacheId: 'cache-a',
    projectId: 'project-a',
    sourceIdentity: 'asset:asset-a',
    segment: { start: 4, end: 8 },
  });

  expect(finishSubtitleOperationContext(first)).toBe(true);
  const next = await capture('run-c');
  expect(next).toMatchObject({ runId: 'run-c' });
  finishSubtitleOperationContext(next);
});

test.each([
  ['rules cache switch', () => { mocks.rulesCacheId = 'cache-b'; }],
  ['subtitle cache switch', () => { mocks.subtitlesCacheId = 'cache-b'; }],
  ['source switch', () => { localStorage.setItem('current_file_cache_id', 'asset-b'); }],
  ['URL takeover', () => { localStorage.setItem('current_video_url', 'https://example.test/b'); }],
])('rejects %s after capture', async (_name, mutate) => {
  const context = await capture();
  mutate();
  expect(() => assertSubtitleOperationCurrent(context)).toThrow(SubtitleOperationOwnershipError);
  finishSubtitleOperationContext(context);
});

test('re-resolves the durable alias and rejects a post-capture remap', async () => {
  const context = await capture();
  mocks.projectId = 'project-b';

  await expect(assertSubtitleOperationDurable(context)).rejects.toMatchObject({
    code: 'subtitleOperationOwnershipLost',
  });
  expect(mocks.resolveProjectForCache).toHaveBeenLastCalledWith('cache-a', { create: false });
  finishSubtitleOperationContext(context);
});

test('keeps unrelated segment ownership independent when one operation stops', async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = await captureSubtitleOperationContext({
    runId: 'run-first',
    segment: { start: 4, end: 8 },
    controller: firstController,
  });
  const second = await captureSubtitleOperationContext({
    runId: 'run-second',
    segment: { start: 9, end: 12 },
    controller: secondController,
  });

  firstController.abort();
  expect(() => assertSubtitleOperationCurrent(first)).toThrow();
  expect(assertSubtitleOperationCurrent(second)).toBe(second);
  expect(second.signal.aborted).toBe(false);

  finishSubtitleOperationContext(first);
  finishSubtitleOperationContext(second);
});

test('serializes same-project retry transactions without cross-cancelling the queued segment', async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = await captureSubtitleOperationContext({
    runId: 'run-first',
    segment: { start: 4, end: 8 },
    controller: firstController,
  });
  const second = await captureSubtitleOperationContext({
    runId: 'run-second',
    segment: { start: 9, end: 12 },
    controller: secondController,
  });
  const firstLease = await acquireSubtitleProjectOperationLease(first);
  let secondSettled = false;
  const pendingSecond = acquireSubtitleProjectOperationLease(second).then((lease) => {
    secondSettled = true;
    return lease;
  });
  await Promise.resolve();
  expect(secondSettled).toBe(false);

  releaseSubtitleProjectOperationLease(firstLease);
  const secondLease = await pendingSecond;
  expect(secondSettled).toBe(true);
  expect(secondController.signal.aborted).toBe(false);

  releaseSubtitleProjectOperationLease(secondLease);
  finishSubtitleOperationContext(first);
  finishSubtitleOperationContext(second);
});

test('keeps durable retry leases for different projects fully independent', async () => {
  const firstController = new AbortController();
  const first = await captureSubtitleOperationContext({
    runId: 'run-project-a',
    segment: { start: 4, end: 8 },
    controller: firstController,
  });
  const firstLease = await acquireSubtitleProjectOperationLease(first);

  mocks.rulesCacheId = 'cache-b';
  mocks.subtitlesCacheId = 'cache-b';
  mocks.projectId = 'project-b';
  localStorage.setItem('current_file_cache_id', 'asset-b');
  const secondController = new AbortController();
  const second = await captureSubtitleOperationContext({
    runId: 'run-project-b',
    segment: { start: 4, end: 8 },
    controller: secondController,
  });
  let secondSettled = false;
  const secondLease = await acquireSubtitleProjectOperationLease(second).then((lease) => {
    secondSettled = true;
    return lease;
  });

  expect(secondSettled).toBe(true);
  expect(second.projectId).toBe('project-b');
  releaseSubtitleProjectOperationLease(secondLease);
  releaseSubtitleProjectOperationLease(firstLease);
  finishSubtitleOperationContext(first);
  finishSubtitleOperationContext(second);
});

test('aborting a queued project lease leaves the active operation untouched', async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = await captureSubtitleOperationContext({
    runId: 'run-first',
    segment: { start: 4, end: 8 },
    controller: firstController,
  });
  const second = await captureSubtitleOperationContext({
    runId: 'run-second',
    segment: { start: 9, end: 12 },
    controller: secondController,
  });
  const firstLease = await acquireSubtitleProjectOperationLease(first);
  const pendingSecond = acquireSubtitleProjectOperationLease(second);

  secondController.abort();
  await expect(pendingSecond).rejects.toMatchObject({
    code: 'subtitleOperationAborted',
  });
  expect(firstController.signal.aborted).toBe(false);
  expect(assertSubtitleOperationCurrent(first)).toBe(first);

  releaseSubtitleProjectOperationLease(firstLease);
  finishSubtitleOperationContext(first);
  finishSubtitleOperationContext(second);
});

test('aborted retry waits settle promptly without leaving their timer active', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const pending = abortableSubtitleOperationDelay(25_000, controller.signal);

  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(vi.getTimerCount()).toBe(0);
});
