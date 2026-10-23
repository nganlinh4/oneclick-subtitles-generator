import { startCanvasFrameScheduler } from './canvasFrameScheduler';

const ref = (current) => ({ current });

const frameState = () => ({
  sourceKey: null, source: null, mediaTime: null, transportTime: null, provenance: null,
});

const startWith = (video) => {
  const drawRef = ref(() => undefined);
  const stop = startCanvasFrameScheduler({
    videoRef: ref(video),
    sourceKey: 'source-a',
    publish: vi.fn(),
    latestRef: ref({ sourceKey: 'source-a', playing: false, currentTime: 0, frameRate: 30 }),
    rendererRef: ref(null),
    canvasRef: ref(null),
    cacheRef: ref(new Map()),
    pendingRef: ref(new Map()),
    lifecycleGenerationRef: ref(0),
    rendererFailureRef: ref(null),
    drawRef,
    publishedRef: ref(''),
    overlayRebuildsRef: ref(0),
    revisionRef: ref(0),
    cueCursorRef: ref({ index: 0, time: Number.NEGATIVE_INFINITY, sceneKey: '' }),
    presentedFrameRef: ref(frameState()),
    presentedSceneRef: ref({ sourceKey: null, time: null }),
    desiredPixelFrameRef: ref(frameState()),
    committedPixelFrameRef: ref(frameState()),
    publishedSceneRef: ref({ sourceKey: null, time: null }),
  });
  return { stop, drawRef };
};

const fakeVideo = () => ({
  readyState: 0,
  seeking: false,
  paused: true,
  requestVideoFrameCallback: vi.fn(() => 41),
  cancelVideoFrameCallback: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

const MEDIA_EVENTS = ['loadeddata', 'canplay', 'seeked', 'seeking', 'loadstart', 'emptied'];

test('arms one frame callback and the media events, then disarms all of them on stop', () => {
  const video = fakeVideo();
  const { stop, drawRef } = startWith(video);

  expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(1);
  expect(video.addEventListener.mock.calls.map(([name]) => name)).toEqual(MEDIA_EVENTS);
  expect(drawRef.current).not.toBe(undefined);

  stop();

  expect(video.cancelVideoFrameCallback).toHaveBeenCalledExactlyOnceWith(41);
  expect(video.removeEventListener.mock.calls.map(([name]) => name)).toEqual(MEDIA_EVENTS);
  expect(drawRef.current()).toBeUndefined();
});

test('a seek supersedes the armed callback and re-arms exactly one', () => {
  const video = fakeVideo();
  const { stop } = startWith(video);
  const onSeeking = video.addEventListener.mock.calls.find(([name]) => name === 'seeking')[1];

  onSeeking();

  expect(video.cancelVideoFrameCallback).toHaveBeenCalledExactlyOnceWith(41);
  expect(video.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
  stop();
});
