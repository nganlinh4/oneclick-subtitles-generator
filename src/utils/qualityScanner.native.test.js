import { isDesktopRuntime } from '../platform/desktopRuntime';
import { inspectDownloadUrl } from '../platform/downloadService';
import {
  getVideoInfo,
  mapNativeVideoQualities,
  scanVideoQualities,
} from './qualityScanner';

vi.mock('../platform/desktopRuntime', () => ({ isDesktopRuntime: vi.fn() }));
vi.mock('../platform/downloadService', () => ({ inspectDownloadUrl: vi.fn() }));

const inventory = {
  title: 'Example video',
  durationSeconds: 125,
  formats: {
    video: [
      {
        formatId: '137', container: 'mp4', width: 1920, height: 1080,
        includesAudio: false, bitrateKbps: 4_500,
      },
      {
        formatId: '22', container: 'mp4', width: 1280, height: 720,
        includesAudio: true, bitrateKbps: 2_000,
      },
      {
        formatId: '136', container: 'mp4', width: 1280, height: 720,
        includesAudio: false, bitrateKbps: 2_500,
      },
    ],
    audio: [],
    qualities: [
      { height: 720, hasCombined: true, hasVideoOnly: true },
      { height: 1080, hasCombined: false, hasVideoOnly: true },
    ],
  },
  subtitles: [],
};

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn();
  localStorage.clear();
  isDesktopRuntime.mockReturnValue(true);
  inspectDownloadUrl.mockResolvedValue({
    capability: { id: '0198a8d7-dbf7-7ee0-a949-f13427fdd78a' },
    inventory,
  });
});

afterAll(() => {
  global.fetch = originalFetch;
});

it('maps only real native inventory qualities and prefers combined media', () => {
  expect(mapNativeVideoQualities(inventory)).toEqual([
    {
      height: 1080,
      quality: '1080p',
      description: '1080p (Full HD)',
      formatId: '137',
      extension: 'mp4',
      resolution: '1920x1080',
    },
    {
      height: 720,
      quality: '720p',
      description: '720p (HD)',
      formatId: '22',
      extension: 'mp4',
      resolution: '1280x720',
    },
  ]);
});

it('uses one typed native inspection with the selected cookie capability', async () => {
  localStorage.setItem('use_cookies_for_download', 'true');
  await expect(scanVideoQualities('https://example.com/watch?v=1')).resolves.toHaveLength(2);
  expect(inspectDownloadUrl).toHaveBeenCalledWith({
    url: 'https://example.com/watch?v=1',
    cookieSource: 'chrome',
  });
  expect(global.fetch).not.toHaveBeenCalled();
});

it('derives native video information from the same validated inventory', async () => {
  await expect(getVideoInfo('https://example.com/watch?v=1')).resolves.toEqual({
    title: 'Example video',
    duration: 125,
  });
});
