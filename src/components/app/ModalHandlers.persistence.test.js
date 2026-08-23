import { generateUrlBasedCacheId } from '../../services/subtitleCache';
import {
  getCurrentCacheId as getRulesCacheId,
  setTranscriptionRulesForCache,
} from '../../utils/transcriptionRulesStore';
import {
  getCurrentCacheId as getSubtitlesCacheId,
  setUserProvidedSubtitlesForCache,
} from '../../utils/userSubtitlesStore';
import { resolveProjectForCache } from '../../platform/subtitleProjectStore';
import { useModalHandlers } from './ModalHandlers';

vi.mock('../../services/subtitleCache', () => ({ generateUrlBasedCacheId: vi.fn() }));
vi.mock('../../utils/transcriptionRulesStore', () => ({
  getCurrentCacheId: vi.fn(),
  setTranscriptionRulesForCache: vi.fn(),
}));
vi.mock('../../utils/userSubtitlesStore', () => ({
  getCurrentCacheId: vi.fn(),
  setUserProvidedSubtitlesForCache: vi.fn(),
}));
vi.mock('../../platform/subtitleProjectStore', () => ({ resolveProjectForCache: vi.fn() }));
vi.mock('../../services/videoAnalysisService', () => ({ abortVideoAnalysis: vi.fn(() => false) }));
vi.mock('../../platform/mediaService', async (importOriginal) => ({
  ...(await importOriginal()),
  isNativeMediaDescriptor: vi.fn(() => false),
}));
vi.mock('../../utils/cacheUtils', () => ({ generateFileCacheId: vi.fn() }));

const CACHE = '019ffa3d-8e35-7f92-b3e3-607dd27bb263';
const PROJECT = '019ffa3d-8e35-7f92-b3e3-607dd27bb299';

const buildState = () => ({
  setTranscriptionRulesState: vi.fn(),
  setShowRulesEditor: vi.fn(),
  setStatus: vi.fn(),
  setUserProvidedSubtitlesState: vi.fn(),
  setUseUserProvidedSubtitles: vi.fn(),
  uploadedFile: null,
  t: (_key, fallback) => fallback,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  getRulesCacheId.mockReturnValue(CACHE);
  getSubtitlesCacheId.mockReturnValue(CACHE);
  resolveProjectForCache.mockResolvedValue({ cacheId: CACHE, projectId: PROJECT });
  setTranscriptionRulesForCache.mockResolvedValue(undefined);
  setUserProvidedSubtitlesForCache.mockResolvedValue(undefined);
});

test('captures the URL project before persisting and publishes only after scoped storage', async () => {
  let resolveAlias;
  generateUrlBasedCacheId.mockReturnValue(new Promise((resolve) => { resolveAlias = resolve; }));
  localStorage.setItem('current_video_url', 'https://media.example.test/clip.mp4');
  const state = buildState();
  const handlers = useModalHandlers(state);
  const edited = { atmosphere: 'busy' };

  const saving = handlers.handleSaveRules(edited);
  expect(setTranscriptionRulesForCache).not.toHaveBeenCalled();
  resolveAlias(CACHE);
  await saving;

  expect(setTranscriptionRulesForCache).toHaveBeenCalledWith(CACHE, edited, {
    expectedProjectId: PROJECT,
  });
  expect(state.setTranscriptionRulesState).toHaveBeenCalledWith(edited);
  expect(setTranscriptionRulesForCache.mock.invocationCallOrder[0])
    .toBeLessThan(state.setTranscriptionRulesState.mock.invocationCallOrder[0]);
});

test('discards an editor save when the active project changed while its alias resolved', async () => {
  let resolveAlias;
  generateUrlBasedCacheId.mockReturnValue(new Promise((resolve) => { resolveAlias = resolve; }));
  localStorage.setItem('current_video_url', 'https://media.example.test/clip.mp4');
  getRulesCacheId.mockReturnValue('different-project');
  const state = buildState();
  const saving = useModalHandlers(state).handleSaveRules({ atmosphere: 'stale' });
  resolveAlias(CACHE);

  await expect(saving).rejects.toThrow('active subtitle project changed');
  expect(setTranscriptionRulesForCache).not.toHaveBeenCalled();
  expect(state.setTranscriptionRulesState).not.toHaveBeenCalled();
});

test('does not publish edited rules when native persistence fails', async () => {
  localStorage.setItem('current_file_cache_id', CACHE);
  setTranscriptionRulesForCache.mockRejectedValueOnce(new Error('native write failed'));
  const state = buildState();

  await expect(useModalHandlers(state).handleSaveRules({ atmosphere: 'unsaved' }))
    .rejects.toThrow('native write failed');
  expect(state.setTranscriptionRulesState).not.toHaveBeenCalled();
});

test('does not publish edited rules when the alias remaps after the native write returns', async () => {
  localStorage.setItem('current_file_cache_id', CACHE);
  resolveProjectForCache
    .mockResolvedValueOnce({ cacheId: CACHE, projectId: PROJECT })
    .mockResolvedValueOnce({ cacheId: CACHE, projectId: 'remapped-project' });
  const state = buildState();

  await expect(useModalHandlers(state).handleSaveRules({ atmosphere: 'stale' }))
    .rejects.toThrow('active subtitle project changed');

  expect(setTranscriptionRulesForCache).toHaveBeenCalledTimes(1);
  expect(state.setTranscriptionRulesState).not.toHaveBeenCalled();
});

test('uses the active file project and publishes user subtitles only after persistence', async () => {
  localStorage.setItem('current_file_cache_id', CACHE);
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

test('clears timing-generation enablement only after the empty native write succeeds', async () => {
  localStorage.setItem('current_file_cache_id', CACHE);
  const state = buildState();

  await useModalHandlers(state).handleUserSubtitlesAdd('   ');

  expect(setUserProvidedSubtitlesForCache).toHaveBeenCalledWith(CACHE, '   ', {
    expectedProjectId: PROJECT,
  });
  expect(state.setUserProvidedSubtitlesState).toHaveBeenCalledWith('   ');
  expect(state.setUseUserProvidedSubtitles).toHaveBeenCalledWith(false);
});

test('does not change timing-generation enablement when the native text write fails', async () => {
  localStorage.setItem('current_file_cache_id', CACHE);
  setUserProvidedSubtitlesForCache.mockRejectedValueOnce(new Error('native write failed'));
  const state = buildState();

  await expect(useModalHandlers(state).handleUserSubtitlesAdd(''))
    .rejects.toThrow('native write failed');

  expect(state.setUserProvidedSubtitlesState).not.toHaveBeenCalled();
  expect(state.setUseUserProvidedSubtitles).not.toHaveBeenCalled();
});

test('does not publish user subtitles or enablement when the alias remaps after writing', async () => {
  localStorage.setItem('current_file_cache_id', CACHE);
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
