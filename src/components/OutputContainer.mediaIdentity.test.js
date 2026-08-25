import { act, render, screen } from '@testing-library/react';

import OutputContainer from './OutputContainer';

const lyricsSurface = vi.hoisted(() => ({ props: null }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));
vi.mock('./previews/VideoPreview', () => ({
  default: ({ videoSource }) => <div data-testid="video-preview">{videoSource}</div>,
}));
vi.mock('./LyricsDisplay', () => ({
  default: (componentProps) => {
    lyricsSurface.props = componentProps;
    return <div data-testid="lyrics-title">{componentProps.videoTitle}</div>;
  },
}));
vi.mock('./translation', () => ({ default: () => <div data-testid="translation" /> }));
vi.mock('./narration', () => ({
  UnifiedNarrationSection: () => <div data-testid="narration" />,
}));
vi.mock('./ParallelProcessingStatus', () => ({ default: () => null }));
vi.mock('../events/bus', () => ({
  EVENTS: {
    RETRY_SEGMENT_FROM_CACHE: 'retry',
    RETRY_SEGMENT_FROM_CACHE_COMPLETE: 'retry-done',
    STREAMING_COMPLETE: 'stream-done',
    STREAMING_UPDATE: 'stream',
  },
  subscribe: () => () => undefined,
}));
vi.mock('../hooks/useLyricsSave', () => ({ useLyricsSave: () => undefined }));
vi.mock('../platform/mediaService', () => ({
  isNativeMediaDescriptor: (value) => value?.native === true,
}));
vi.mock('../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../utils/videoUtils', () => ({ hasValidDownloadedVideo: () => true }));

const mediaA = Object.freeze({
  native: true,
  name: 'Video A.mp4',
  playbackUrl: 'http://127.0.0.1/video-a',
  type: 'video/mp4',
});

const props = {
  activeTab: 'unified-url',
  segmentsStatus: [],
  selectedVideo: { title: 'Video B', url: 'https://example.test/b' },
  setSubtitlesData: vi.fn(),
  status: { message: 'Downloading video...', type: 'loading' },
  subtitlesData: [{ start: 0, end: 1, text: 'A subtitle' }],
  uploadedFile: mediaA,
};

beforeEach(() => {
  vi.clearAllMocks();
  lyricsSurface.props = null;
  vi.useFakeTimers();
  window.addToast = vi.fn();
  window.removeToastByKey = vi.fn();
  localStorage.setItem('has_visited_site', 'true');
  localStorage.setItem('onboarding_controls_dismissed', 'true');
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

it('never presents active video A as pending video B', async () => {
  const view = render(<OutputContainer {...props} isDownloading />);
  await act(async () => vi.advanceTimersByTime(1_000));

  expect(screen.queryByTestId('video-preview')).toBeNull();
  expect(screen.queryByTestId('lyrics-title')).toBeNull();

  view.rerender(<OutputContainer {...props} isDownloading={false} />);
  expect(screen.getByTestId('video-preview')).toHaveTextContent('video-a');
  expect(screen.getByTestId('lyrics-title')).toHaveTextContent('Video A');
  expect(screen.getByTestId('lyrics-title')).not.toHaveTextContent('Video B');
});

it('publishes an all-deleted timeline to the single app-level subtitle authority', async () => {
  const setSubtitlesData = vi.fn();
  render(<OutputContainer {...props} setSubtitlesData={setSubtitlesData} />);
  await act(async () => vi.advanceTimersByTime(1_000));

  act(() => lyricsSurface.props.onUpdateLyrics([]));

  expect(setSubtitlesData).toHaveBeenCalledExactlyOnceWith([]);
});
