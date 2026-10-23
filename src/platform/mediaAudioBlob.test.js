import { invokeDesktop, invokeDesktopRaw } from './desktopRuntime';
import { importAudioBlob, isNativeAudioBlob, releaseAudioBlob } from './mediaAudioBlob';
import { ASSET_ID, PLAYBACK_ID } from './mediaServiceTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

beforeEach(() => {
  invokeDesktop.mockReset();
  invokeDesktopRaw.mockReset();
});

const createAudioBlob = (bytes, type) => {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  Object.defineProperty(blob, 'arrayBuffer', {
    configurable: true,
    value: vi.fn().mockResolvedValue(Uint8Array.from(bytes).buffer),
  });
  return blob;
};

it('imports a recorder Blob through raw IPC and returns only an opaque leased asset', async () => {
  const bytes = [0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d];
  const blob = createAudioBlob(bytes, 'audio/webm;codecs=opus');
  invokeDesktopRaw.mockResolvedValue({
    asset: {
      id: ASSET_ID,
      displayName: 'recording.weba',
      extension: 'weba',
      sizeBytes: bytes.length,
      kind: 'audio',
    },
  });

  const asset = await importAudioBlob(blob);

  expect(invokeDesktopRaw).toHaveBeenCalledWith(
    'media_blob_import',
    expect.any(ArrayBuffer),
    { 'x-osg-content-type': 'audio/webm' }
  );
  expect(asset).toEqual({
    __nativeAudioBlob: true,
    assetId: ASSET_ID,
    name: 'recording.weba',
    type: 'audio/webm',
    size: bytes.length,
  });
  expect(Object.isFrozen(asset)).toBe(true);
  expect(isNativeAudioBlob(asset)).toBe(true);
  expect(asset).not.toHaveProperty('path');
  expect(asset).not.toHaveProperty('data');
  expect(asset).not.toHaveProperty('bytes');
  expect(asset).not.toHaveProperty('playbackUrl');
});

it('releases an audio lease only by UUIDv7 and validates the native response', async () => {
  invokeDesktop.mockResolvedValueOnce(true).mockResolvedValueOnce('true');

  await expect(releaseAudioBlob(ASSET_ID)).resolves.toBe(true);
  expect(invokeDesktop).toHaveBeenCalledWith('media_blob_release', { assetId: ASSET_ID });
  await expect(releaseAudioBlob(ASSET_ID)).rejects.toMatchObject({
    code: 'invalidMediaResponse',
  });

  invokeDesktop.mockClear();
  await expect(releaseAudioBlob(PLAYBACK_ID)).rejects.toMatchObject({
    code: 'invalidMediaRequest',
  });
  expect(invokeDesktop).not.toHaveBeenCalled();
});

it.each([
  ['empty blob', () => createAudioBlob([], 'audio/wav')],
  ['missing MIME type', () => createAudioBlob([1], '')],
  ['video MIME type', () => createAudioBlob([1], 'video/webm')],
  ['unknown codec parameter', () => createAudioBlob([1], 'audio/webm;codecs=h264')],
])('rejects invalid audio Blob input before raw IPC: %s', async (_label, createBlob) => {
  await expect(importAudioBlob(createBlob())).rejects.toMatchObject({
    code: 'invalidMediaRequest',
  });
  expect(invokeDesktopRaw).not.toHaveBeenCalled();
});

it.each([
  ['extra top-level field', (response) => { response.path = 'C:\\private\\audio.webm'; }],
  ['extra asset field', (response) => { response.asset.bytes = [1, 2, 3]; }],
  ['wrong extension', (response) => { response.asset.extension = 'ogg'; }],
  ['wrong kind', (response) => { response.asset.kind = 'video'; }],
  ['wrong size', (response) => { response.asset.sizeBytes += 1; }],
  ['UUIDv4 asset', (response) => { response.asset.id = PLAYBACK_ID; }],
])('rejects hostile audio-import metadata: %s', async (_label, mutate) => {
  const bytes = [0x1a, 0x45, 0xdf, 0xa3, 0x77, 0x65, 0x62, 0x6d];
  const blob = createAudioBlob(bytes, 'audio/webm');
  const response = {
    asset: {
      id: ASSET_ID,
      displayName: 'recording.weba',
      extension: 'weba',
      sizeBytes: bytes.length,
      kind: 'audio',
    },
  };
  mutate(response);
  invokeDesktopRaw.mockResolvedValue(response);

  await expect(importAudioBlob(blob)).rejects.toMatchObject({ code: 'invalidMediaResponse' });
});
