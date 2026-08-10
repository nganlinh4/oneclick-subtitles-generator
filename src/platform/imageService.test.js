import { Blob as NodeBlob } from 'buffer';

import { invokeDesktop, invokeDesktopRaw } from './desktopRuntime';
import { importReferenceImage, releaseReferenceImage } from './imageService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000201';
const BrowserBlob = global.Blob;

beforeAll(() => {
  global.Blob = NodeBlob;
});

afterAll(() => {
  global.Blob = BrowserBlob;
});

beforeEach(() => {
  vi.clearAllMocks();
});

test('imports reference bytes through the raw path and exposes only an opaque ID', async () => {
  const blob = new Blob(['image'], { type: 'image/png' });
  invokeDesktopRaw.mockResolvedValue({
    assetId: ASSET_ID,
    mimeType: 'image/png',
    sizeBytes: blob.size,
  });

  await expect(importReferenceImage(blob)).resolves.toEqual({
    assetId: ASSET_ID,
    mimeType: 'image/png',
    sizeBytes: blob.size,
  });
  const [command, bytes, headers] = invokeDesktopRaw.mock.calls[0];
  expect(command).toBe('image_blob_import');
  expect(bytes.byteLength).toBe(blob.size);
  expect(headers).toEqual({ 'x-osg-content-type': 'image/png' });
});

test('rejects unsupported inputs and mismatched host metadata', async () => {
  await expect(importReferenceImage(new Blob(['gif'], { type: 'image/gif' })))
    .rejects.toMatchObject({ code: 'invalidImageRequest' });
  invokeDesktopRaw.mockResolvedValue({
    assetId: ASSET_ID,
    mimeType: 'image/jpeg',
    sizeBytes: 5,
  });
  await expect(importReferenceImage(new Blob(['image'], { type: 'image/png' })))
    .rejects.toMatchObject({ code: 'invalidImageResponse' });
});

test('releases only a validated opaque image ID', async () => {
  invokeDesktop.mockResolvedValue(true);
  await expect(releaseReferenceImage(ASSET_ID)).resolves.toBe(true);
  expect(invokeDesktop).toHaveBeenCalledWith('image_blob_release', { assetId: ASSET_ID });
  await expect(releaseReferenceImage('not-an-id'))
    .rejects.toMatchObject({ code: 'invalidImageRequest' });
});
