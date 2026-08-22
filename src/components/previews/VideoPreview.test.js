import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import VideoPreview from './VideoPreview';

const captured = vi.hoisted(() => ({ props: null }));
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
vi.mock('../SubtitleSettings', () => ({ default: () => null }));
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

const mount = (props = {}, settings = {}) => {
  localStorage.setItem('subtitle_settings', JSON.stringify({
    fontFamily: 'Arial, sans-serif',
    fontSize: '40',
    fontWeight: '500',
    position: '90',
    boxWidth: '80',
    backgroundColor: '#000000',
    opacity: '0.4',
    textColor: '#ffffff',
    showTranslatedSubtitles: false,
    backgroundRadius: '16',
    textShadow: true,
    ...settings,
  }));
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
  window.addToast = vi.fn();
  window.removeToastByKey = vi.fn();
});

describe('the editor preview compositor boundary', () => {
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
  });

  it('uses translated text on the original cue timings exactly as export does', () => {
    mount({ translatedSubtitles: translations }, { showTranslatedSubtitles: true });
    expect(captured.props.subtitles).toEqual([
      { id: 11, start: 0, end: 2, text: 'La ligne originale' },
      { id: 12, start: 2, end: 4, text: 'La deuxieme ligne originale' },
    ]);
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
