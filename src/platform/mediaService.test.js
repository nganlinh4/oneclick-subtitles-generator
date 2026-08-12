import { invokeDesktop, invokeDesktopRaw } from './desktopRuntime';
import {
  claimMediaDrop,
  clearMedia,
  createNativeMediaDescriptor,
  getSelectedMedia,
  importAudioBlob,
  isNativeAudioBlob,
  isNativeMediaDescriptor,
  isNativeMediaPlaybackUrl,
  openMediaAsset,
  releaseAudioBlob,
  restoreMediaAsset,
  selectMedia,
} from './mediaService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const TOKEN = 'a'.repeat(64);
const PLAYBACK_URL = `http://127.0.0.1:49152/asset/${PLAYBACK_ID}?token=${TOKEN}`;
const OFFER_ID = '9b2c6b54-3a72-44d2-89e8-4979ad45e5f0';

const validSnapshot = () => ({
  media: {
    id: ASSET_ID,
    displayName: 'Example.MP4',
    extension: 'mp4',
    sizeBytes: 4096,
    kind: 'video',
  },
  subtitleTrack: null,
  playback: {
    id: PLAYBACK_ID,
    playbackUrl: PLAYBACK_URL,
    mimeType: 'video/mp4',
    byteLength: 4096,
  },
});

const emptySnapshot = () => ({
  media: null,
  subtitleTrack: null,
  playback: null,
});

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

it('selects media through the exact native command and returns a frozen path-free descriptor', async () => {
  invokeDesktop.mockResolvedValue(validSnapshot());

  const descriptor = await selectMedia();

  expect(invokeDesktop).toHaveBeenCalledWith('select_media', {});
  expect(descriptor).toEqual({
    __nativeMedia: true,
    assetId: ASSET_ID,
    playbackId: PLAYBACK_ID,
    name: 'Example.MP4',
    type: 'video/mp4',
    size: 4096,
    lastModified: 0,
    playbackUrl: PLAYBACK_URL,
  });
  expect(Object.isFrozen(descriptor)).toBe(true);
  expect(isNativeMediaDescriptor(descriptor)).toBe(true);
  expect(descriptor).not.toHaveProperty('path');
  expect(descriptor).not.toHaveProperty('arrayBuffer');
  expect(descriptor).not.toHaveProperty('slice');
  expect(descriptor).not.toHaveProperty('stream');
  expect(descriptor).not.toHaveProperty('text');
});

it('creates the same strict path-free descriptor from a native pipeline media result', () => {
  const snapshot = validSnapshot();
  const descriptor = createNativeMediaDescriptor({
    asset: snapshot.media,
    playback: snapshot.playback,
  });

  expect(descriptor).toEqual(expect.objectContaining({
    __nativeMedia: true,
    assetId: ASSET_ID,
    playbackId: PLAYBACK_ID,
    playbackUrl: PLAYBACK_URL,
  }));
  expect(Object.isFrozen(descriptor)).toBe(true);
  expect(isNativeMediaDescriptor(descriptor)).toBe(true);
  expect(descriptor).not.toHaveProperty('path');

  expect(() => createNativeMediaDescriptor({
    asset: snapshot.media,
    playback: snapshot.playback,
    path: 'C:\\private\\clip.mp4',
  })).toThrow(expect.objectContaining({ code: 'invalidMediaResponse' }));
});

it('redeems only a UUIDv4 native drop offer and validates the returned snapshot', async () => {
  invokeDesktop.mockResolvedValue(validSnapshot());

  await expect(claimMediaDrop(OFFER_ID)).resolves.toEqual(expect.objectContaining({
    assetId: ASSET_ID,
    playbackId: PLAYBACK_ID,
  }));
  expect(invokeDesktop).toHaveBeenCalledWith('media_drop_claim', { offerId: OFFER_ID });

  invokeDesktop.mockClear();
  await expect(claimMediaDrop('C:\\private\\clip.mp4')).rejects.toMatchObject({
    code: 'invalidMediaRequest',
  });
  expect(invokeDesktop).not.toHaveBeenCalled();
});

it('returns null when selection is cancelled or the current snapshot is empty', async () => {
  invokeDesktop
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce(emptySnapshot());

  await expect(selectMedia()).resolves.toBeNull();
  await expect(getSelectedMedia()).resolves.toBeNull();
  expect(invokeDesktop.mock.calls).toEqual([
    ['select_media', {}],
    ['get_session_snapshot', {}],
  ]);
});

it('opens an opaque asset and rejects invalid IDs before invoking native code', async () => {
  invokeDesktop.mockResolvedValue(validSnapshot());

  await expect(openMediaAsset(ASSET_ID)).resolves.toEqual(
    expect.objectContaining({ assetId: ASSET_ID })
  );
  expect(invokeDesktop).toHaveBeenCalledWith('open_media_asset', {
    id: ASSET_ID,
    onlyIfEmpty: false,
  });

  invokeDesktop.mockClear();
  await expect(openMediaAsset(PLAYBACK_ID)).rejects.toMatchObject({
    name: 'MediaServiceError',
    code: 'invalidMediaRequest',
  });
  expect(invokeDesktop).not.toHaveBeenCalled();
});

it('restores an exact opaque asset only while native state is empty', async () => {
  invokeDesktop
    .mockResolvedValueOnce(validSnapshot())
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({
      ...validSnapshot(),
      media: { ...validSnapshot().media, id: '01890f39-7b62-7c4e-8c9a-000000000102' },
    });

  await expect(restoreMediaAsset(ASSET_ID)).resolves.toEqual(
    expect.objectContaining({ assetId: ASSET_ID })
  );
  await expect(restoreMediaAsset(ASSET_ID)).resolves.toBeNull();
  await expect(restoreMediaAsset(ASSET_ID)).rejects.toMatchObject({
    code: 'invalidMediaResponse',
  });
  expect(invokeDesktop.mock.calls).toEqual([
    ['open_media_asset', { id: ASSET_ID, onlyIfEmpty: true }],
    ['open_media_asset', { id: ASSET_ID, onlyIfEmpty: true }],
    ['open_media_asset', { id: ASSET_ID, onlyIfEmpty: true }],
  ]);

  invokeDesktop.mockClear();
  await expect(restoreMediaAsset(PLAYBACK_ID)).rejects.toMatchObject({
    code: 'invalidMediaRequest',
  });
  expect(invokeDesktop).not.toHaveBeenCalled();
});

it('clears media only when the native host returns an empty snapshot', async () => {
  invokeDesktop
    .mockResolvedValueOnce(emptySnapshot())
    .mockResolvedValueOnce(validSnapshot());

  await expect(clearMedia()).resolves.toBeNull();
  expect(invokeDesktop).toHaveBeenNthCalledWith(1, 'clear_media', {});
  await expect(clearMedia()).rejects.toMatchObject({ code: 'invalidMediaResponse' });
});

it('validates only exact loopback capability URLs for the same UUIDv4 playback handle', () => {
  expect(isNativeMediaPlaybackUrl(PLAYBACK_URL)).toBe(true);
  expect(isNativeMediaPlaybackUrl(PLAYBACK_URL, PLAYBACK_ID)).toBe(true);

  const otherPlaybackId = '1b4e28ba-2fa1-4f4c-9f8e-8d5bbf3f3268';
  const hostileUrls = [
    PLAYBACK_URL.replace('127.0.0.1', 'localhost'),
    PLAYBACK_URL.replace('127.0.0.1', '127.0.0.1.evil.example'),
    PLAYBACK_URL.replace('http://', 'http://attacker@'),
    PLAYBACK_URL.replace('/asset/', '/asset/../asset/'),
    PLAYBACK_URL.replace(PLAYBACK_ID, otherPlaybackId),
    PLAYBACK_URL.replace(TOKEN, 'a'.repeat(63)),
    `${PLAYBACK_URL}&other=value`,
    `${PLAYBACK_URL}#fragment`,
    PLAYBACK_URL.replace(':49152', ':0'),
    PLAYBACK_URL.replace(':49152', ':65536'),
    PLAYBACK_URL.replace(':49152', ':04915'),
  ];

  hostileUrls.forEach((url) => {
    expect(isNativeMediaPlaybackUrl(url, PLAYBACK_ID)).toBe(false);
  });
});

it.each([
  ['unexpected snapshot field', (value) => { value.path = 'C:\\secret\\clip.mp4'; }],
  ['unexpected asset field', (value) => { value.media.path = '/secret/clip.mp4'; }],
  ['UUIDv4 asset ID', (value) => { value.media.id = PLAYBACK_ID; }],
  ['blank display name', (value) => { value.media.displayName = ' '; }],
  ['path-bearing display name', (value) => { value.media.displayName = '../Example.MP4'; }],
  ['mismatched display extension', (value) => { value.media.displayName = 'Example.mov'; }],
  ['unnormalized extension', (value) => { value.media.extension = 'MP4'; }],
  ['unsupported extension', (value) => { value.media.extension = 'exe'; }],
  ['extension kind mismatch', (value) => { value.media.kind = 'audio'; }],
  ['zero asset size', (value) => { value.media.sizeBytes = 0; }],
  ['unsafe asset size', (value) => { value.media.sizeBytes = Number.MAX_SAFE_INTEGER + 1; }],
  ['missing playback', (value) => { value.playback = null; }],
  ['UUIDv7 playback ID', (value) => { value.playback.id = ASSET_ID; }],
  ['mismatched playback ID in URL', (value) => {
    value.playback.playbackUrl = value.playback.playbackUrl.replace(
      PLAYBACK_ID,
      '1b4e28ba-2fa1-4f4c-9f8e-8d5bbf3f3268'
    );
  }],
  ['cross-kind MIME type', (value) => { value.playback.mimeType = 'audio/mp4'; }],
  ['parameterized MIME type', (value) => { value.playback.mimeType = 'video/mp4; charset=utf-8'; }],
  ['mismatched byte length', (value) => { value.playback.byteLength = 4095; }],
])('rejects hostile native metadata: %s', async (_label, mutate) => {
  const response = validSnapshot();
  mutate(response);
  invokeDesktop.mockResolvedValue(response);

  await expect(getSelectedMedia()).rejects.toMatchObject({
    name: 'MediaServiceError',
    code: 'invalidMediaResponse',
  });
});

it('does not classify mutable, method-bearing, or path-bearing lookalikes as native descriptors', async () => {
  invokeDesktop.mockResolvedValue(validSnapshot());
  const descriptor = await getSelectedMedia();

  expect(isNativeMediaDescriptor({ ...descriptor })).toBe(false);
  expect(isNativeMediaDescriptor(Object.freeze({ ...descriptor, path: '/secret' }))).toBe(false);
  expect(isNativeMediaDescriptor(Object.freeze({ ...descriptor, arrayBuffer: () => null }))).toBe(false);
  expect(isNativeMediaDescriptor(null)).toBe(false);
});

it('never touches fetch or localStorage', async () => {
  const fetchSpy = vi.spyOn(global, 'fetch');
  const getItemSpy = vi.spyOn(Storage.prototype, 'getItem');
  const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
  invokeDesktop.mockResolvedValue(validSnapshot());

  await getSelectedMedia();

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(getItemSpy).not.toHaveBeenCalled();
  expect(setItemSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  getItemSpy.mockRestore();
  setItemSpy.mockRestore();
});

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
