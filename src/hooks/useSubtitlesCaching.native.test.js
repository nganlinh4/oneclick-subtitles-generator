import { resolveCacheIdForGeneration } from './useSubtitlesCaching';
import { resolveActiveNativeMedia } from '../platform/activeNativeMedia';

vi.mock('../services/subtitleCache', () => ({
  getCachedSubtitles: vi.fn(),
}));
vi.mock('../platform/activeNativeMedia', () => ({
  resolveActiveNativeMedia: vi.fn(),
}));

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
  vi.clearAllMocks();
  resolveActiveNativeMedia.mockResolvedValue(Object.freeze({
    assetId: ASSET_ID,
    cacheId: ASSET_ID,
    projectId: '019ffbce-1d1a-7341-b053-f70b9af1b400',
    stateVersion: 1,
    media: nativeAudio,
  }));
});

it('uses the active native media alias as the generation cache key', async () => {
  await expect(resolveCacheIdForGeneration({ input: nativeAudio })).resolves.toBe(ASSET_ID);
  expect(resolveActiveNativeMedia).toHaveBeenCalledExactlyOnceWith({ candidate: nativeAudio });
});

it('resolves the active media without trusting a non-native candidate', async () => {
  await expect(resolveCacheIdForGeneration({ input: { url: 'https://example.test/v' } }))
    .resolves.toBe(ASSET_ID);
  expect(resolveActiveNativeMedia).toHaveBeenCalledExactlyOnceWith({ candidate: null });
});
