import { getCachedSubtitles } from '../services/subtitleCache';
import { loadCachedSubtitlesIfAvailable } from './useSubtitlesCaching';

vi.mock('../services/subtitleCache', () => ({
  generateUrlBasedCacheId: vi.fn(),
  getCachedSubtitles: vi.fn(),
  requireSuccessfulSubtitleCacheSave: vi.fn(),
  saveSubtitlesToCache: vi.fn(),
}));

test('returns a cache hit as a pure candidate without a presentation callback', async () => {
  const rows = [{ start: 0, end: 1, text: 'Candidate' }];
  getCachedSubtitles.mockResolvedValue(rows);

  await expect(loadCachedSubtitlesIfAvailable({
    cacheId: 'asset-a',
    segment: null,
    currentVideoUrl: null,
    debugLog: vi.fn(),
  })).resolves.toEqual({ cacheHit: true, cachedSubtitles: rows });
});

test('returns a cache miss without requiring a React state setter', async () => {
  getCachedSubtitles.mockResolvedValue(null);

  await expect(loadCachedSubtitlesIfAvailable({
    cacheId: 'asset-a',
    segment: null,
    currentVideoUrl: null,
    debugLog: vi.fn(),
  })).resolves.toEqual({ cacheHit: false, cachedSubtitles: null });
});
