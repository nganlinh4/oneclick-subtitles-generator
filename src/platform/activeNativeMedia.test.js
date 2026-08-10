import { resolveActiveNativeMediaAssetId } from './activeNativeMedia';
import { isDesktopRuntime } from './desktopRuntime';

vi.mock('./desktopRuntime', () => ({ isDesktopRuntime: vi.fn() }));

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAYBACK_URL = `http://127.0.0.1:49152/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`;
const DESCRIPTOR = Object.freeze({
  __nativeMedia: true,
  assetId: ASSET_ID,
  playbackId: PLAYBACK_ID,
  name: 'clip.mp4',
  type: 'video/mp4',
  size: 4096,
  lastModified: 0,
  playbackUrl: PLAYBACK_URL,
});

beforeEach(() => {
  localStorage.clear();
  isDesktopRuntime.mockReturnValue(true);
});

it('uses a complete native descriptor without consulting mutable active-media storage', () => {
  localStorage.setItem('current_file_cache_id', 'stale');
  expect(resolveActiveNativeMediaAssetId(DESCRIPTOR)).toBe(ASSET_ID);
});

it('resolves a URL-only consumer only when the complete active identity matches', () => {
  localStorage.setItem('current_file_url', PLAYBACK_URL);
  localStorage.setItem('current_file_cache_id', ASSET_ID);
  expect(resolveActiveNativeMediaAssetId(PLAYBACK_URL)).toBe(ASSET_ID);

  localStorage.setItem('current_file_url', PLAYBACK_URL.replace(':49152', ':49153'));
  expect(resolveActiveNativeMediaAssetId(PLAYBACK_URL)).toBeNull();

  localStorage.setItem('current_file_url', PLAYBACK_URL);
  localStorage.setItem('current_file_cache_id', PLAYBACK_ID);
  expect(resolveActiveNativeMediaAssetId(PLAYBACK_URL)).toBeNull();
});

it('never upgrades browser URLs, blobs, or desktop-looking URLs outside Tauri', () => {
  expect(resolveActiveNativeMediaAssetId('blob:https://example.test/id')).toBeNull();
  expect(resolveActiveNativeMediaAssetId('http://localhost:49152/video.mp4')).toBeNull();

  localStorage.setItem('current_file_url', PLAYBACK_URL);
  localStorage.setItem('current_file_cache_id', ASSET_ID);
  isDesktopRuntime.mockReturnValue(false);
  expect(resolveActiveNativeMediaAssetId(PLAYBACK_URL)).toBeNull();
});
