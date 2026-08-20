import { invokeDesktop } from './desktopRuntime';
import {
  exportReferenceImagePlayback,
  importReferenceImage,
  releaseReferenceImage,
  releaseReferenceImagePlayback,
  selectReferenceImagePlayback,
} from './imageService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000201';
const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000202';
const PLAYBACK_ID = '4a8672f4-6e8f-4a16-8e4a-36b7d20fdb11';
const PLAYBACK_URL = `http://127.0.0.1:43210/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`;

beforeEach(() => {
  vi.clearAllMocks();
});

test('imports a native playback capability using only opaque image and project IDs', async () => {
  invokeDesktop.mockResolvedValue({
    assetId: ASSET_ID,
    mimeType: 'image/png',
    sizeBytes: 16,
  });

  await expect(importReferenceImage(PLAYBACK_URL, PROJECT_ID)).resolves.toEqual({
    assetId: ASSET_ID,
    mimeType: 'image/png',
    sizeBytes: 16,
  });
  expect(invokeDesktop).toHaveBeenCalledWith('image_blob_import_playback', {
    request: { playbackId: PLAYBACK_ID, projectId: PROJECT_ID },
  });
  expect(JSON.stringify(invokeDesktop.mock.calls)).not.toMatch(
    /(?:token=|playbackUrl|data:image|base64|"bytes")/i
  );
});

test('rejects non-capability inputs and malformed host metadata', async () => {
  await expect(importReferenceImage('data:image/png;base64,cG5n', PROJECT_ID))
    .rejects.toMatchObject({ code: 'invalidImageRequest' });
  await expect(importReferenceImage(PLAYBACK_URL, 'not-a-project'))
    .rejects.toMatchObject({ code: 'invalidImageRequest' });
  expect(invokeDesktop).not.toHaveBeenCalled();

  invokeDesktop.mockResolvedValue({
    assetId: ASSET_ID,
    mimeType: 'image/gif',
    sizeBytes: 5,
  });
  await expect(importReferenceImage(PLAYBACK_URL, PROJECT_ID))
    .rejects.toMatchObject({ code: 'invalidImageResponse' });
});

test('releases only a validated opaque image ID', async () => {
  invokeDesktop.mockResolvedValue(true);
  await expect(releaseReferenceImage(ASSET_ID)).resolves.toBe(true);
  expect(invokeDesktop).toHaveBeenCalledWith('image_blob_release', { assetId: ASSET_ID });
  await expect(releaseReferenceImage('not-an-id'))
    .rejects.toMatchObject({ code: 'invalidImageRequest' });
});

test('selects and releases a local reference through native playback capabilities only', async () => {
  invokeDesktop
    .mockResolvedValueOnce({
      id: PLAYBACK_ID,
      playbackUrl: PLAYBACK_URL,
      mimeType: 'image/png',
      byteLength: 16,
    })
    .mockResolvedValueOnce(true);

  await expect(selectReferenceImagePlayback(PROJECT_ID)).resolves.toEqual({
    id: PLAYBACK_ID,
    playbackUrl: PLAYBACK_URL,
    mimeType: 'image/png',
    byteLength: 16,
    projectId: PROJECT_ID,
  });
  await expect(releaseReferenceImagePlayback({
    playbackId: PLAYBACK_ID,
    projectId: PROJECT_ID,
  })).resolves.toBe(true);
  expect(invokeDesktop).toHaveBeenNthCalledWith(1, 'image_reference_select', {
    request: { projectId: PROJECT_ID },
  });
  expect(invokeDesktop).toHaveBeenNthCalledWith(2, 'image_reference_playback_release', {
    request: { playbackId: PLAYBACK_ID, projectId: PROJECT_ID },
  });
});

test('fails closed on malformed local playback selections and release IDs', async () => {
  invokeDesktop.mockResolvedValue({
    id: PLAYBACK_ID,
    playbackUrl: PLAYBACK_URL,
    mimeType: 'image/gif',
    byteLength: 16,
  });
  await expect(selectReferenceImagePlayback(PROJECT_ID))
    .rejects.toMatchObject({ code: 'invalidImageResponse' });
  await expect(releaseReferenceImagePlayback({
    playbackId: ASSET_ID,
    projectId: PROJECT_ID,
  }))
    .rejects.toMatchObject({ code: 'invalidImageRequest' });
});

test('exports a reference capability with only its exact project, playback, and safe name', async () => {
  invokeDesktop.mockResolvedValue(true);
  await expect(exportReferenceImagePlayback(
    PLAYBACK_URL,
    PROJECT_ID,
    'album-art.png'
  )).resolves.toBe(true);
  expect(invokeDesktop).toHaveBeenCalledWith('image_reference_export', {
    request: {
      projectId: PROJECT_ID,
      playbackId: PLAYBACK_ID,
      suggestedName: 'album-art.png',
    },
  });
  expect(JSON.stringify(invokeDesktop.mock.calls)).not.toMatch(
    /(?:token=|playbackUrl|data:image|base64|"bytes"|Uint8Array|Blob)/i
  );
});

test('rejects hostile reference export metadata before IPC', async () => {
  for (const [url, projectId, name] of [
    ['data:image/png;base64,cG5n', PROJECT_ID, 'album-art.png'],
    [PLAYBACK_URL, 'not-a-project', 'album-art.png'],
    [PLAYBACK_URL, PROJECT_ID, '../album-art.png'],
    [PLAYBACK_URL, PROJECT_ID, 'album-art.exe'],
  ]) {
    await expect(exportReferenceImagePlayback(url, projectId, name))
      .rejects.toMatchObject({ code: 'invalidImageRequest' });
  }
  expect(invokeDesktop).not.toHaveBeenCalled();
});
