// A picked or dropped file is the active media only once its project owns it durably: the asset
// is committed into its alias project and that exact record is persisted before React sees it.
import { act, renderHook } from '@testing-library/react';
import useNativeMediaInput from './useNativeMediaInput';
import { ensureProjectOwnsNativeMedia } from '../../platform/nativeMediaOwnership';
import { activateSubtitleProjectBinding } from '../../platform/subtitleProjectBinding';
import { createNativeMediaDescriptor } from '../../platform/mediaService';

vi.mock('../../platform/desktopRuntime', async (importOriginal) => ({
  ...(await importOriginal()),
  isDesktopRuntime: () => false,
}));
vi.mock('../../platform/nativeMediaOwnership', async (importOriginal) => ({
  ...(await importOriginal()),
  ensureProjectOwnsNativeMedia: vi.fn(),
}));
vi.mock('../../platform/subtitleProjectBinding', async (importOriginal) => ({
  ...(await importOriginal()),
  activateSubtitleProjectBinding: vi.fn(async () => 'receipt'),
}));

const ASSET = '018f47a2-7c20-7f70-8000-000000000021';
const PROJECT = '018f47a2-7c20-7f70-8000-0000000000c1';
const MEDIA = createNativeMediaDescriptor({
  asset: { displayName: 'local.mp4', extension: 'mp4', id: ASSET, kind: 'video', sizeBytes: 10 },
  playback: {
    byteLength: 10,
    id: '123e4567-e89b-42d3-a456-426614174020',
    mimeType: 'video/mp4',
    playbackUrl: `http://127.0.0.1:49152/asset/123e4567-e89b-42d3-a456-426614174020?token=${'d'.repeat(64)}`,
  },
});

const renderInput = () => {
  const props = {
    fileInputRef: { current: null },
    isLoading: false,
    isSrtOnlyMode: false,
    onVideoSelect: vi.fn(),
    setIsDragOver: vi.fn(),
    setIsLoading: vi.fn(),
    setIsSrtOnlyMode: vi.fn(),
    setStatus: vi.fn(),
    setUploadedFile: vi.fn(),
    setUploadedFileData: vi.fn(),
    t: (_key, fallback) => fallback,
  };
  const { result } = renderHook(() => useNativeMediaInput(props));
  return { props, activate: (...args) => result.current.activateNativeMedia(...args) };
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it.each([
  ['its own asset alias', ASSET],
  ['the subtitle document it was attached to', 'subtitle-document:fixture'],
])('makes a picked or dropped file reopenable under %s before showing it', async (_label, alias) => {
  ensureProjectOwnsNativeMedia.mockResolvedValueOnce(Object.freeze({
    assetId: ASSET, cacheId: alias, projectId: PROJECT,
  }));
  const { props, activate } = renderInput();

  await act(() => activate(MEDIA));

  expect(ensureProjectOwnsNativeMedia).toHaveBeenCalledExactlyOnceWith({
    media: MEDIA, cacheId: ASSET,
  });
  expect(activateSubtitleProjectBinding).toHaveBeenCalledExactlyOnceWith(alias, {
    expectedProjectId: PROJECT, create: false,
  });
  expect(props.setUploadedFile).toHaveBeenCalledExactlyOnceWith(MEDIA);
  expect(ensureProjectOwnsNativeMedia.mock.invocationCallOrder[0])
    .toBeLessThan(props.setUploadedFile.mock.invocationCallOrder[0]);
  expect(localStorage.getItem('current_file_url')).toBe(MEDIA.playbackUrl);
});

it('never shows a file whose project ownership could not be recorded', async () => {
  ensureProjectOwnsNativeMedia.mockRejectedValueOnce(new Error('nativeMediaOwnershipFailed'));
  const { props, activate } = renderInput();

  await expect(act(() => activate(MEDIA))).rejects.toThrow('nativeMediaOwnershipFailed');

  expect(activateSubtitleProjectBinding).not.toHaveBeenCalled();
  expect(props.setUploadedFile).not.toHaveBeenCalled();
});

it('drops a selection that a newer one superseded during the ownership commit', async () => {
  ensureProjectOwnsNativeMedia.mockResolvedValueOnce(Object.freeze({
    assetId: ASSET, cacheId: ASSET, projectId: PROJECT,
  }));
  const { props, activate } = renderInput();

  await act(() => activate(MEDIA, () => false));

  expect(activateSubtitleProjectBinding).not.toHaveBeenCalled();
  expect(props.setUploadedFile).not.toHaveBeenCalled();
});
