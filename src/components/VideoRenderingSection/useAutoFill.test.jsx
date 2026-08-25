import { renderHook } from '@testing-library/react';

import { useAutoFill } from './useAutoFill';

const MEDIA = Object.freeze({
  __nativeMedia: true,
  assetId: '01890f39-7b62-7c4e-8c9a-000000000102',
  playbackId: '550e8400-e29b-41d4-a716-446655440000',
  name: 'downloaded-video.mp4',
  type: 'video/mp4',
  size: 41_824_511,
  lastModified: 0,
  playbackUrl: `http://127.0.0.1:49152/asset/550e8400-e29b-41d4-a716-446655440000?token=${'a'.repeat(64)}`,
});

const setup = (overrides = {}) => {
  const setSelectedVideoFile = vi.fn();
  const props = {
    autoFillData: {
      timestamp: 1,
      expand: true,
      autoScroll: false,
      videoFile: null,
      source: 'fallback',
    },
    actualVideoUrl: '',
    selectedVideo: null,
    uploadedFile: null,
    subtitlesData: [],
    translatedSubtitles: [],
    narrationResults: [],
    userHasCollapsed: false,
    setIsCollapsed: vi.fn(),
    setUserHasCollapsed: vi.fn(),
    setSelectedVideoFile,
    setSelectedSubtitles: vi.fn(),
    setSelectedNarration: vi.fn(),
    ...overrides,
  };
  const hook = renderHook(() => useAutoFill(props));
  return { ...hook, props, setSelectedVideoFile };
};

test('loads the project-owned native video even before its playback URL notification arrives', () => {
  const { setSelectedVideoFile, unmount } = setup({ uploadedFile: MEDIA });

  expect(setSelectedVideoFile).toHaveBeenCalledExactlyOnceWith(MEDIA);
  unmount();
});

test('never replaces a native video descriptor with a browser playback wrapper', () => {
  const { setSelectedVideoFile, unmount } = setup({
    uploadedFile: MEDIA,
    actualVideoUrl: 'http://127.0.0.1:49152/asset/stale-player-url',
  });

  expect(setSelectedVideoFile).toHaveBeenCalledExactlyOnceWith(MEDIA);
  unmount();
});
