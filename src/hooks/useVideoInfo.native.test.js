import { renderHook, waitFor } from '@testing-library/react';

import { inspectMediaPipelineAsset } from '../platform/mediaPipelineService';
import {
  resolveActiveNativeMedia,
  revalidateActiveNativeMedia,
} from '../platform/activeNativeMedia';
import { useVideoInfo } from './useVideoInfo';

vi.mock('../platform/mediaPipelineService', () => ({
  inspectMediaPipelineAsset: vi.fn(),
}));
vi.mock('../platform/activeNativeMedia', () => ({
  resolveActiveNativeMedia: vi.fn(),
  revalidateActiveNativeMedia: vi.fn(),
}));
vi.mock('../platform/desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  isDesktopRuntime: () => true,
}));
vi.mock('../platform/mediaService', async (importOriginal) => ({
  ...(await importOriginal()),
  isNativeMediaDescriptor: (value) => value?.__nativeMedia === true,
}));

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const MEDIA = Object.freeze({
  __nativeMedia: true,
  assetId: ASSET_ID,
  name: 'clip.mp4',
  type: 'video/mp4',
});

beforeEach(() => {
  localStorage.clear();
  inspectMediaPipelineAsset.mockReset();
  resolveActiveNativeMedia.mockReset();
  revalidateActiveNativeMedia.mockReset();
  const capability = Object.freeze({ assetId: ASSET_ID });
  resolveActiveNativeMedia.mockResolvedValue(capability);
  revalidateActiveNativeMedia.mockResolvedValue(capability);
  inspectMediaPipelineAsset.mockResolvedValue({
    assetId: ASSET_ID,
    durationUs: 2_000_000,
    hasVideo: true,
    hasAudio: true,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    frameRate: 29.97,
    compatibilityAction: 'direct',
    issues: [],
  });
});

it('probes a native upload by opaque asset ID and never calls the legacy HTTP endpoint', async () => {
  const fetchSpy = vi.spyOn(global, 'fetch');
  const { result } = renderHook(() => useVideoInfo(null, MEDIA, MEDIA.playbackUrl));

  await waitFor(() => expect(result.current.actualDimensions).toMatchObject({
    videoId: ASSET_ID,
    width: 1920,
    height: 1080,
    dimensions: '1920x1080',
    quality: '1080p',
    fps: 29.97,
    codec: 'h264',
    audio_codec: 'aac',
  }));

  expect(inspectMediaPipelineAsset).toHaveBeenCalledWith(ASSET_ID);
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

it('keeps active native video A authoritative while URL video B is only staged', async () => {
  const selectedB = {
    id: 'BBBBBBBBBBB',
    source: 'youtube',
    title: 'Video B',
    url: 'https://youtube.com/watch?v=BBBBBBBBBBB',
  };
  const { result } = renderHook(() => useVideoInfo(selectedB, MEDIA, MEDIA.playbackUrl));

  await waitFor(() => expect(result.current.actualDimensions?.videoId).toBe(ASSET_ID));
  expect(result.current.videoInfo).toMatchObject({
    source: 'upload',
    title: 'clip.mp4',
    url: null,
  });
  expect(result.current.getVideoInfoForModal().canRedownload).toBe(false);
  await expect(result.current.getVideoFileForRendering('current')).resolves.toBe(MEDIA);
});
