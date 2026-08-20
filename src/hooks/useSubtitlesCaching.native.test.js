import { resolveCacheIdForGeneration, persistRetryResultToCache } from './useSubtitlesCaching';
import { generateFileCacheId } from '../utils/cacheUtils';
import {
  requireSuccessfulSubtitleCacheSave,
  saveSubtitlesToCache,
} from '../services/subtitleCache';
import { setCurrentCacheId as setRulesCacheId } from '../utils/transcriptionRulesStore';
import { setCurrentCacheId as setSubtitlesCacheId } from '../utils/userSubtitlesStore';

vi.mock('../utils/cacheUtils', () => ({ generateFileCacheId: vi.fn() }));
vi.mock('../utils/videoProcessor', () => ({ getVideoDuration: vi.fn() }));
vi.mock('../utils/videoPreloader', () => ({ preloadYouTubeVideo: vi.fn() }));
vi.mock('../services/subtitleCache', () => ({
  generateUrlBasedCacheId: vi.fn(),
  getCachedSubtitles: vi.fn(),
  requireSuccessfulSubtitleCacheSave: vi.fn((result) => {
    if (result?.success !== true) throw new Error('durable save failed');
  }),
  saveSubtitlesToCache: vi.fn(),
}));
vi.mock('../utils/transcriptionRulesStore', () => ({ setCurrentCacheId: vi.fn() }));
vi.mock('../utils/userSubtitlesStore', () => ({ setCurrentCacheId: vi.fn() }));

const ASSET_ID = '019ffbce-1d1a-7341-b053-f70b9af1b4f1';
const nativeAudio = Object.freeze({
  __nativeMedia: true,
  assetId: ASSET_ID,
  playbackId: '4ae1d9de-9057-4017-b187-e8e186bff598',
  playbackUrl: `http://127.0.0.1:12345/asset/4ae1d9de-9057-4017-b187-e8e186bff598?token=${'a'.repeat(64)}`,
  name: 'fresh.wav',
  type: 'audio/wav',
  size: 491404,
  lastModified: 0,
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  saveSubtitlesToCache.mockResolvedValue({ success: true });
});

it('uses the opaque native asset ID as the generation cache key', async () => {
  await expect(resolveCacheIdForGeneration({
    input: nativeAudio,
    inputType: 'file-upload',
    currentVideoUrl: null,
    t: (key) => key,
    setStatus: vi.fn(),
  })).resolves.toBe(ASSET_ID);

  expect(generateFileCacheId).not.toHaveBeenCalled();
  expect(localStorage.getItem('current_file_cache_id')).toBe(ASSET_ID);
  expect(setRulesCacheId).toHaveBeenCalledWith(ASSET_ID);
  expect(setSubtitlesCacheId).toHaveBeenCalledWith(ASSET_ID);
});

it('uses the same opaque native asset ID when persisting retry results', async () => {
  const subtitles = [{ start: 0, end: 1, text: 'fresh test' }];

  await persistRetryResultToCache({
    input: nativeAudio,
    inputType: 'file-upload',
    subtitles,
  });

  expect(generateFileCacheId).not.toHaveBeenCalled();
  expect(saveSubtitlesToCache).toHaveBeenCalledWith(ASSET_ID, subtitles);
  expect(requireSuccessfulSubtitleCacheSave).toHaveBeenCalledWith({ success: true });
  expect(localStorage.getItem('current_file_cache_id')).toBe(ASSET_ID);
  expect(setRulesCacheId).toHaveBeenCalledWith(ASSET_ID);
  expect(setSubtitlesCacheId).toHaveBeenCalledWith(ASSET_ID);
});

it('rejects retry persistence when the native project save is not durable', async () => {
  saveSubtitlesToCache.mockResolvedValueOnce({ success: false });

  await expect(persistRetryResultToCache({
    input: nativeAudio,
    inputType: 'file-upload',
    subtitles: [{ start: 0, end: 1, text: 'must persist' }],
  })).rejects.toThrow('durable save failed');
});
