import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultCustomization } from '../subtitleCustomization/defaultCustomization';
import VideoPreview, { admittedPlaybackSourceUrl } from './VideoPreview';

const captured = vi.hoisted(() => ({ props: null, settingsProps: null }));
const renderScene = vi.hoisted(() => ({ status: 'inactive', scene: null, updateScene: vi.fn() }));
const translation = vi.hoisted(() => ({
  t: (_key, fallback, values = {}) => String(fallback).replace(
    /\{\{(\w+)\}\}/g,
    (whole, name) => (name in values ? String(values[name]) : whole),
  ),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => translation,
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));
vi.mock('../SubtitleSettings', () => ({
  default: (props) => {
    captured.settingsProps = props;
    return null;
  },
}));
vi.mock('../../platform/projectRenderScene', () => ({
  useProjectRenderScene: () => ({
    status: renderScene.status,
    scene: renderScene.scene,
    updateScene: renderScene.updateScene,
  }),
}));
vi.mock('./VideoTopsideButtons', () => ({ default: () => null }));
vi.mock('./VideoBottomControls', () => ({ default: () => null }));
vi.mock('../common/LoadingIndicator', () => ({ default: () => null }));
vi.mock('./useVideoSourceSwitching', () => ({ default: () => undefined }));
vi.mock('./canvas/CanvasVideoPreview', () => ({
  default: (props) => {
    captured.props = props;
    return <canvas data-testid="canvas-preview" data-engine="canvas-atlas" />;
  },
}));

const originals = Object.freeze([
  { id: 1, start: 0, end: 2, text: 'The original line' },
  { id: 2, start: 2, end: 4, text: 'The second original line' },
]);
const translations = Object.freeze([
  { id: 11, originalId: 1, text: 'La ligne originale' },
  { id: 12, originalId: 2, text: 'La deuxieme ligne originale' },
]);

const mount = (props = {}, customization = {}, scene = {}, status = 'ready') => {
  renderScene.status = status;
  renderScene.scene = {
    selectedSubtitles: 'original',
    selectedNarration: 'none',
    customization: {
      ...defaultCustomization,
      fontFamily: 'Arial, sans-serif',
      fontSize: 40,
      fontWeight: 500,
      position: 'custom',
      customPositionY: 90,
      maxWidth: 80,
      backgroundOpacity: 40,
      borderRadius: 16,
      textShadowEnabled: true,
      ...customization,
    },
    renderSettings: {},
    crop: {},
    ...scene,
  };
  const result = render(
    <VideoPreview
      currentTime={1}
      setCurrentTime={vi.fn()}
      setDuration={vi.fn()}
      videoSource="C:/media/clip.mp4"
      fileType="video"
      onSeek={vi.fn()}
      subtitlesArray={originals}
      translatedSubtitles={[]}
      {...props}
    />,
  );
  return { ...result, video: result.container.querySelector('video') };
};

beforeEach(() => {
  localStorage.clear();
  captured.props = null;
  captured.settingsProps = null;
  renderScene.scene = null;
  renderScene.status = 'inactive';
  renderScene.updateScene.mockReset();
  window.addToast = vi.fn();
  window.removeToastByKey = vi.fn();
});

describe('the editor preview compositor boundary', () => {
  it('admits only the source that the single playback owner actually committed', () => {
    expect(admittedPlaybackSourceUrl(null, 'media-b')).toBeNull();
    expect(admittedPlaybackSourceUrl({
      actualUrl: 'media-a',
      requestedUrl: 'media-a',
    }, 'media-b')).toBeNull();
    expect(admittedPlaybackSourceUrl({
      actualUrl: 'media-b-original',
      requestedUrl: 'media-b-optimized',
    }, 'media-b-optimized')).toBe('media-b-original');
  });

  it('uses one persistent canvas and never mounts the PNG frame surface', () => {
    const { container } = mount();
    expect(container.querySelector('[data-testid="canvas-preview"]')).not.toBeNull();
    expect(container.querySelector('.native-composited-frame')).toBeNull();
    expect(container.querySelector('.native-composited-frame-pending')).toBeNull();
  });

  it('passes the live video and export customization to the canvas renderer', () => {
    const { video } = mount();
    expect(captured.props.videoRef.current).toBe(video);
    expect(captured.props.resolution).toBe('1080p');
    expect(captured.props.customization).toMatchObject({
      fontFamily: 'Arial, sans-serif',
      fontSize: 40,
      customPositionY: 90,
    });
    expect(captured.props.subtitles).toEqual(originals);
    expect(captured.props.videoUnderlay).toBe(false);
  });

  it('routes a small lyric command to the media element and exposes the seek lifecycle to Canvas', async () => {
    const onSeekRequestConsumed = vi.fn();
    const { video } = mount({
      currentTime: 1,
      seekRequest: {
        generation: 1,
        mediaKey: 'C:/media/clip.mp4',
        time: 1.1,
      },
      onSeekRequestConsumed,
    });
    Object.defineProperty(video, 'duration', { configurable: true, value: 12 });
    fireEvent.loadedMetadata(video);

    await waitFor(() => expect(video.currentTime).toBe(1.1));
    expect(captured.props.seeking).toBe(true);
    expect(onSeekRequestConsumed).toHaveBeenCalledExactlyOnceWith({
      generation: 1,
      mediaKey: 'C:/media/clip.mp4',
      time: 1.1,
    });
  });

  it('discards a pending lyric command that belongs to a replaced media source', async () => {
    const onSeekRequestConsumed = vi.fn();
    const { video } = mount({
      currentTime: 1,
      seekRequest: {
        generation: 7,
        mediaKey: 'C:/media/previous.mp4',
        time: 5,
      },
      onSeekRequestConsumed,
    });
    Object.defineProperty(video, 'duration', { configurable: true, value: 12 });
    fireEvent.loadedMetadata(video);

    await waitFor(() => expect(onSeekRequestConsumed).toHaveBeenCalledExactlyOnceWith({
      generation: 7,
      mediaKey: 'C:/media/previous.mp4',
      time: 5,
    }));
    expect(video.currentTime).toBe(0);
    expect(captured.props.seeking).toBe(false);
  });

  it('retains a source-bound lyric command when the loaded transport rejects assignment', async () => {
    const onSeekRequestConsumed = vi.fn();
    const { video } = mount({
      seekRequest: {
        generation: 9,
        mediaKey: 'C:/media/clip.mp4',
        time: 4,
      },
      onSeekRequestConsumed,
    });
    Object.defineProperties(video, {
      currentTime: {
        configurable: true,
        get: () => 0,
        set: () => { throw new DOMException('transport failed', 'InvalidStateError'); },
      },
      duration: { configurable: true, value: 12 },
    });
    fireEvent.loadedMetadata(video);

    await act(async () => Promise.resolve());
    expect(onSeekRequestConsumed).not.toHaveBeenCalled();
    expect(captured.props.seeking).toBe(false);
  });

  it('does not apply a new-source command through the previous source loaded state', async () => {
    const onSeekRequestConsumed = vi.fn();
    const result = mount({ videoSource: 'C:/media/previous.mp4' });
    const outgoingVideo = result.container.querySelector('video');
    Object.defineProperty(outgoingVideo, 'duration', { configurable: true, value: 12 });
    fireEvent.loadedMetadata(outgoingVideo);

    result.rerender(
      <VideoPreview
        currentTime={0}
        setCurrentTime={vi.fn()}
        setDuration={vi.fn()}
        videoSource="C:/media/replacement.mp4"
        fileType="video"
        onSeek={vi.fn()}
        seekRequest={{
          generation: 8,
          mediaKey: 'C:/media/replacement.mp4',
          time: 5,
        }}
        onSeekRequestConsumed={onSeekRequestConsumed}
        subtitlesArray={originals}
        translatedSubtitles={[]}
      />,
    );

    const replacementVideo = result.container.querySelector('video');
    expect(replacementVideo).toBe(outgoingVideo);
    expect(replacementVideo.currentTime).toBe(0);
    expect(onSeekRequestConsumed).not.toHaveBeenCalled();

    fireEvent.loadedMetadata(replacementVideo);
    await waitFor(() => expect(replacementVideo.currentTime).toBe(5));
    expect(onSeekRequestConsumed).toHaveBeenCalledExactlyOnceWith({
      generation: 8,
      mediaKey: 'C:/media/replacement.mp4',
      time: 5,
    });
  });

  it('submits no stale font or refusal while durable font repair owns admission', async () => {
    const result = mount({}, {}, {}, 'repairing');
    expect(captured.props.active).toBe(false);
    expect(captured.props.customization).toBeNull();

    act(() => captured.props.onStateChange({
      status: 'error', code: 'fontUnavailable', retryable: false,
    }));
    await Promise.resolve();
    expect(window.addToast).not.toHaveBeenCalled();

    renderScene.status = 'ready';
    renderScene.scene = {
      ...renderScene.scene,
      sceneRevision: 12,
      customization: {
        ...renderScene.scene.customization,
        fontFamily: "'Google Sans', sans-serif",
        fontWeight: 400,
      },
    };
    result.rerender(
      <VideoPreview
        currentTime={1}
        setCurrentTime={vi.fn()}
        setDuration={vi.fn()}
        videoSource="C:/media/clip.mp4"
        fileType="video"
        onSeek={vi.fn()}
        subtitlesArray={originals}
        translatedSubtitles={[]}
      />,
    );
    expect(captured.props.active).toBe(true);
    expect(captured.props.customization).toMatchObject({
      fontFamily: "'Google Sans', sans-serif",
      fontWeight: 400,
    });
  });

  it('ignores the obsolete global style and reads the project-owned scene', () => {
    localStorage.setItem('subtitle_settings', JSON.stringify({
      fontSize: '999',
      textColor: '#ff0000',
    }));
    mount();
    expect(captured.props.customization.fontSize).toBe(40);
    expect(captured.props.customization.textColor).toBe('#ffffff');
  });

  it('writes main-preview edits into the project scene without erasing advanced render fields', () => {
    mount({}, { glowEnabled: true, glowIntensity: 77, position: 'bottom' });
    act(() => captured.settingsProps.onSettingsChange({
      ...captured.settingsProps.settings,
      fontSize: '96',
    }));
    expect(renderScene.updateScene).toHaveBeenCalledOnce();
    const updated = renderScene.updateScene.mock.calls[0][0](renderScene.scene);
    expect(updated.customization).toMatchObject({
      fontSize: 96,
      glowEnabled: true,
      glowIntensity: 77,
      position: 'bottom',
    });
  });

  it('uses translated text on the original cue timings exactly as export does', () => {
    mount({ translatedSubtitles: translations }, {}, { selectedSubtitles: 'translated' });
    expect(captured.props.subtitles).toEqual([
      { id: 11, start: 0, end: 2, text: 'La ligne originale' },
      { id: 12, start: 2, end: 4, text: 'La deuxieme ligne originale' },
    ]);
  });

  it('never substitutes original cues when the durable scene selects a missing translation', () => {
    mount({}, {}, { selectedSubtitles: 'translated' });
    expect(captured.props.subtitles).toEqual([]);
  });

  it('keeps preview failures out of the video and sends them to the toast channel', async () => {
    const { container } = mount();
    act(() => captured.props.onStateChange({ status: 'error', code: 'glyphAtlasBakeRejected' }));
    await waitFor(() => expect(window.addToast).toHaveBeenCalledWith(
      expect.stringContaining('glyphAtlasBakeRejected'),
      'error',
      8000,
      'native-subtitle-preview',
      undefined,
    ));
    expect(container.querySelector('.error')).toBeNull();
    expect(container.textContent).not.toContain('glyphAtlasBakeRejected');
  });

  it('offers retry only for a transient canvas failure and advances the canvas retry token', async () => {
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

  it('publishes empty as a bounded diagnostic state without painting a message', () => {
    const { container, video } = mount({ subtitlesArray: undefined });
    Object.defineProperty(video, 'duration', { value: 12, configurable: true });
    fireEvent.loadedMetadata(video);
    fireEvent.canPlay(video);
    act(() => captured.props.onStateChange({ status: 'empty', code: null }));
    expect(container.querySelector('.video-container')).toHaveAttribute('data-osg-preview', 'empty');
    expect(container.textContent).not.toContain('No subtitles');
  });
});
