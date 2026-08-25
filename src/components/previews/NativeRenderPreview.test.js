import { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import NativeRenderPreview from './NativeRenderPreview';

const captured = vi.hoisted(() => ({ props: null }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
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
vi.mock('./canvas/CanvasVideoPreview', () => ({
  default: (props) => {
    captured.props = props;
    return <canvas data-testid="canvas-preview" />;
  },
}));

const subtitles = [{ start: 0, end: 2, text: 'A cue' }];

const mount = (props = {}) => {
  const ref = createRef();
  const result = render(
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
  return { ref, ...result, video: result.container.querySelector('video') };
};

beforeEach(() => {
  captured.props = null;
  window.addToast = vi.fn();
  window.removeToastByKey = vi.fn();
});

describe('native render-tab preview', () => {
  it('keeps the no-video placeholder', () => {
    render(<NativeRenderPreview videoFile={null} subtitles={subtitles} subtitleCustomization={{}} />);
    expect(screen.getByText('No video selected')).toBeInTheDocument();
  });

  it('drives the same persistent canvas with crop and trim settings', () => {
    const crop = { x: 5, y: 10, width: 50, height: 25, flipX: true, flipY: false };
    const { container } = mount({ cropSettings: crop, trimStart: 2, trimEnd: 8 });
    expect(container.querySelector('[data-testid="canvas-preview"]')).not.toBeNull();
    expect(container.querySelector('.native-composited-frame')).toBeNull();
    expect(captured.props.crop).toMatchObject(crop);
    expect(captured.props.trimStart).toBe(2);
    expect(captured.props.trimEnd).toBe(8);
  });

  it('keeps play, seek, mute, fullscreen and the trim-row imperative API', () => {
    const onSeek = vi.fn();
    const { ref, video } = mount({ onSeek, frameRate: 25 });
    Object.defineProperty(video, 'duration', { value: 12, configurable: true });
    Object.defineProperty(video, 'videoWidth', { value: 1920, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 1080, configurable: true });
    fireEvent.loadedMetadata(video);

    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Seek video' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mute' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument();
    expect(screen.getByTestId('crop-controls')).toBeInTheDocument();

    act(() => ref.current.seekTo(50));
    expect(video.currentTime).toBe(2);
    expect(onSeek).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(video.muted).toBe(true);
  });

  it('holds the last complete canvas frame until a seek has decoded its replacement', () => {
    const onSeek = vi.fn();
    const { video } = mount({ onSeek });
    Object.defineProperty(video, 'duration', { value: 12, configurable: true });
    fireEvent.loadedMetadata(video);

    fireEvent.change(screen.getByRole('slider', { name: 'Seek video' }), {
      target: { value: '6' },
    });
    expect(video.currentTime).toBe(6);
    expect(captured.props.currentTime).toBe(6);
    expect(captured.props.seeking).toBe(true);
    expect(onSeek).toHaveBeenCalledTimes(1);

    fireEvent.seeking(video);
    expect(captured.props.seeking).toBe(true);
    fireEvent.seeked(video);
    expect(captured.props.seeking).toBe(false);
    expect(captured.props.currentTime).toBe(6);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it('does not enter a seek hold when the requested frame is already current', () => {
    const onSeek = vi.fn();
    const { ref, video } = mount({ onSeek, frameRate: 25 });
    video.currentTime = 2;

    act(() => ref.current.seekTo(50));

    expect(captured.props.seeking).toBe(false);
    expect(captured.props.currentTime).toBe(2);
    expect(onSeek).toHaveBeenCalledWith(2);
  });

  it('sends compositor refusals to a toast instead of overlaying the picture', async () => {
    const { container } = mount();
    act(() => captured.props.onStateChange({ status: 'error', code: 'canvasPreviewRejected' }));
    await waitFor(() => expect(window.addToast).toHaveBeenCalledWith(
      expect.stringContaining('canvasPreviewRejected'),
      'error',
      8000,
      'native-subtitle-preview',
      undefined,
    ));
    expect(container.textContent).not.toContain('canvasPreviewRejected');
  });
});
