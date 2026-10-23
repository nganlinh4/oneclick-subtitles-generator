import { invokeDesktop } from './desktopRuntime';
import { getActiveProjectSnapshot } from './projectService';
import {
  claimMediaDrop,
  clearMedia,
  createNativeMediaDescriptor,
  getSelectedMedia,
  isNativeMediaDescriptor,
  isNativeMediaPlaybackUrl,
  openMediaAsset,
  restoreMediaAsset,
  selectMedia,
} from './mediaService';
import {
  activeProjectFixture,
  ASSET_ID,
  emptySnapshot,
  OFFER_ID,
  PLAYBACK_ID,
  PLAYBACK_URL,
  PROJECT_ID,
  TOKEN,
  validSnapshot,
} from './mediaServiceTestFixtures';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));

vi.mock('./projectService', () => ({
  activateProjectSnapshot: vi.fn(),
  getActiveProjectSnapshot: vi.fn(),
  mutateProject: vi.fn(),
  undoDetachedProject: vi.fn(),
}));

beforeEach(() => {
  invokeDesktop.mockReset();
  getActiveProjectSnapshot.mockReturnValue(activeProjectFixture());
});

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
    projectId: PROJECT_ID,
    expectedStateVersion: 7,
    onlyIfEmpty: false,
  });

  invokeDesktop.mockClear();
  await expect(openMediaAsset(PLAYBACK_ID)).rejects.toMatchObject({
    name: 'MediaServiceError',
    code: 'invalidMediaRequest',
  });
  expect(invokeDesktop).not.toHaveBeenCalled();
});

it('requires the active project revision to own an asset before activation IPC', async () => {
  getActiveProjectSnapshot.mockReturnValueOnce(null).mockReturnValueOnce({
    metadata: { id: PROJECT_ID, name: 'Fixture' },
    stateVersion: 8,
    media: [],
    tracks: [],
  });

  await expect(openMediaAsset(ASSET_ID)).rejects.toMatchObject({
    code: 'invalidMediaRequest',
  });
  await expect(openMediaAsset(ASSET_ID)).rejects.toMatchObject({
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
    ['open_media_asset', {
      id: ASSET_ID, projectId: PROJECT_ID, expectedStateVersion: 7, onlyIfEmpty: true,
    }],
    ['open_media_asset', {
      id: ASSET_ID, projectId: PROJECT_ID, expectedStateVersion: 7, onlyIfEmpty: true,
    }],
    ['open_media_asset', {
      id: ASSET_ID, projectId: PROJECT_ID, expectedStateVersion: 7, onlyIfEmpty: true,
    }],
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
  expect(invokeDesktop).toHaveBeenNthCalledWith(1, 'clear_media', {
    expectedAssetId: null,
    expectedPlaybackId: null,
  });
  await expect(clearMedia()).rejects.toMatchObject({ code: 'invalidMediaResponse' });
});

it('clears only the exact native asset and playback capability when requested', async () => {
  invokeDesktop.mockResolvedValueOnce(emptySnapshot());

  await expect(clearMedia({
    expectedAssetId: ASSET_ID,
    expectedPlaybackId: PLAYBACK_ID,
  })).resolves.toBeNull();

  expect(invokeDesktop).toHaveBeenCalledExactlyOnceWith('clear_media', {
    expectedAssetId: ASSET_ID,
    expectedPlaybackId: PLAYBACK_ID,
  });
});

it.each([
  { expectedAssetId: ASSET_ID },
  { expectedPlaybackId: PLAYBACK_ID },
  { expectedAssetId: PLAYBACK_ID, expectedPlaybackId: PLAYBACK_ID },
  { expectedAssetId: ASSET_ID, expectedPlaybackId: ASSET_ID },
])('refuses an incomplete or invalid conditional clear request', async (request) => {
  await expect(clearMedia(request)).rejects.toMatchObject({ code: 'invalidMediaRequest' });
  expect(invokeDesktop).not.toHaveBeenCalled();
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
