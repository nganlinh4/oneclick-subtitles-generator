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
  default: ({ isEnabled, onToggle, onApply }) => (
    <div data-testid="crop-controls" data-enabled={String(isEnabled)}>
      <button onClick={onToggle}>toggle-crop</button>
      <button onClick={onApply}>apply-crop</button>
    </div>
  ),
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
    expect(container.querySelector('.native-render-preview')).toHaveAttribute(
      'data-osg-preview',
      'idle',
    );
    expect(container.querySelector('.native-render-preview')).toHaveAttribute(
      'data-osg-preview-code',
      '',
    );
  });

  it('publishes the exact render-preview compositor state for real-binary diagnostics', async () => {
    const { container } = mount();
    const surface = container.querySelector('.native-render-preview');

    act(() => captured.props.onStateChange({ status: 'ready', code: null }));
    await waitFor(() => expect(surface).toHaveAttribute('data-osg-preview', 'ready'));
    expect(surface).toHaveAttribute('data-osg-preview-code', '');

    act(() => captured.props.onStateChange({ status: 'error', code: 'fontUnavailable' }));
    await waitFor(() => expect(surface).toHaveAttribute('data-osg-preview', 'error'));
    expect(surface).toHaveAttribute('data-osg-preview-code', 'fontUnavailable');

    act(() => captured.props.onStateChange({ status: 'ready', code: null }));
    await waitFor(() => expect(surface).toHaveAttribute('data-osg-preview', 'ready'));
    expect(surface).toHaveAttribute('data-osg-preview-code', '');
  });

  it('keeps play, seek, mute, fullscreen and the trim-row imperative API', async () => {
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
    expect(captured.props.seeking).toBe(true);
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.seeked(video);
    await waitFor(() => expect(onSeek).toHaveBeenCalledWith(2));
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(video.muted).toBe(true);
  });

  it('holds the last complete canvas frame until a seek has decoded its replacement', async () => {
    const onSeek = vi.fn();
    const { video } = mount({ onSeek });
    Object.defineProperty(video, 'duration', { value: 12, configurable: true });
    fireEvent.loadedMetadata(video);

    fireEvent.input(screen.getByRole('slider', { name: 'Seek video' }), {
      target: { value: '6' },
    });
    expect(video.currentTime).toBe(6);
    expect(captured.props.currentTime).toBe(6);
    expect(captured.props.seeking).toBe(true);
    expect(onSeek).not.toHaveBeenCalled();

    fireEvent.seeking(video);
    expect(captured.props.seeking).toBe(true);
    fireEvent.seeked(video);
    await waitFor(() => expect(captured.props.seeking).toBe(false));
    expect(captured.props.currentTime).toBe(6);
    expect(onSeek).toHaveBeenCalledTimes(1);
  });

  it('accepts a public input seek while playback has advanced beyond a stale controlled thumb', () => {
    const { video } = mount();
    Object.defineProperty(video, 'duration', { value: 20, configurable: true });
    fireEvent.loadedMetadata(video);
    const slider = screen.getByRole('slider', { name: 'Seek video' });

    fireEvent.input(slider, { target: { value: '0.9' } });
    expect(video.currentTime).toBe(0.9);

    // A busy compositor can delay React's timeupdate render while the media clock keeps moving. The
    // shipped control must still honour an input event at the value its controlled thumb displays;
    // React's value-tracked `onChange` suppresses this exact same-value event.
    video.currentTime = 2.07;
    expect(slider).toHaveValue('0.9');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '0.9');
      slider.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    });

    expect(video.currentTime).toBe(0.9);
  });

  it('does not enter a seek hold when the requested frame is already current', async () => {
    const onSeek = vi.fn();
    const { ref, video } = mount({ onSeek, frameRate: 25 });
    video.currentTime = 2;

    act(() => ref.current.seekTo(50));

    expect(captured.props.seeking).toBe(false);
    expect(captured.props.currentTime).toBe(2);
    await waitFor(() => expect(onSeek).toHaveBeenCalledWith(2));
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

  it('keeps crop mode open and surfaces a toast when applying a crop is rejected', () => {
    // A crop the durable render scene refuses (e.g. `updateProjectRenderScene` throwing on a
    // malformed value) must never vanish silently -- the customer's in-progress edit stays visible
    // and they are told why, instead of "Apply" silently doing nothing.
    const onCropChange = vi.fn(() => { throw new Error('The project render scene is invalid'); });
    const { container, video } = mount({ onCropChange });
    // `VideoCropControls` only mounts once the source video has published its dimensions.
    Object.defineProperty(video, 'videoWidth', { value: 480, configurable: true });
    Object.defineProperty(video, 'videoHeight', { value: 360, configurable: true });
    fireEvent.loadedMetadata(video);

    fireEvent.click(screen.getByText('toggle-crop'));
    expect(container.querySelector('[data-testid="crop-controls"]')).toHaveAttribute('data-enabled', 'true');

    fireEvent.click(screen.getByText('apply-crop'));

    expect(onCropChange).toHaveBeenCalledTimes(1);
    expect(window.addToast).toHaveBeenCalledWith('The project render scene is invalid', 'error', 8000);
    expect(container.querySelector('[data-testid="crop-controls"]')).toHaveAttribute('data-enabled', 'true');
  });

  it('retries a transient render-preview canvas allocation without changing the scene', async () => {
    mount();
    act(() => captured.props.onStateChange({
      status: 'error', code: 'canvasPreviewUnavailable', retryable: true,
    }));
    await waitFor(() => expect(window.addToast).toHaveBeenCalled());
    const retry = window.addToast.mock.calls.at(-1)[4];
    expect(retry).toMatchObject({ text: 'Retry' });
    expect(captured.props.retryToken).toBe(0);

    act(() => retry.onClick());
    await waitFor(() => expect(captured.props.retryToken).toBe(1));
  });
});
