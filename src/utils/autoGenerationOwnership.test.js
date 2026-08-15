const mocks = vi.hoisted(() => ({
  rulesCacheId: 'cache-1',
  subtitlesCacheId: 'cache-1',
  resolveProjectForCache: vi.fn(),
  saveProjectSubtitles: vi.fn(),
  clearProjectSubtitles: vi.fn(),
  cacheListeners: new Set(),
}));

vi.mock('./transcriptionRulesStore', () => ({
  getCurrentCacheId: vi.fn(() => mocks.rulesCacheId),
}));
vi.mock('./userSubtitlesStore', () => ({
  getCurrentCacheId: vi.fn(() => mocks.subtitlesCacheId),
  subscribeCurrentCacheId: vi.fn((listener) => {
    mocks.cacheListeners.add(listener);
    return () => mocks.cacheListeners.delete(listener);
  }),
}));
vi.mock('../platform/subtitleProjectStore', () => ({
  resolveProjectForCache: mocks.resolveProjectForCache,
  saveProjectSubtitles: mocks.saveProjectSubtitles,
  clearProjectSubtitles: mocks.clearProjectSubtitles,
  loadProjectSubtitles: vi.fn(),
}));

import { commitDurableSubtitleCheckpoint } from '../services/subtitleCache';

import {
  assertAutoGenerationContextCurrent,
  assertAutoGenerationContextDurable,
  createAutoGenerationCompletion,
  createAutoGenerationContext,
  createAutoGenerationRequest,
  createPreparedAutoMedia,
  getAutoGenerationCacheCandidate,
  isAutoGenerationCompletion,
  subscribeAutoGenerationOwnership,
} from './autoGenerationOwnership';

const createContext = (cachedSubtitles = null) => {
  const controller = new AbortController();
  const request = createAutoGenerationRequest({ runId: 'run-1', signal: controller.signal });
  const media = Object.freeze({ assetId: 'asset-1', type: 'video/mp4' });
  const prepared = createPreparedAutoMedia({
    request,
    media,
    cacheId: 'cache-1',
    projectId: 'project-1',
    sourceIdentity: 'asset:asset-1',
    cachedSubtitles,
  });
  return { controller, media, request, prepared, context: createAutoGenerationContext(prepared) };
};

beforeEach(() => {
  mocks.rulesCacheId = 'cache-1';
  mocks.subtitlesCacheId = 'cache-1';
  mocks.resolveProjectForCache.mockReset();
  mocks.resolveProjectForCache.mockResolvedValue({ projectId: 'project-1' });
  mocks.saveProjectSubtitles.mockReset();
  mocks.saveProjectSubtitles.mockResolvedValue({ metadata: { id: 'project-1' } });
  mocks.clearProjectSubtitles.mockReset();
  mocks.clearProjectSubtitles.mockResolvedValue(true);
  mocks.cacheListeners.clear();
  localStorage.clear();
  localStorage.setItem('current_file_cache_id', 'asset-1');
});

test('the active-run watcher reports a source-only switch and detaches after loss', async () => {
  vi.useFakeTimers();
  const { context } = createContext();
  const onLost = vi.fn();
  const unsubscribe = subscribeAutoGenerationOwnership(context, onLost, {
    pollIntervalMs: 10,
  });

  localStorage.setItem('current_file_cache_id', 'asset-2');
  await vi.advanceTimersByTimeAsync(10);

  expect(onLost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    code: 'autoGenerationOwnershipLost',
  }));
  unsubscribe();
  await vi.advanceTimersByTimeAsync(50);
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

test('freezes one authoritative media/project/signal receipt for the whole run', () => {
  const { context, media, prepared, request } = createContext();

  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(Object.isFrozen(context)).toBe(true);
  expect(context).toMatchObject({
    runId: 'run-1',
    media,
    cacheId: 'cache-1',
    projectId: 'project-1',
    sourceIdentity: 'asset:asset-1',
  });
});

test('keeps the preparation cache candidate immutable and rejects structural context copies', () => {
  const rows = [{ id: 1, start: 0, end: 1, text: 'Captured' }];
  const { context } = createContext(rows);
  const candidate = getAutoGenerationCacheCandidate(context);
  rows[0].text = 'Changed outside';

  expect(candidate).toEqual({
    cacheHit: true,
    subtitles: [{ id: 1, start: 0, end: 1, text: 'Captured' }],
  });
  expect(Object.isFrozen(candidate)).toBe(true);
  expect(Object.isFrozen(candidate.subtitles)).toBe(true);
  expect(Object.isFrozen(candidate.subtitles[0])).toBe(true);
  expect(() => getAutoGenerationCacheCandidate({ ...context })).toThrowError(
    expect.objectContaining({ code: 'autoGenerationOwnershipLost' })
  );
});

test.each([
  ['rules cache switch', () => { mocks.rulesCacheId = 'cache-2'; }],
  ['user-subtitle cache switch', () => { mocks.subtitlesCacheId = 'cache-2'; }],
  ['source switch', () => { localStorage.setItem('current_file_cache_id', 'asset-2'); }],
  ['URL takeover', () => { localStorage.setItem('current_video_url', 'https://example.test/new'); }],
])('rejects a %s before a run-owned mutation', (_label, mutate) => {
  const { context } = createContext();
  mutate();
  expect(() => assertAutoGenerationContextCurrent(context)).toThrowError(
    expect.objectContaining({ code: 'autoGenerationOwnershipLost' })
  );
});

test('rejects an aborted run even when the media identity still matches', () => {
  const { context, controller } = createContext();
  controller.abort();
  expect(() => assertAutoGenerationContextCurrent(context)).toThrowError(
    expect.objectContaining({ code: 'autoGenerationAborted' })
  );
});

test('re-resolves and rejects an alias remap before native or durable work', async () => {
  const { context } = createContext();
  mocks.resolveProjectForCache.mockResolvedValueOnce({ projectId: 'project-2' });

  await expect(assertAutoGenerationContextDurable(context)).rejects.toMatchObject({
    code: 'autoGenerationOwnershipLost',
  });
  expect(mocks.resolveProjectForCache).toHaveBeenCalledWith('cache-1', { create: false });
});

test('accepts only an exact privately-issued nonempty or explicit no-speech durable terminal', async () => {
  const { context } = createContext();
  const subtitlesCheckpoint = await commitDurableSubtitleCheckpoint({
    context,
    subtitles: [{ start: 0, end: 1, text: 'One' }, { start: 1, end: 2, text: 'Two' }],
    validateOwnership: assertAutoGenerationContextDurable,
  });
  const subtitles = createAutoGenerationCompletion({
    context,
    terminal: 'subtitles',
    checkpoint: subtitlesCheckpoint,
  });
  const noSpeechCheckpoint = await commitDurableSubtitleCheckpoint({
    context,
    subtitles: [],
    validateOwnership: assertAutoGenerationContextDurable,
  });
  const noSpeech = createAutoGenerationCompletion({
    context,
    terminal: 'no-speech',
    checkpoint: noSpeechCheckpoint,
  });

  expect(isAutoGenerationCompletion(subtitles, context)).toBe(true);
  expect(isAutoGenerationCompletion(noSpeech, context)).toBe(true);
  expect(isAutoGenerationCompletion({ ...subtitles, runId: 'run-2' }, context)).toBe(false);
  expect(isAutoGenerationCompletion({
    kind: 'auto-generation-completion',
    runId: 'run-1',
    terminal: 'subtitles',
    subtitleCount: 2,
    projectId: 'project-1',
    cacheId: 'cache-1',
  }, context)).toBe(false);
  expect(() => createAutoGenerationCompletion({
    context,
    terminal: 'subtitles',
    checkpoint: {
      kind: 'durable-subtitle-checkpoint',
      runId: 'run-1',
      subtitleCount: 2,
      projectId: 'project-1',
      cacheId: 'cache-1',
    },
  })).toThrow();
});
