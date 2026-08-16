import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isNativeMediaDescriptor } from '../../platform/mediaService';
import VideoCropControls from '../VideoCropControls';
import '../../styles/VideoPreviewPanel.css';
import NativeCompositedFrame from './native/NativeCompositedFrame';
import useNativePreview from './native/useNativePreview';

/**
 * The render tab's preview, drawn by the same compositor that writes the file.
 *
 * This replaces `RemotionVideoPreview`, which ran a hand-maintained JavaScript near-duplicate of the
 * export composition inside `@remotion/player`. That duplicate and the export already disagreed in
 * at least thirteen measurable ways — crop `objectFit`, the canvas-background trigger, the composition
 * width association, and a font path that fetched Google Fonts and silently substituted whatever came
 * back. None of those can recur here, because nothing in this component draws a subtitle: it shows a
 * `<video>` for playback and, the moment playback stops, the frame `crates/osg-compositor` produced.
 *
 * WHAT IS NOT REPRODUCED, stated rather than approximated: the Remotion Player's own control bar.
 * A browser's `<video controls>` bar is painted inside the video element's stacking context, so an
 * overlay carrying the composited frame necessarily covers it, and an invisible-but-clickable control
 * bar is worse than none. The panel therefore uses this application's own established video
 * interaction instead — click the surface or press space to toggle playback, exactly as
 * `previews/VideoPlayerElement.js` does — and the timeline for this same video is the trim row
 * directly beneath the panel. The imperative `seekTo(frame)` that `TrimTimelineRow` drives is
 * preserved unchanged.
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

const NativeRenderPreview = forwardRef(({
  videoFile,
  subtitles,
  narrationAudioUrl = null,
  subtitleCustomization,
  resolution = '1080p',
  frameRate = 30,
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
  const videoRef = useRef(null);
  const narrationRef = useRef(null);

  const [source, setSource] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoDimensions, setVideoDimensions] = useState(null);
  const [isCropEnabled, setIsCropEnabled] = useState(false);
  const [tempCrop, setTempCrop] = useState(EMPTY_CROP);
  const [appliedCrop, setAppliedCrop] = useState(EMPTY_CROP);

  useEffect(() => {
    const resolved = resolveVideoSource(videoFile);
    setSource(resolved);
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

  const handleTimeUpdate = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    setCurrentTime(element.currentTime);
    if (onTimeUpdate) onTimeUpdate(element.currentTime);
  }, [onTimeUpdate]);

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

  useImperativeHandle(ref, () => ({
    /** Frames, not seconds: `TrimTimelineRow` speaks the render settings' frame grid. */
    seekTo: (frame) => {
      const element = videoRef.current;
      if (!element || !Number.isFinite(frame) || frameRate <= 0) return;
      element.currentTime = Math.max(frame / frameRate, 0);
      if (onSeek) onSeek(element.currentTime);
    },
    play: () => videoRef.current?.play().catch(() => undefined),
    pause: () => videoRef.current?.pause(),
    getCurrentFrame: () => Math.floor((videoRef.current?.currentTime ?? 0) * frameRate),
  }), [frameRate, onSeek]);

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

  const nativePreview = useNativePreview({
    active: !isPlaying,
    source: videoFile,
    videoRef,
    sourceKey: source?.url ?? null,
    customization: subtitleCustomization,
    subtitles,
    resolution,
    frameRate,
    cropWidthPercent: activeCrop.width,
    cropHeightPercent: activeCrop.height,
    durationSeconds: duration,
    currentTime,
  });

  const handleApplyCrop = () => {
    setAppliedCrop(tempCrop);
    if (onCropChange) onCropChange(tempCrop);
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
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <video
        ref={videoRef}
        src={source.url}
        playsInline
        onClick={togglePlayback}
        onLoadedMetadata={handleMetadata}
        onTimeUpdate={handleTimeUpdate}
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
        onSeeked={() => syncNarration(!videoRef.current?.paused)}
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

      <NativeCompositedFrame
        frame={nativePreview.frame}
        visible={!isPlaying}
        onLoadError={nativePreview.onFrameLoadError}
        style={{ borderRadius: '8px' }}
      />

      {narrationAudioUrl && <audio ref={narrationRef} src={narrationAudioUrl} preload="auto" />}

      {nativePreview.error && (
        <div className="error" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 3 }}>
          {t('videoPreview.renderError', 'Error rendering subtitles: {{error}}', {
            error: nativePreview.error.nativeCode ?? nativePreview.error.code,
          })}
        </div>
      )}

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
