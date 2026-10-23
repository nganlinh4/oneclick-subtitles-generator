import {
  getCurrentCacheId as getSubtitlesCacheId,
  setUserProvidedSubtitlesForCache,
} from '../../utils/userSubtitlesStore';
import { resolveProjectForCache } from '../../platform/subtitleProjectStore';
import {
  refreshActiveNativeMedia,
  resolveActiveNativeMedia,
  revalidateActiveNativeMedia,
} from '../../platform/activeNativeMedia';
import { useModalHandlers } from './ModalHandlers';

vi.mock('../../utils/userSubtitlesStore', () => ({
  getCurrentCacheId: vi.fn(),
  setUserProvidedSubtitlesForCache: vi.fn(),
}));
vi.mock('../../platform/subtitleProjectStore', () => ({ resolveProjectForCache: vi.fn() }));
vi.mock('../../platform/activeNativeMedia', () => ({
  refreshActiveNativeMedia: vi.fn(),
  resolveActiveNativeMedia: vi.fn(),
  revalidateActiveNativeMedia: vi.fn(),
}));
vi.mock('../../services/videoAnalysisService', () => ({ abortVideoAnalysis: vi.fn(() => false) }));

const CACHE = '019ffa3d-8e35-7f92-b3e3-607dd27bb263';
const PROJECT = '019ffa3d-8e35-7f92-b3e3-607dd27bb299';
const CAPABILITY = Object.freeze({ cacheId: CACHE, projectId: PROJECT, media: { assetId: CACHE } });

const buildState = () => ({
  setStatus: vi.fn(),
  setUserProvidedSubtitlesState: vi.fn(),
  setUseUserProvidedSubtitles: vi.fn(),
  t: (_key, fallback) => fallback,
});

beforeEach(() => {
  vi.clearAllMocks();
  getSubtitlesCacheId.mockReturnValue(CACHE);
  resolveProjectForCache.mockResolvedValue({ cacheId: CACHE, projectId: PROJECT });
  resolveActiveNativeMedia.mockResolvedValue(CAPABILITY);
  revalidateActiveNativeMedia.mockResolvedValue(CAPABILITY);
  refreshActiveNativeMedia.mockResolvedValue(CAPABILITY);
  setUserProvidedSubtitlesForCache.mockResolvedValue(undefined);
});

test('uses the active native project and publishes user subtitles only after persistence', async () => {
  const state = buildState();

  await useModalHandlers(state).handleUserSubtitlesAdd('Reference subtitles');

  expect(setUserProvidedSubtitlesForCache).toHaveBeenCalledWith(CACHE, 'Reference subtitles', {
    expectedProjectId: PROJECT,
  });
  expect(state.setUserProvidedSubtitlesState).toHaveBeenCalledWith('Reference subtitles');
  expect(state.setUseUserProvidedSubtitles).toHaveBeenCalledWith(true);
  expect(setUserProvidedSubtitlesForCache.mock.invocationCallOrder[0])
    .toBeLessThan(state.setUserProvidedSubtitlesState.mock.invocationCallOrder[0]);
});

test('fails closed without active native media', async () => {
  resolveActiveNativeMedia.mockRejectedValue(new Error('no active media'));
  const state = buildState();

  await expect(useModalHandlers(state).handleUserSubtitlesAdd('Reference subtitles'))
    .rejects.toThrow('no active media');
  expect(setUserProvidedSubtitlesForCache).not.toHaveBeenCalled();
});

test('clears timing-generation enablement only after the empty native write succeeds', async () => {
  const state = buildState();

  await useModalHandlers(state).handleUserSubtitlesAdd('   ');

  expect(setUserProvidedSubtitlesForCache).toHaveBeenCalledWith(CACHE, '   ', {
    expectedProjectId: PROJECT,
  });
  expect(state.setUserProvidedSubtitlesState).toHaveBeenCalledWith('   ');
  expect(state.setUseUserProvidedSubtitles).toHaveBeenCalledWith(false);
});

test('does not change timing-generation enablement when the native text write fails', async () => {
  setUserProvidedSubtitlesForCache.mockRejectedValueOnce(new Error('native write failed'));
  const state = buildState();

  await expect(useModalHandlers(state).handleUserSubtitlesAdd(''))
    .rejects.toThrow('native write failed');

  expect(state.setUserProvidedSubtitlesState).not.toHaveBeenCalled();
  expect(state.setUseUserProvidedSubtitles).not.toHaveBeenCalled();
});

test('does not publish user subtitles or enablement when the alias remaps after writing', async () => {
  resolveProjectForCache
    .mockResolvedValueOnce({ cacheId: CACHE, projectId: PROJECT })
    .mockResolvedValueOnce({ cacheId: CACHE, projectId: 'remapped-project' });
  const state = buildState();

  await expect(useModalHandlers(state).handleUserSubtitlesAdd('Stale reference'))
    .rejects.toThrow('active subtitle project changed');

  expect(setUserProvidedSubtitlesForCache).toHaveBeenCalledTimes(1);
  expect(state.setUserProvidedSubtitlesState).not.toHaveBeenCalled();
  expect(state.setUseUserProvidedSubtitles).not.toHaveBeenCalled();
});
