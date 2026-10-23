// Quality re-downloads: the requested quality selects the native format, is part of the operation
// identity, and may only claim into a project the URL alias already names.
import { createHarness, flush, mediaCandidate } from './nativeUrlDownloadAdapterTestFixtures';
import { normalizeQuality, selectNativeQuality } from './nativeUrlDownloadContract';

vi.mock('./downloadService', () => ({
  cancelDownload: vi.fn(),
  inspectDownloadUrl: vi.fn(),
  startDownload: vi.fn(),
}));
vi.mock('./mediaService', () => ({
  claimMediaCandidate: vi.fn(),
  discardMediaCandidate: vi.fn(),
  isNativeMediaDescriptor: vi.fn(() => false),
  openMediaAsset: vi.fn(),
}));
vi.mock('../services/subtitleCache', () => ({
  generateUrlBasedCacheId: vi.fn(async () => 'generated-cache'),
}));
vi.mock('./subtitleProjectStore', () => ({ resolveProjectForCache: vi.fn() }));
vi.mock('./subtitleProjectBinding', () => ({
  activateSubtitleProjectBinding: vi.fn(),
  isSubtitleProjectBindingReceipt: vi.fn(() => false),
  rollbackSubtitleProjectBinding: vi.fn(() => true),
}));

const inventory = {
  formats: {
    video: [
      { formatId: '1080-video', height: 1080, includesAudio: false, bitrateKbps: 4_000 },
      { formatId: '1080-combined', height: 1080, includesAudio: true, bitrateKbps: 2_000 },
      { formatId: '720-combined', height: 720, includesAudio: true, bitrateKbps: 1_000 },
    ],
  },
};
const URL = 'https://www.youtube.com/watch?v=quality';

it('prefers an exact combined native format, else a bounded at-most request', () => {
  expect(selectNativeQuality(inventory, '1080p')).toEqual({
    mode: 'exact',
    formatId: '1080-combined',
  });
  expect(selectNativeQuality(inventory, '480p')).toEqual({ mode: 'atMost', height: 480 });
  expect(() => selectNativeQuality(inventory, 'original')).toThrow(
    'The selected video quality is invalid'
  );
});

it('accepts only a bounded height label as an explicit quality', () => {
  expect(normalizeQuality(undefined)).toBeNull();
  expect(normalizeQuality('720p')).toBe('720p');
  for (const invalid of ['original', '99p', '4321p', '0720p', 720, '720p\n']) {
    expect(() => normalizeQuality(invalid)).toThrow(
      expect.objectContaining({ code: 'invalidDownloadRequest' })
    );
  }
});

it('downloads the selected format and resolves its project without creating one', async () => {
  const harness = createHarness();
  harness.inspect.mockResolvedValue({ capability: { id: harness.inventoryId }, inventory });
  const pending = harness.adapter.downloadVideo({
    url: URL,
    cookieSource: 'none',
    quality: '1080p',
  });
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(1));
  expect(harness.start.mock.calls[0][0]).toEqual({
    inventoryId: harness.inventoryId,
    media: { kind: 'video', quality: { mode: 'exact', formatId: '1080-combined' } },
    subtitle: null,
  });

  harness.getHandlers().onCompleted({ media: mediaCandidate(harness.assetId), subtitle: null });
  await expect(pending).resolves.toBe(harness.descriptor);
  expect(harness.resolveCandidateProject).toHaveBeenCalledExactlyOnceWith(URL, { create: false });
});

it('never coalesces a quality re-download with a default download of the same URL', async () => {
  const harness = createHarness();
  harness.inspect.mockResolvedValue({ capability: { id: harness.inventoryId }, inventory });
  harness.adapter.downloadVideo({ url: URL, cookieSource: 'none' });
  harness.adapter.downloadVideo({ url: URL, cookieSource: 'none', quality: '720p' });
  await flush();
  await vi.waitFor(() => expect(harness.start).toHaveBeenCalledTimes(2));

  expect(harness.start.mock.calls.map(([request]) => request.media)).toEqual([
    { kind: 'video', quality: { mode: 'best' } },
    { kind: 'video', quality: { mode: 'exact', formatId: '720-combined' } },
  ]);
});
