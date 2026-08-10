import { v7 as uuidv7 } from 'uuid';

import { downloadUrlToUserDestination } from './userMediaExportFlow';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

const downloadJob = (id, basisPoints = 0, sequence = 1) => ({
  id,
  kind: 'downloadMedia',
  state: 'running',
  progress: { basisPoints },
  sequence,
});

test('downloads the selected native format then exports only its opaque asset ID', async () => {
  const inventoryId = uuidv7();
  const downloadJobId = uuidv7();
  const exportJobId = uuidv7();
  const assetId = uuidv7();
  const inspect = vi.fn().mockResolvedValue({ capability: { id: inventoryId } });
  const start = vi.fn(async (request, handlers) => {
    handlers.onProgress({
      job: downloadJob(downloadJobId, 5000, 2),
      progress: { fraction: 0.5 },
    });
    handlers.onCompleted({ media: { asset: { id: assetId } } });
    return downloadJob(downloadJobId);
  });
  const exportAsset = vi.fn(async (id, handlers) => {
    handlers.onStarted({ id: exportJobId });
    handlers.onProgress({ job: { progress: { basisPoints: 7500 } } });
    return { status: 'completed' };
  });
  const onJobStarted = vi.fn();
  const onDownloadProgress = vi.fn();
  const onExportProgress = vi.fn();
  const media = { kind: 'video', quality: { mode: 'atMost', height: 720 } };

  await expect(downloadUrlToUserDestination({
    url: 'https://example.com/watch/1',
    cookieSource: 'none',
    media,
    onJobStarted,
    onDownloadProgress,
    onExportProgress,
  }, { inspect, start, exportAsset })).resolves.toEqual({ status: 'completed' });

  expect(start).toHaveBeenCalledWith({ inventoryId, media, subtitle: null }, expect.any(Object));
  expect(exportAsset).toHaveBeenCalledWith(assetId, expect.any(Object));
  expect(onJobStarted).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: downloadJobId }));
  expect(onJobStarted).toHaveBeenNthCalledWith(2, { id: exportJobId });
  expect(onDownloadProgress).toHaveBeenCalledWith(50);
  expect(onExportProgress).toHaveBeenCalledWith(75);
});

test('download cancellation never opens the save dialog', async () => {
  const downloadJobId = uuidv7();
  const inspect = vi.fn().mockResolvedValue({ capability: { id: uuidv7() } });
  const start = vi.fn(async (_, handlers) => {
    handlers.onCancelled({ job: { id: downloadJobId } });
    return downloadJob(downloadJobId);
  });
  const exportAsset = vi.fn();

  await expect(downloadUrlToUserDestination({
    url: 'https://example.com/watch/1',
    cookieSource: 'none',
    media: { kind: 'audio', quality: { mode: 'best' }, format: 'mp3' },
  }, { inspect, start, exportAsset })).resolves.toEqual(expect.objectContaining({
    status: 'cancelled',
  }));
  expect(exportAsset).not.toHaveBeenCalled();
});

test('native download failures remain sanitized and do not export', async () => {
  const inspect = vi.fn().mockResolvedValue({ capability: { id: uuidv7() } });
  const start = vi.fn(async (_, handlers) => {
    handlers.onFailed({ error: { code: 'downloaderFailed', message: 'C:\\private\\secret' } });
    return downloadJob(uuidv7());
  });
  const exportAsset = vi.fn();

  await expect(downloadUrlToUserDestination({
    url: 'https://example.com/watch/1',
    cookieSource: 'none',
    media: { kind: 'video', quality: { mode: 'best' } },
  }, { inspect, start, exportAsset })).rejects.toMatchObject({
    code: 'downloaderFailed',
    message: 'The native media download could not be completed',
  });
  expect(exportAsset).not.toHaveBeenCalled();
});
