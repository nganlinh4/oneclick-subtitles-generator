// Quality re-download publication: the new asset becomes the active media of the SAME project and
// alias (pointer, preview), and a failed publication leaves the previous media exactly in place.
import { act, renderHook } from '@testing-library/react';

import { inspectDownloadUrl, startDownload } from '../../platform/downloadService';
import {
  claimMediaCandidate,
  createNativeMediaDescriptor,
  discardMediaCandidate,
  getSelectedMedia,
  openMediaAsset,
} from '../../platform/mediaService';
import {
  ensureProjectOwnsNativeMedia,
  readNativeMediaSession,
  resolveOwnedNativeMediaProject,
} from '../../platform/nativeMediaOwnership';
import { resolveProjectForCache } from '../../platform/subtitleProjectStore';
import {
  activateSubtitleProjectBinding,
  rollbackSubtitleProjectBinding,
} from '../../platform/subtitleProjectBinding';
import { generateUrlBasedCacheId } from '../../services/subtitleCache';
import useQualityProgressTracking from './useQualityProgressTracking';
import { readActiveMedia, updateActiveMedia } from '../../platform/activeMediaSource';

vi.mock('@tauri-apps/api/core', () => ({ Channel: class Channel {}, invoke: vi.fn() }));
vi.mock('../../platform/desktopRuntime', () => ({
  isDesktopRuntime: () => true,
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));
vi.mock('../../platform/downloadService', () => ({
  cancelDownload: vi.fn(),
  inspectDownloadUrl: vi.fn(),
  startDownload: vi.fn(),
}));
vi.mock('../../platform/nativeDownloadPreflight', () => ({
  recoverNativeDownloaderAfterFailure: vi.fn(async () => ({ checked: false })),
}));
vi.mock('../../platform/mediaService', async (importOriginal) => ({
  ...await importOriginal(),
  claimMediaCandidate: vi.fn(),
  discardMediaCandidate: vi.fn(async () => true),
  getSelectedMedia: vi.fn(),
  openMediaAsset: vi.fn(),
}));
vi.mock('../../platform/nativeMediaOwnership', async (importOriginal) => ({
  ...await importOriginal(),
  ensureProjectOwnsNativeMedia: vi.fn(),
  readNativeMediaSession: vi.fn(),
  resolveOwnedNativeMediaProject: vi.fn(),
}));
vi.mock('../../platform/subtitleProjectStore', () => ({ resolveProjectForCache: vi.fn() }));
vi.mock('../../platform/subtitleProjectBinding', () => ({
  activateSubtitleProjectBinding: vi.fn(),
  isSubtitleProjectBindingReceipt: (value, scope) => (
    value?.kind === 'subtitle-project-binding'
    && value.cacheId === scope.cacheId
    && value.projectId === scope.projectId
  ),
  rollbackSubtitleProjectBinding: vi.fn(() => true),
}));
vi.mock('../../services/subtitleCache', () => ({ generateUrlBasedCacheId: vi.fn() }));
vi.mock('../../utils/userSubtitlesStore', () => ({ getCurrentCacheId: vi.fn(() => 'url-cache') }));

const URL = 'https://www.youtube.com/watch?v=quality';
const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000301';
const OLD_ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000302';
const NEW_ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000303';

const descriptor = (assetId, playbackId, token) => createNativeMediaDescriptor({
  asset: {
    id: assetId,
    displayName: `${token}.mp4`,
    extension: 'mp4',
    sizeBytes: 4096,
    kind: 'video',
  },
  playback: {
    id: playbackId,
    playbackUrl: `http://127.0.0.1:49152/asset/${playbackId}?token=${token.repeat(64)}`,
    mimeType: 'video/mp4',
    byteLength: 4096,
  },
});
const oldMedia = descriptor(OLD_ASSET_ID, '550e8400-e29b-41d4-a716-446655440301', 'a');
const newMedia = descriptor(NEW_ASSET_ID, '550e8400-e29b-41d4-a716-446655440302', 'b');
const reopenedOld = descriptor(OLD_ASSET_ID, '550e8400-e29b-41d4-a716-446655440303', 'c');

const project = (media) => ({
  cacheId: 'url-cache',
  projectId: PROJECT_ID,
  snapshot: {
    metadata: { id: PROJECT_ID, name: 'Downloaded media' },
    stateVersion: 4,
    media: [{
      id: media.assetId,
      displayName: media.name,
      extension: 'mp4',
      sizeBytes: media.size,
      kind: 'video',
    }],
    tracks: [],
  },
});

let session;
let selected;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  updateActiveMedia({ sourceUrl: URL });
  updateActiveMedia({ playbackUrl: oldMedia.playbackUrl });
  session = Object.freeze({ assetId: OLD_ASSET_ID, cacheId: 'url-cache', projectId: PROJECT_ID });
  selected = oldMedia;
  readNativeMediaSession.mockImplementation(() => session);
  resolveOwnedNativeMediaProject.mockImplementation(async () => project(oldMedia));
  getSelectedMedia.mockImplementation(async () => selected);
  generateUrlBasedCacheId.mockResolvedValue('url-cache');
  resolveProjectForCache.mockImplementation(async () => project(oldMedia));
  activateSubtitleProjectBinding.mockImplementation(async (cacheId, options) => ({
    kind: 'subtitle-project-binding',
    cacheId,
    projectId: options.expectedProjectId,
    stateVersion: 4,
  }));
  claimMediaCandidate.mockImplementation(async () => {
    // The host swaps its playback session to the claimed bytes.
    selected = newMedia;
    return newMedia;
  });
  ensureProjectOwnsNativeMedia.mockImplementation(async ({ media, cacheId, expectedProjectId }) => {
    session = Object.freeze({ assetId: media.assetId, cacheId, projectId: expectedProjectId });
    return Object.freeze({ ...session });
  });
  openMediaAsset.mockImplementation(async () => {
    selected = reopenedOld;
    return reopenedOld;
  });
  inspectDownloadUrl.mockResolvedValue({
    capability: { id: '01890f39-7b62-7c4e-8c9a-000000000304' },
    inventory: { formats: { video: [{ formatId: '720', height: 720, includesAudio: true }] } },
  });
  startDownload.mockImplementation(async (_request, handlers) => {
    queueMicrotask(() => handlers.onCompleted({ media: { asset: { id: NEW_ASSET_ID } } }));
    return { id: '01890f39-7b62-7c4e-8c9a-000000000305' };
  });
});

const renderTracking = () => {
  const onMediaReplaced = vi.fn();
  const onConfirm = vi.fn();
  const handleClose = vi.fn();
  const { result } = renderHook(() => useQualityProgressTracking({
    setIsRedownloading: vi.fn(),
    setDownloadProgress: vi.fn(),
    onConfirm,
    handleClose,
    onMediaReplaced,
  }));
  return { result, onMediaReplaced, onConfirm, handleClose };
};

it('publishes the re-downloaded asset as the active media of the same project and alias', async () => {
  const { result, onMediaReplaced, onConfirm } = renderTracking();

  let outcome;
  await act(async () => {
    outcome = await result.current.startQualityDownloadWithId('720p', URL, 'quality-id');
  });

  expect(outcome).toEqual({ success: true, nativeMedia: newMedia });
  expect(activateSubtitleProjectBinding).toHaveBeenCalledWith('url-cache', {
    expectedProjectId: PROJECT_ID,
    create: false,
  });
  expect(ensureProjectOwnsNativeMedia).toHaveBeenCalledExactlyOnceWith({
    media: newMedia,
    cacheId: 'url-cache',
    expectedProjectId: PROJECT_ID,
  });
  expect(session).toEqual({ assetId: NEW_ASSET_ID, cacheId: 'url-cache', projectId: PROJECT_ID });
  expect(onMediaReplaced).toHaveBeenCalledExactlyOnceWith(newMedia);
  expect(onMediaReplaced.mock.invocationCallOrder[0])
    .toBeLessThan(onConfirm.mock.invocationCallOrder[0]);
  expect(readActiveMedia().playbackUrl).toBe(newMedia.playbackUrl);
  // The playback capability carries the media server's token and never reaches WebView storage.
  expect(JSON.stringify({ ...localStorage })).not.toContain(newMedia.playbackUrl);
  expect(resolveProjectForCache).not.toHaveBeenCalledWith(expect.anything(), { create: true });
  expect(discardMediaCandidate).not.toHaveBeenCalled();
});

it('restores the previous media, pointer and preview when publication fails after the claim', async () => {
  ensureProjectOwnsNativeMedia.mockRejectedValueOnce(new Error('pointer write refused'));
  const { result, onMediaReplaced, onConfirm } = renderTracking();

  await expect(act(async () => (
    result.current.startQualityDownloadWithId('720p', URL, 'quality-id')
  ))).rejects.toMatchObject({ code: 'mediaOpenFailed' });

  expect(rollbackSubtitleProjectBinding).toHaveBeenCalledOnce();
  expect(ensureProjectOwnsNativeMedia).toHaveBeenLastCalledWith({
    media: oldMedia,
    cacheId: 'url-cache',
    expectedProjectId: PROJECT_ID,
  });
  expect(session).toEqual({ assetId: OLD_ASSET_ID, cacheId: 'url-cache', projectId: PROJECT_ID });
  expect(openMediaAsset).toHaveBeenCalledExactlyOnceWith(OLD_ASSET_ID);
  expect(onMediaReplaced).toHaveBeenCalledExactlyOnceWith(reopenedOld);
  expect(readActiveMedia().playbackUrl).toBe(reopenedOld.playbackUrl);
  expect(discardMediaCandidate).toHaveBeenCalledExactlyOnceWith(NEW_ASSET_ID);
  expect(onConfirm).not.toHaveBeenCalled();
});

it('refuses before downloading when the URL is not the source of the active media', async () => {
  generateUrlBasedCacheId.mockResolvedValue('another-url-cache');
  const { result, onMediaReplaced } = renderTracking();

  await expect(act(async () => (
    result.current.startQualityDownloadWithId('720p', URL, 'quality-id')
  ))).rejects.toMatchObject({ code: 'qualityRedownloadOwnershipLost' });

  expect(inspectDownloadUrl).not.toHaveBeenCalled();
  expect(resolveProjectForCache).not.toHaveBeenCalled();
  expect(onMediaReplaced).not.toHaveBeenCalled();
});

it('discards the candidate without claiming when other media became active during the download', async () => {
  startDownload.mockImplementation(async (_request, handlers) => {
    queueMicrotask(() => {
      session = Object.freeze({
        assetId: '01890f39-7b62-7c4e-8c9a-000000000306',
        cacheId: 'local-cache',
        projectId: '01890f39-7b62-7c4e-8c9a-000000000307',
      });
      handlers.onCompleted({ media: { asset: { id: NEW_ASSET_ID } } });
    });
    return { id: '01890f39-7b62-7c4e-8c9a-000000000305' };
  });
  const { result, onMediaReplaced } = renderTracking();

  await expect(act(async () => (
    result.current.startQualityDownloadWithId('720p', URL, 'quality-id')
  ))).rejects.toBeDefined();

  expect(claimMediaCandidate).not.toHaveBeenCalled();
  expect(ensureProjectOwnsNativeMedia).not.toHaveBeenCalled();
  expect(onMediaReplaced).not.toHaveBeenCalled();
  expect(discardMediaCandidate).toHaveBeenCalledExactlyOnceWith(NEW_ASSET_ID);
});
