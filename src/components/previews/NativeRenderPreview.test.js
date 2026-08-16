import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import useNativePreview from './native/useNativePreview';
import NativeRenderPreview from './NativeRenderPreview';

/**
 * The render tab's preview panel, which used to be `@remotion/player` running a second
 * implementation of the export composition.
 *
 * What matters here is what the rest of the tab depends on: the imperative `seekTo(frame)` the trim
 * timeline drives, the duration it reports, and that the composited frame owns the surface exactly
 * when playback is stopped. The transport itself is proven in `native/useNativePreviewFrame.test.js`
 * and is stubbed out, because this file is about the panel.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // Interpolates the way i18next does, so an assertion about a reported code is an assertion
    // about what a user would actually read.
    t: (_key, fallback, values = {}) => String(fallback).replace(
      /\{\{(\w+)\}\}/g,
      (whole, name) => (name in values ? String(values[name]) : whole),
    ),
  }),
}));

vi.mock('../VideoCropControls', () => ({
  default: ({ isEnabled }) => <div data-testid="crop-controls" data-enabled={String(isEnabled)} />,
}));

vi.mock('../../platform/mediaService', () => ({ isNativeMediaDescriptor: () => false }));

vi.mock('./native/useNativePreview', () => ({ default: vi.fn() }));

const FRAME_URL = 'http://127.0.0.1:49152/frame/3f2504e0-4f89-41d3-9a0c-0305e82c3301/0?token=a&frame_token=b';

const dormant = () => ({
  frame: null, status: 'idle', error: null, onFrameLoadError: vi.fn(), releaseSurface: vi.fn(), owned: false,
});

const showing = (layer = 'composited') => ({
  frame: { url: FRAME_URL, cacheKey: 'k', frameIndex: 0, layer },
  status: 'ready',
  error: null,
  onFrameLoadError: vi.fn(),
  releaseSurface: vi.fn(),
  layer,
  owned: layer === 'composited',
});

const subtitles = [{ start: 0, end: 2, text: 'A cue' }];

beforeEach(() => {
  vi.mocked(useNativePreview).mockReset();
  vi.mocked(useNativePreview).mockReturnValue(dormant());
});

describe('with no video selected', () => {
  it('shows the placeholder and no longer credits a renderer it does not use', () => {
    render(<NativeRenderPreview videoFile={null} subtitles={subtitles} subtitleCustomization={{}} />);

    expect(screen.getByText('No video selected')).toBeInTheDocument();
    expect(screen.queryByText(/Remotion/i)).toBeNull();
  });
});

describe('with a video selected', () => {
  const mount = (props = {}) => {
    const ref = createRef();
    const utils = render(
      <NativeRenderPreview
        ref={ref}
        videoFile="C:/media/clip.mp4"
        subtitles={subtitles}
        subtitleCustomization={{ fontSize: 50, maxWidth: 80 }}
        resolution="1080p"
        frameRate={30}
        {...props}
      />,
    );
    return { ref, ...utils, video: utils.container.querySelector('video') };
  };

  it('plays the source in a video element and keeps the crop controls once it has a size', () => {
    const { video } = mount();
    expect(video.getAttribute('src')).toBe('C:/media/clip.mp4');
    expect(screen.queryByTestId('crop-controls')).toBeNull();

    Object.defineProperty(video, 'duration', { value: 12, configurable: true });
    Object.defineProperty(video, 'videoWidth', { value: 1920, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 1080, configurable: true });
    fireEvent.loadedMetadata(video);

    expect(screen.getByTestId('crop-controls')).toBeInTheDocument();
  });

  it('reports the duration the trim timeline is scaled against', () => {
    const onDurationChange = vi.fn();
    const { video } = mount({ onDurationChange });

    Object.defineProperty(video, 'duration', { value: 12.5, configurable: true });
    fireEvent.loadedMetadata(video);

    expect(onDurationChange).toHaveBeenCalledWith(12.5);
  });

  it('keeps seekTo(frame) working, which is the only player API the trim row uses', () => {
    const onSeek = vi.fn();
    const { ref, video } = mount({ onSeek, frameRate: 25 });

    act(() => ref.current.seekTo(50));

    expect(video.currentTime).toBe(2);
    expect(onSeek).toHaveBeenCalledWith(2);
    expect(ref.current.getCurrentFrame()).toBe(50);
  });

  it('composes at the crop the user is dragging, not the crop that was applied', () => {
    mount({ cropSettings: { x: 0, y: 0, width: 50, height: 25 } });

    const call = vi.mocked(useNativePreview).mock.calls.at(-1)[0];
    // The whole crop, not only its size: the offset and the flips are pixels the export writes too.
    expect(call.crop).toMatchObject({ x: 0, y: 0, width: 50, height: 25, flipX: false, flipY: false });
    expect(call.resolution).toBe('1080p');
    expect(call.frameRate).toBe(30);
  });

  it('composes the trimmed timeline the render tab is about to export', () => {
    mount({ trimStart: 2, trimEnd: 8 });

    const call = vi.mocked(useNativePreview).mock.calls.at(-1)[0];
    expect(call.trimStart).toBe(2);
    expect(call.trimEnd).toBe(8);
  });

  it('leaves an untrimmed panel untrimmed', () => {
    mount();

    const call = vi.mocked(useNativePreview).mock.calls.at(-1)[0];
    expect(call.trimStart).toBe(0);
    expect(call.trimEnd).toBe(0);
  });

  // The export has no frame for an instant outside the trim window, so the panel must not keep
  // showing the last one it decoded: that would put an exported pixel in front of an instant it is
  // not the pixel for. The <video> underneath is what is left, which is the honest answer.
  it('takes the composited frame off when the playhead leaves the trim window', () => {
    vi.mocked(useNativePreview).mockReturnValue(showing());
    const { container, rerender } = mount({ trimStart: 2, trimEnd: 8 });
    fireEvent.load(container.querySelector('.native-composited-frame-pending'));
    expect(container.querySelector('.native-composited-frame')).not.toBeNull();

    vi.mocked(useNativePreview).mockReturnValue({ ...dormant(), outsideTrim: true });
    rerender(
      <NativeRenderPreview
        videoFile="C:/media/clip.mp4"
        subtitles={subtitles}
        subtitleCustomization={{ fontSize: 50, maxWidth: 80 }}
        resolution="1080p"
        frameRate={30}
        trimStart={2}
        trimEnd={8}
      />,
    );

    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('shows the composited frame while stopped and asks for the subtitle layer on play', () => {
    vi.mocked(useNativePreview).mockReturnValue(showing());
    const { container, video } = mount();

    fireEvent.load(container.querySelector('.native-composited-frame-pending'));
    const shown = container.querySelector('.native-composited-frame');
    expect(shown.getAttribute('src')).toBe(FRAME_URL);
    expect(shown.getAttribute('data-layer')).toBe('composited');
    const stopped = vi.mocked(useNativePreview).mock.calls.at(-1)[0];
    expect(stopped.active).toBe(true);
    expect(stopped.playing).toBe(false);

    // Playing no longer stops the panel asking. It asks for the cheaper layer, so the <video> keeps
    // the surface and the subtitles keep being drawn by the compositor that exports them — the panel
    // used to show raw video with no subtitles at all here.
    fireEvent.play(video);
    const playing = vi.mocked(useNativePreview).mock.calls.at(-1)[0];
    expect(playing.active).toBe(true);
    expect(playing.playing).toBe(true);
    // The frame already decoded stays on screen while the next layer renders: no gap in the handover.
    expect(container.querySelector('.native-composited-frame')).not.toBeNull();

    fireEvent.pause(video);
    expect(vi.mocked(useNativePreview).mock.calls.at(-1)[0].playing).toBe(false);
  });

  it('replaces the subtitle layer with the composited frame once playback stops', () => {
    vi.mocked(useNativePreview).mockReturnValue(showing('subtitles'));
    const { container, rerender, video } = mount();
    fireEvent.play(video);
    fireEvent.load(container.querySelector('.native-composited-frame-pending'));
    expect(container.querySelector('.native-composited-frame').getAttribute('data-layer')).toBe('subtitles');

    // Pausing asks for the composited frame at the same instant; it takes the surface only once it
    // has actually decoded, so the approximation is replaced rather than removed.
    fireEvent.pause(video);
    vi.mocked(useNativePreview).mockReturnValue({
      ...showing('composited'),
      frame: { url: `${FRAME_URL}0`, cacheKey: 'k2', frameIndex: 0, layer: 'composited' },
    });
    rerender(
      <NativeRenderPreview
        videoFile="C:/media/clip.mp4"
        subtitles={subtitles}
        subtitleCustomization={{ fontSize: 50, maxWidth: 80 }}
        resolution="1080p"
        frameRate={30}
      />,
    );
    expect(container.querySelector('.native-composited-frame').getAttribute('data-layer')).toBe('subtitles');

    fireEvent.load(container.querySelector('.native-composited-frame-pending'));
    expect(container.querySelector('.native-composited-frame').getAttribute('data-layer')).toBe('composited');
  });

  it('states a native refusal rather than leaving the panel blank', () => {
    vi.mocked(useNativePreview).mockReturnValue({
      ...dormant(),
      status: 'error',
      error: { code: 'nativePreviewRejected', nativeCode: 'previewSceneRefused' },
    });
    render(
      <NativeRenderPreview
        videoFile="C:/media/clip.mp4"
        subtitles={subtitles}
        subtitleCustomization={{}}
      />,
    );

    expect(screen.getByText(/previewSceneRefused/)).toBeInTheDocument();
  });
});
