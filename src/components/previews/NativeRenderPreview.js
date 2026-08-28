import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isNativeMediaDescriptor } from '../../platform/mediaService';
import VideoCropControls from '../VideoCropControls';
import '../../styles/VideoPreviewPanel.css';
import CanvasVideoPreview from './canvas/CanvasVideoPreview';
import useNativePreviewToast from './native/useNativePreviewToast';
import useVideoSeekCoordinator from './useVideoSeekCoordinator';

/**
 * The render tab's preview, drawn by the same compositor that writes the file.
 *
 * This replaces the deleted browser preview, which ran a hand-maintained JavaScript near-duplicate
 * of the export composition inside a third-party player. That duplicate and the export already
 * disagreed in at least thirteen measurable ways — crop `objectFit`, the canvas-background trigger, the composition
 * width association, and a font path that fetched Google Fonts and silently substituted whatever came
 * back. None of those can recur here, because nothing in this component draws a subtitle: it shows a
 * `<video>` for playback and, the moment playback stops, the frame `crates/osg-compositor` produced.
 *
 * The removed player's control bar is reproduced with native WebView controls above the composited
 * frame: play/pause, seek, time, mute and fullscreen. Using `<video controls>` is not sufficient
 * because the composition canvas necessarily covers the video element's own painted control layer.
 * The imperative `seekTo(frame)` that `TrimTimelineRow` drives is preserved unchanged.
 */

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];

/** The playable URL for whatever shape of media the render tab happens to be holding. */
const resolveVideoSource = (videoFile) => {
  if (!videoFile) return null;
  if (isNativeMediaDescriptor(videoFile)) {
    return { url: videoFile.playbackUrl, objectUrl: null, isVideo: videoFile.type.startsWith('video/') };
  }
  if (videoFile instanceof File || videoFile instanceof Blob) {
    const objectUrl = URL.createObjectURL(videoFile);
    return { url: objectUrl, objectUrl, isVideo: String(videoFile.type ?? '').startsWith('video/') };
  }
  if (typeof videoFile === 'string') {
    const lowered = videoFile.toLowerCase();
    return {
      url: videoFile,
      objectUrl: null,
      isVideo: VIDEO_EXTENSIONS.some((extension) => lowered.includes(extension)),
    };
  }
  if (typeof videoFile === 'object' && typeof videoFile.url === 'string') {
    return { url: videoFile.url, objectUrl: null, isVideo: videoFile.isActualVideo === true };
  }
  return null;
};

const EMPTY_CROP = Object.freeze({
  x: 0, y: 0, width: 100, height: 100, aspectRatio: null, flipX: false, flipY: false,
});

const normalizeCrop = (crop) => (crop ? {
  ...crop,
  x: crop.x ?? 0,
  y: crop.y ?? 0,
  width: crop.width ?? 100,
  height: crop.height ?? 100,
  aspectRatio: crop.aspectRatio ?? null,
  flipX: crop.flipX ?? false,
  flipY: crop.flipY ?? false,
} : { ...EMPTY_CROP });

const formatTime = (seconds) => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(Math.floor(safe % 60)).padStart(2, '0')}`;
};

const NativeRenderPreview = forwardRef(({
  videoFile,
  subtitles,
  narrationAudioUrl = null,
  subtitleCustomization,
  resolution = '1080p',
  frameRate = 30,
  // The render settings' trim, in seconds, with `trimEnd` of zero meaning "to the end of the
  // source". The panel previews the composition the render tab is about to export, and that
  // composition is the TRIMMED one: it has fewer frames than the source, its zero is at `trimStart`,
  // and every cue is rebased onto it by `crates/osg-export/src/convert/timeline.rs`.
  trimStart = 0,
  trimEnd = 0,
  originalAudioVolume = 100,
  narrationVolume = 100,
  onTimeUpdate = null,
  onDurationChange = null,
  onPlay = null,
  onPause = null,
  onSeek = null,
  cropSettings = null,
  onCropChange = null,
}, ref) => {
  const { t } = useTranslation();
  const surfaceRef = useRef(null);
  const videoRef = useRef(null);
  const narrationRef = useRef(null);

  const [source, setSource] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [canvasPreviewState, setCanvasPreviewState] = useState({ status: 'idle', code: null });
  const [canvasPreviewRetryToken, setCanvasPreviewRetryToken] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoDimensions, setVideoDimensions] = useState(null);
  const [isCropEnabled, setIsCropEnabled] = useState(false);
  const [tempCrop, setTempCrop] = useState(EMPTY_CROP);
  const [appliedCrop, setAppliedCrop] = useState(EMPTY_CROP);

  useEffect(() => {
    const resolved = resolveVideoSource(videoFile);
    setSource(resolved);
    setCurrentTime(0);
    if (resolved === null) {
      setDuration(0);
      setVideoDimensions(null);
    }
    return () => {
      if (resolved?.objectUrl) URL.revokeObjectURL(resolved.objectUrl);
    };
  }, [videoFile]);

  useEffect(() => {
    if (cropSettings) {
      const normalized = normalizeCrop(cropSettings);
      setAppliedCrop(normalized);
      setTempCrop(normalized);
    }
  }, [cropSettings]);

  const handleMetadata = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    setDuration(element.duration);
    if (onDurationChange) onDurationChange(element.duration);
    setVideoDimensions(
      element.videoWidth > 0 && element.videoHeight > 0
        ? {
          width: element.videoWidth,
          height: element.videoHeight,
          aspectRatio: element.videoWidth / element.videoHeight,
        }
        : null,
    );
  }, [onDurationChange]);

  // The narration track is a second element rather than a mix, because the mix that matters is the
  // one `crates/osg-audio` performs for the file. This is playback, and it follows the video.
  useEffect(() => {
    const narration = narrationRef.current;
    if (!narration) return;
    narration.volume = Math.min(Math.max(narrationVolume / 100, 0), 1);
  }, [narrationVolume]);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.volume = Math.min(Math.max(originalAudioVolume / 100, 0), 1);
  }, [originalAudioVolume, source]);

  const syncNarration = useCallback((playing) => {
    const narration = narrationRef.current;
    const element = videoRef.current;
    if (!narration || !element) return;
    narration.currentTime = element.currentTime;
    if (playing) narration.play().catch(() => undefined);
    else narration.pause();
  }, []);

  const togglePlayback = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    if (element.paused) element.play().catch(() => undefined);
    else element.pause();
  }, []);

  const publishCurrentTime = useCallback((time) => {
    setCurrentTime(time);
    if (onTimeUpdate) onTimeUpdate(time);
  }, [onTimeUpdate]);

  const handleSeekCompleted = useCallback((time) => {
    const element = videoRef.current;
    if (element) syncNarration(!element.paused);
    if (onSeek) onSeek(time);
  }, [onSeek, syncNarration]);

  // Use the same generation- and source-bound seek authority as the main editor. The previous
  // render-tab path kept an independent `isSeeking` boolean, so a stale seeked event or a source
  // replacement could unlock a newer request and let playback overwrite its target.
  const {
    isSeeking,
    seekTo: coordinatedSeekTo,
  } = useVideoSeekCoordinator({
    videoRef,
    sourceKey: source?.url ?? null,
    setCurrentTime: publishCurrentTime,
    onSeek: handleSeekCompleted,
  });

  const seek = useCallback((time) => {
    coordinatedSeekTo(Number(time), { reason: 'render-control' });
  }, [coordinatedSeekTo]);

  const toggleMute = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    element.muted = !element.muted;
    setIsMuted(element.muted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else surface.requestFullscreen?.();
  }, []);

  useImperativeHandle(ref, () => ({
    /** Frames, not seconds: `TrimTimelineRow` speaks the render settings' frame grid. */
    seekTo: (frame) => {
      if (!Number.isFinite(frame) || frameRate <= 0) return;
      coordinatedSeekTo(Math.max(frame / frameRate, 0), { reason: 'trim-timeline' });
    },
    play: () => videoRef.current?.play().catch(() => undefined),
    pause: () => videoRef.current?.pause(),
    getCurrentFrame: () => Math.floor((videoRef.current?.currentTime ?? 0) * frameRate),
  }), [coordinatedSeekTo, frameRate]);

  useEffect(() => {
    const handleSpacebar = (event) => {
      if (event.code !== 'Space' || !event.target.closest?.('.video-preview-panel')) return;
      event.preventDefault();
      event.stopPropagation();
      togglePlayback();
    };
    document.addEventListener('keydown', handleSpacebar);
    return () => document.removeEventListener('keydown', handleSpacebar);
  }, [togglePlayback]);

  const activeCrop = isCropEnabled ? tempCrop : appliedCrop;

  useNativePreviewToast({
    error: canvasPreviewState.code === null ? null : { code: canvasPreviewState.code },
    dormant: canvasPreviewState.status === 'font-blocked',
    fontBlocked: canvasPreviewState.status === 'font-blocked',
    onRetry: canvasPreviewState.retryable === true
      ? () => setCanvasPreviewRetryToken(token => token + 1)
      : null,
    t,
  });

  const handleApplyCrop = () => {
    setAppliedCrop(tempCrop);
    try {
      if (onCropChange) onCropChange(tempCrop);
    } catch (error) {
      // A crop the durable render scene refuses must never vanish silently: undo the optimistic
      // preview update, leave crop mode open so the customer's in-progress edit is not lost, and
      // say why instead of leaving Apply looking like a dead button.
      setAppliedCrop(appliedCrop);
      window.addToast?.(
        error?.message || t('videoRendering.cropApplyFailed', 'The crop could not be saved'),
        'error',
        8000,
      );
      return;
    }
    setIsCropEnabled(false);
  };

  const handleClearCrop = () => {
    setAppliedCrop({ ...EMPTY_CROP });
    setTempCrop({ ...EMPTY_CROP });
    if (onCropChange) onCropChange({ ...EMPTY_CROP });
    setIsCropEnabled(false);
  };

  if (source === null) {
    return (
      <div className="placeholder-content">
        <div className="placeholder-icon">
          <span className="material-symbols-rounded" style={{ fontSize: '64px' }}>movie_off</span>
        </div>
        <p>{t('videoRendering.noVideoSelected', 'No video selected')}</p>
        <small>{t('videoRendering.selectVideoFileToPreview', 'Select a video file to see preview')}</small>
      </div>
    );
  }

  return (
    <div
      ref={surfaceRef}
      className="native-render-preview"
      data-osg-preview={canvasPreviewState.status}
      data-osg-preview-code={canvasPreviewState.code ?? ''}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      <video
        ref={videoRef}
        src={source.url}
        playsInline
        onClick={togglePlayback}
        onLoadedMetadata={handleMetadata}
        onPlay={() => {
          setIsPlaying(true);
          syncNarration(true);
          if (onPlay) onPlay();
        }}
        onPause={() => {
          setIsPlaying(false);
          syncNarration(false);
          if (onPause) onPause();
        }}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          display: 'block',
          borderRadius: '8px',
          cursor: 'pointer',
          zIndex: 1,
        }}
      />

      <CanvasVideoPreview
        key={source?.url ?? 'no-render-source'}
        videoRef={videoRef}
        sourceKey={source?.url ?? null}
        playing={isPlaying}
        seeking={isSeeking}
        currentTime={currentTime}
        frameRate={frameRate}
        customization={subtitleCustomization}
        subtitles={subtitles}
        resolution={resolution}
        crop={activeCrop}
        trimStart={trimStart}
        trimEnd={trimEnd}
        onStateChange={setCanvasPreviewState}
        retryToken={canvasPreviewRetryToken}
        style={{ borderRadius: '8px' }}
      />

      {narrationAudioUrl && <audio ref={narrationRef} src={narrationAudioUrl} preload="auto" />}

      <div className="native-render-controls" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="native-render-control-button"
          data-osg-control="play-pause"
          aria-label={isPlaying ? t('common.pause', 'Pause') : t('common.play', 'Play')}
          onClick={togglePlayback}
        >
          <span className="material-symbols-rounded">{isPlaying ? 'pause' : 'play_arrow'}</span>
        </button>
        <span className="native-render-time">{formatTime(currentTime)}</span>
        <input
          className="native-render-seek"
          data-osg-control="seek"
          type="range"
          min="0"
          max={duration || 0}
          step={frameRate > 0 ? 1 / frameRate : 0.01}
          value={Math.min(currentTime, duration || 0)}
          aria-label={t('videoPreview.seek', 'Seek video')}
          // `onInput` is intentional. React's value-tracked `onChange` suppresses a same-value
          // input when the controlled thumb is one render behind a playing media element. In that
          // state the UI says 0.9 s while the decoder is already at 2.1 s, and seeking to the public
          // thumb value must still seek the media rather than silently continuing playback.
          onInput={(event) => seek(event.currentTarget.value)}
        />
        <span className="native-render-time">{formatTime(duration)}</span>
        <button
          type="button"
          className="native-render-control-button"
          data-osg-control="mute"
          aria-label={isMuted ? t('common.unmute', 'Unmute') : t('common.mute', 'Mute')}
          onClick={toggleMute}
        >
          <span className="material-symbols-rounded">{isMuted ? 'volume_off' : 'volume_up'}</span>
        </button>
        <button
          type="button"
          className="native-render-control-button"
          data-osg-control="fullscreen"
          aria-label={t('common.fullscreen', 'Fullscreen')}
          onClick={toggleFullscreen}
        >
          <span className="material-symbols-rounded">fullscreen</span>
        </button>
      </div>

      {videoDimensions && (
        <VideoCropControls
          isEnabled={isCropEnabled}
          onToggle={() => {
            setTempCrop(appliedCrop);
            setIsCropEnabled((enabled) => !enabled);
          }}
          cropSettings={tempCrop}
          onCropChange={setTempCrop}
          onApply={handleApplyCrop}
          onCancel={() => {
            setTempCrop(appliedCrop);
            setIsCropEnabled(false);
          }}
          onClear={handleClearCrop}
          videoDimensions={videoDimensions}
          hasAppliedCrop={
            appliedCrop.width !== 100
            || appliedCrop.height !== 100
            || appliedCrop.x !== 0
            || appliedCrop.y !== 0
          }
        />
      )}
    </div>
  );
});

NativeRenderPreview.displayName = 'NativeRenderPreview';

export default NativeRenderPreview;
