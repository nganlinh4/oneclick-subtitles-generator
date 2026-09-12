import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  default as FileUploadInput,
  reconcileSelectedNativeMedia,
  releaseSelectedNativeMedia,
} from './FileUploadInput';
import { createNativeMediaDescriptor } from '../../platform/mediaService';

const MEDIA = Object.freeze({ assetId: '019ffa3d-8e35-7f92-b3e3-607dd27bb263' });
const SESSION = Object.freeze({
  assetId: MEDIA.assetId,
  cacheId: 'jNQXAC9IVRw',
  projectId: '019ffa3d-8e35-7f92-b3e3-607dd27bb264',
});
const NEW_SESSION = Object.freeze({
  assetId: '019ffa3d-8e35-7f92-b3e3-607dd27bb266',
  cacheId: 'newer',
  projectId: '019ffa3d-8e35-7f92-b3e3-607dd27bb267',
});
const RELEASE_MEDIA = createNativeMediaDescriptor({
  asset: {
    id: MEDIA.assetId,
    displayName: 'fixture.mp4',
    extension: 'mp4',
    sizeBytes: 1024,
    kind: 'video',
  },
  playback: {
    id: '123e4567-e89b-42d3-a456-426614174000',
    playbackUrl: `http://127.0.0.1:49152/asset/123e4567-e89b-42d3-a456-426614174000?token=${'a'.repeat(64)}`,
    mimeType: 'video/mp4',
    byteLength: 1024,
  },
});
const RESTORED_MEDIA = createNativeMediaDescriptor({
  asset: {
    id: MEDIA.assetId,
    displayName: 'fixture.mp4',
    extension: 'mp4',
    sizeBytes: 1024,
    kind: 'video',
  },
  playback: {
    id: '223e4567-e89b-42d3-a456-426614174000',
    playbackUrl: `http://127.0.0.1:49152/asset/223e4567-e89b-42d3-a456-426614174000?token=${'b'.repeat(64)}`,
    mimeType: 'video/mp4',
    byteLength: 1024,
  },
});

test('a remount preserves the URL alias instead of reactivating downloaded media as a local file', async () => {
  const activateAsLocal = vi.fn();
  const applyOwnedSession = vi.fn();

  await expect(reconcileSelectedNativeMedia({
    media: MEDIA,
    activateAsLocal,
    applyOwnedSession,
    readSession: () => SESSION,
    resolveOwner: vi.fn(async () => ({ projectId: SESSION.projectId })),
  })).resolves.toBe('owned-session');

  expect(activateAsLocal).not.toHaveBeenCalled();
  expect(applyOwnedSession).toHaveBeenCalledExactlyOnceWith(MEDIA, SESSION);
});

test('does not report an owned session until its project-bound application finishes', async () => {
  let release;
  const applyOwnedSession = vi.fn(() => new Promise((resolve) => { release = resolve; }));
  let settled = false;
  const pending = reconcileSelectedNativeMedia({
    media: MEDIA,
    activateAsLocal: vi.fn(),
    applyOwnedSession,
    readSession: () => SESSION,
    resolveOwner: vi.fn(async () => ({ projectId: SESSION.projectId })),
  }).then((value) => {
    settled = true;
    return value;
  });

  await vi.waitFor(() => expect(applyOwnedSession).toHaveBeenCalled());
  expect(settled).toBe(false);
  release();
  await expect(pending).resolves.toBe('owned-session');
});

test('media with no durable session remains a genuine local activation', async () => {
  const activateAsLocal = vi.fn(async () => undefined);
  const applyOwnedSession = vi.fn();

  await expect(reconcileSelectedNativeMedia({
    media: MEDIA,
    activateAsLocal,
    applyOwnedSession,
    readSession: () => null,
    resolveOwner: vi.fn(),
  })).resolves.toBe('local');

  expect(activateAsLocal).toHaveBeenCalledExactlyOnceWith(MEDIA);
  expect(applyOwnedSession).not.toHaveBeenCalled();
});

test('a stale matching session fails closed instead of minting an asset-keyed project', async () => {
  const activateAsLocal = vi.fn();
  await expect(reconcileSelectedNativeMedia({
    media: MEDIA,
    activateAsLocal,
    applyOwnedSession: vi.fn(),
    readSession: () => SESSION,
    resolveOwner: vi.fn(async () => null),
  })).rejects.toThrow(/no longer available/i);
  expect(activateAsLocal).not.toHaveBeenCalled();
});

test('release clears only the displayed native capability and withdraws its exact session', async () => {
  const clear = vi.fn(async () => null);
  const forgetSession = vi.fn(() => true);

  await expect(releaseSelectedNativeMedia({
    media: RELEASE_MEDIA,
    clear,
    readSession: () => SESSION,
    forgetSession,
  })).resolves.toBe(SESSION);

  expect(clear).toHaveBeenCalledExactlyOnceWith({
    expectedAssetId: RELEASE_MEDIA.assetId,
    expectedPlaybackId: RELEASE_MEDIA.playbackId,
  });
  expect(forgetSession).toHaveBeenCalledExactlyOnceWith({ expectedSession: SESSION });
});

test('release cannot withdraw a newer session that wins after the native clear', async () => {
  const forgetSession = vi.fn(() => false);
  const readSession = vi.fn()
    .mockReturnValueOnce(SESSION)
    .mockReturnValueOnce(NEW_SESSION);
  const restore = vi.fn();

  await expect(releaseSelectedNativeMedia({
    media: RELEASE_MEDIA,
    clear: vi.fn(async () => null),
    readSession,
    forgetSession,
    restore,
  })).resolves.toBeNull();

  expect(forgetSession).toHaveBeenCalledExactlyOnceWith({ expectedSession: SESSION });
  expect(restore).not.toHaveBeenCalled();
});

test('release preserves the session when the exact native clear refuses', async () => {
  const forgetSession = vi.fn();

  await expect(releaseSelectedNativeMedia({
    media: RELEASE_MEDIA,
    clear: vi.fn(async () => { throw new Error('media changed'); }),
    readSession: () => SESSION,
    forgetSession,
  })).rejects.toThrow('media changed');

  expect(forgetSession).not.toHaveBeenCalled();
});

test('release restores exact playback and refuses the UI change when its session cannot be removed', async () => {
  const restore = vi.fn(async () => RESTORED_MEDIA);

  const rejection = releaseSelectedNativeMedia({
    media: RELEASE_MEDIA,
    clear: vi.fn(async () => null),
    readSession: () => SESSION,
    forgetSession: vi.fn(() => false),
    restore,
  });
  await expect(rejection).rejects.toThrow(/session could not be removed/i);
  await expect(rejection).rejects.toMatchObject({ restoredMedia: RESTORED_MEDIA });

  expect(restore).toHaveBeenCalledExactlyOnceWith(RELEASE_MEDIA.assetId);
});

test('release does not restore old playback when a newer native selection already occupies the host', async () => {
  const restore = vi.fn(async () => null);

  await expect(releaseSelectedNativeMedia({
    media: RELEASE_MEDIA,
    clear: vi.fn(async () => null),
    readSession: () => SESSION,
    forgetSession: vi.fn(() => false),
    restore,
  })).resolves.toBeNull();

  expect(restore).toHaveBeenCalledExactlyOnceWith(RELEASE_MEDIA.assetId);
});

test('removing browser media cannot resurrect SRT-only mode from the stale global subtitle key', async () => {
  localStorage.setItem('subtitles_data', JSON.stringify([
    { start: 0, end: 1, text: 'belongs to an old browser session' },
  ]));
  const setIsSrtOnlyMode = vi.fn();
  const setUploadedFile = vi.fn();
  const media = new File(['fixture'], 'fixture.mp4', { type: 'video/mp4' });

  render(
    <FileUploadInput
      uploadedFile={media}
      setUploadedFile={setUploadedFile}
      setIsSrtOnlyMode={setIsSrtOnlyMode}
      isSrtOnlyMode={false}
      subtitlesData={[]}
    />
  );

  fireEvent.click(await screen.findByRole('button', { name: /remove/i }));

  await waitFor(() => expect(setUploadedFile).toHaveBeenCalledWith(null));
  expect(setIsSrtOnlyMode).not.toHaveBeenCalledWith(true);
});

test('the selected file card follows replacements while the upload tab stays mounted', async () => {
  const first = new File(['first'], 'first.mp4', { type: 'video/mp4' });
  const second = new File(['second'], 'second.mp3', { type: 'audio/mpeg' });
  const props = { setUploadedFile: vi.fn(), isSrtOnlyMode: false };
  const { container, rerender } = render(<FileUploadInput {...props} uploadedFile={first} />);
  expect(await screen.findByText('first.mp4')).toBeInTheDocument();

  rerender(<FileUploadInput {...props} uploadedFile={second} />);
  expect(container.querySelector('.file-name')).toHaveTextContent('second.mp3');
  expect(container.querySelector('.file-badge')).toHaveTextContent('Audio');
  expect(screen.queryByText('first.mp4')).not.toBeInTheDocument();
});

test('a native Matroska video remains a video in the selected file card', async () => {
  const media = { ...RELEASE_MEDIA, name: 'clip.mkv', type: 'video/x-matroska' };
  const { container } = render(<FileUploadInput uploadedFile={media} setUploadedFile={vi.fn()} />);

  expect(await screen.findByText('clip.mkv')).toBeInTheDocument();
  expect(container.querySelector('.file-badge')).toHaveTextContent('Video');
  expect(container.querySelector('.file-type-icon')).toHaveTextContent('videocam');
});
