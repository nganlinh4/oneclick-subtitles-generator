import { resolveCacheIdForGeneration } from './useSubtitlesCaching';
import { generateFileCacheId } from '../utils/cacheUtils';
import { activateSubtitleProjectBinding } from '../platform/subtitleProjectBinding';
import {
  resolveActiveNativeMedia,
} from '../platform/activeNativeMedia';

vi.mock('../utils/cacheUtils', () => ({ generateFileCacheId: vi.fn() }));
vi.mock('../utils/videoProcessor', () => ({ getVideoDuration: vi.fn() }));
vi.mock('../services/subtitleCache', () => ({
  generateUrlBasedCacheId: vi.fn(),
  getCachedSubtitles: vi.fn(),
}));
vi.mock('../utils/transcriptionRulesStore', () => ({ setCurrentCacheId: vi.fn() }));
vi.mock('../utils/userSubtitlesStore', () => ({ setCurrentCacheId: vi.fn() }));
vi.mock('../platform/subtitleProjectBinding', () => ({
  activateSubtitleProjectBinding: vi.fn(),
}));
vi.mock('../platform/activeNativeMedia', () => ({
  resolveActiveNativeMedia: vi.fn(),
}));
vi.mock('../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktopRuntime: vi.fn(() => true),
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
  localStorage.clear();
  vi.clearAllMocks();
  activateSubtitleProjectBinding.mockResolvedValue({ kind: 'subtitle-project-binding' });
  const capability = Object.freeze({
    assetId: ASSET_ID,
    cacheId: ASSET_ID,
    projectId: '019ffbce-1d1a-7341-b053-f70b9af1b400',
    stateVersion: 1,
    media: nativeAudio,
  });
  resolveActiveNativeMedia.mockResolvedValue(capability);
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
  expect(localStorage.getItem('current_file_cache_id')).toBeNull();
  expect(activateSubtitleProjectBinding).not.toHaveBeenCalled();
});
