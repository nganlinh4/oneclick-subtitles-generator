import { act, render, screen } from '@testing-library/react';

import OutputContainer from './OutputContainer';

const lyricsSurface = vi.hoisted(() => ({ props: null }));
const previewSurface = vi.hoisted(() => ({ history: [], props: null }));
const narrationSurface = vi.hoisted(() => ({ props: null }));
const translationSurface = vi.hoisted(() => ({
  t: (_key, fallback) => fallback,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translationSurface.t }),
}));
vi.mock('./previews/VideoPreview', () => ({
  default: (componentProps) => {
    previewSurface.props = componentProps;
    previewSurface.history.push(componentProps);
    return <div data-testid="video-preview">{componentProps.videoSource}</div>;
  },
}));
vi.mock('./LyricsDisplay', () => ({
  default: (componentProps) => {
    lyricsSurface.props = componentProps;
    return <div data-testid="lyrics-title">{componentProps.videoTitle}</div>;
  },
}));
vi.mock('./translation', () => ({ default: () => <div data-testid="translation" /> }));
vi.mock('./narration', () => ({
  UnifiedNarrationSection: (componentProps) => {
    narrationSurface.props = componentProps;
    return <div data-testid="narration" />;
  },
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
const mediaB = Object.freeze({
  native: true,
  name: 'Video B.mp4',
  playbackUrl: 'http://127.0.0.1/video-b',
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
  previewSurface.props = null;
  previewSurface.history = [];
  narrationSurface.props = null;
  translationSurface.t = (_key, fallback) => fallback;
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

it('changes native media identity atomically with the project-owned cue track', async () => {
  const view = render(<OutputContainer {...props} />);
  await act(async () => vi.advanceTimersByTime(1_000));
  previewSurface.history = [];
  const subtitlesB = [{ start: 3, end: 4, text: 'B subtitle' }];
  const oldReadyPublisher = previewSurface.props.onVideoUrlReady;
  act(() => {
    previewSurface.props.setCurrentTime(8);
    previewSurface.props.setDuration(20);
    oldReadyPublisher('http://127.0.0.1/video-a-prepared');
  });
  expect(lyricsSurface.props).toMatchObject({
    currentTime: 8,
    duration: 20,
    videoSource: 'http://127.0.0.1/video-a-prepared',
  });

  view.rerender(
    <OutputContainer {...props} uploadedFile={mediaB} subtitlesData={subtitlesB} />,
  );

  expect(previewSurface.history).not.toContainEqual(expect.objectContaining({
    subtitlesArray: subtitlesB,
    videoSource: mediaA.playbackUrl,
  }));
  expect(previewSurface.props).toMatchObject({
    currentTime: 0,
    subtitlesArray: subtitlesB,
    videoSource: mediaB.playbackUrl,
  });
  expect(lyricsSurface.props).toMatchObject({
    currentTime: 0,
    duration: 0,
    videoSource: '',
  });
  expect(narrationSurface.props.videoPath).toBe('');

  // A slow source-A mirror completion may still publish after B commits. Its source-bound callback
  // cannot populate B's waveform or narration path.
  act(() => oldReadyPublisher('http://127.0.0.1/video-a-late'));
  expect(lyricsSurface.props.videoSource).toBe('');
  expect(narrationSurface.props.videoPath).toBe('');

  act(() => previewSurface.props.onVideoUrlReady('http://127.0.0.1/video-b-prepared'));
  expect(lyricsSurface.props.videoSource).toBe('http://127.0.0.1/video-b-prepared');
  expect(narrationSurface.props.videoPath).toBe('http://127.0.0.1/video-b-prepared');

  act(() => lyricsSurface.props.onLyricClick(3));
  expect(previewSurface.props.seekRequest).toEqual({
    generation: 1,
    mediaKey: mediaB.playbackUrl,
    time: 3,
  });
});

it('publishes an all-deleted timeline to the single app-level subtitle authority', async () => {
  const setSubtitlesData = vi.fn();
  render(<OutputContainer {...props} setSubtitlesData={setSubtitlesData} />);
  await act(async () => vi.advanceTimersByTime(1_000));

  act(() => lyricsSurface.props.onUpdateLyrics([]));

  expect(setSubtitlesData).toHaveBeenCalledExactlyOnceWith([]);
});

it('publishes lyric clicks as monotonic seek commands instead of overloading playhead state', async () => {
  const view = render(<OutputContainer {...props} />);
  await act(async () => vi.advanceTimersByTime(1_000));

  act(() => lyricsSurface.props.onLyricClick(1));
  const first = previewSurface.props.seekRequest;
  expect(first).toEqual({
    generation: 1,
    mediaKey: mediaA.playbackUrl,
    time: 1,
  });
  expect(previewSurface.props.currentTime).toBe(0);

  act(() => previewSurface.props.onSeekRequestConsumed(first));
  expect(previewSurface.props.seekRequest).toBeNull();

  // Download transitions unmount the preview. A consumed command must remain absent when the same
  // logical preview mounts again instead of jumping playback back to the old lyric.
  view.rerender(<OutputContainer {...props} isDownloading />);
  expect(screen.queryByTestId('video-preview')).toBeNull();
  view.rerender(<OutputContainer {...props} isDownloading={false} />);
  expect(previewSurface.props.seekRequest).toBeNull();

  // This request is only 100 ms away. It must remain a distinct command, not be dropped by the
  // old playhead-difference heuristic.
  act(() => lyricsSurface.props.onLyricClick(1.1));
  expect(previewSurface.props.seekRequest).toEqual({
    generation: 2,
    mediaKey: mediaA.playbackUrl,
    time: 1.1,
  });
  expect(previewSurface.props.currentTime).toBe(0);

  // A delayed acknowledgement from the previous preview instance must not erase a newer command.
  act(() => previewSurface.props.onSeekRequestConsumed(first));
  expect(previewSurface.props.seekRequest).toEqual({
    generation: 2,
    mediaKey: mediaA.playbackUrl,
    time: 1.1,
  });

  act(() => previewSurface.props.onSeekRequestConsumed(previewSurface.props.seekRequest));
  expect(previewSurface.props.seekRequest).toBeNull();
});

it('consumes each status publication once across translation and unrelated rerenders', () => {
  const success = { message: 'Subtitle file uploaded successfully!', type: 'success' };
  const view = render(
    <OutputContainer {...props} status={success} statusEventId={41} />,
  );

  expect(window.addToast).toHaveBeenCalledExactlyOnceWith(
    success.message,
    'success',
    5000,
    'output-status',
  );

  // A language change gives useTranslation a new translator function. It may rerender the surface,
  // but it is not a new status publication and must not restart an already-expired toast.
  translationSurface.t = (_key, fallback) => `translated:${fallback}`;
  view.rerender(
    <OutputContainer {...props} status={success} statusEventId={41} timeFormat="hms" />,
  );
  expect(window.addToast).toHaveBeenCalledTimes(1);

  // A later operation is allowed to publish the exact same payload. Its event ID makes that a real
  // new notification instead of being suppressed by message-based deduplication.
  view.rerender(
    <OutputContainer {...props} status={success} statusEventId={42} timeFormat="hms" />,
  );
  expect(window.addToast).toHaveBeenCalledTimes(2);
  expect(window.addToast).toHaveBeenLastCalledWith(
    success.message,
    'success',
    5000,
    'output-status',
  );
});

it('forwards first-run failures once and never collapses two occurrences behind a progress key', () => {
  localStorage.removeItem('has_visited_site');
  localStorage.removeItem('onboarding_controls_dismissed');
  const failure = { message: 'The imported media could not be activated', type: 'error' };
  const view = render(
    <OutputContainer {...props} status={failure} statusEventId={51} />,
  );

  expect(window.addToast).toHaveBeenCalledExactlyOnceWith(failure.message, 'error', 5000);

  view.rerender(<OutputContainer {...props} status={failure} statusEventId={52} />);
  expect(window.addToast).toHaveBeenCalledTimes(2);
  expect(window.addToast).toHaveBeenLastCalledWith(failure.message, 'error', 5000);
});
