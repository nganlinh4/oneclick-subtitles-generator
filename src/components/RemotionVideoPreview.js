import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Player } from '@remotion/player';
import { SubtitledVideoComposition } from './SubtitledVideoComposition';
import VideoCropControls from './VideoCropControls';
import '../styles/VideoPreviewPanel.css';

const RemotionVideoPreview = React.forwardRef(({
  videoFile,
  subtitles,
  narrationAudioUrl,
  subtitleCustomization,
  originalAudioVolume = 100,
  narrationVolume = 100,
  onTimeUpdate,
  onDurationChange,
  onPlay,
  onPause,
  onSeek,
  cropSettings,
  onCropChange
}, ref) => {
  const { t } = useTranslation();
  const [videoUrl, setVideoUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isVideoFile, setIsVideoFile] = useState(false);
  const [videoDimensions, setVideoDimensions] = useState(null);
  const [isCropEnabled, setIsCropEnabled] = useState(false);
  const [tempCropSettings, setTempCropSettings] = useState({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    aspectRatio: null,
    flipX: false,
    flipY: false,
  });
  const [appliedCropSettings, setAppliedCropSettings] = useState({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    aspectRatio: null,
    flipX: false,
    flipY: false,
  });

  const playerRef = useRef(null);

  // Use the forwarded ref or fallback to internal ref
  const actualPlayerRef = ref || playerRef;

  // Load Google Fonts for preview
  useEffect(() => {
    if (subtitleCustomization?.fontFamily) {
      const fontName = subtitleCustomization.fontFamily.replace(/['"]/g, '').split(',')[0].trim();
      const fontUrl = `https://fonts.googleapis.com/css2?family=${fontName}:wght@400;500;600;700&display=swap`;
      const link = document.createElement('link');
      link.href = fontUrl;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
      return () => {
        if (document.head.contains(link)) {
          document.head.removeChild(link);
        }
      };
    }
  }, [subtitleCustomization?.fontFamily]);


  // Create video URL from file
  useEffect(() => {
    if (!videoFile) {
      // Reset state when no video file
      setVideoUrl(null);
      setIsVideoFile(false);
      setDuration(0);
      setVideoDimensions(null);
      return;
    }

    let objectUrl = null;

    try {
      if (videoFile instanceof File || videoFile instanceof Blob) {
        objectUrl = URL.createObjectURL(videoFile);
        setVideoUrl(objectUrl);

        const videoTypes = ['video/mp4', 'video/mov', 'video/avi', 'video/mkv', 'video/webm', 'video/m4v', 'video/quicktime'];
        setIsVideoFile(videoTypes.includes(videoFile.type));
      } else if (typeof videoFile === 'string') {
        setVideoUrl(videoFile);
        const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];
        setIsVideoFile(videoExtensions.some(ext => videoFile.toLowerCase().includes(ext)));
      } else if (videoFile && typeof videoFile === 'object' && videoFile.url) {
        setVideoUrl(videoFile.url);
        setIsVideoFile(!!videoFile.isActualVideo);
      } else {
        setVideoUrl(null);
        setIsVideoFile(false);
        return;
      }

      const urlToUse = objectUrl || (typeof videoFile === 'string' ? videoFile : videoFile.url);
      if (urlToUse) {
        const tempVideo = document.createElement('video');
        tempVideo.src = urlToUse;
        const onLoadedMetadata = () => {
          const videoDuration = tempVideo.duration;
          setDuration(videoDuration);
          if (onDurationChange) {
            onDurationChange(videoDuration);
          }

          const isActualVideo =
            (videoFile instanceof File && videoFile.type.startsWith('video/')) ||
            (typeof videoFile === 'string' && videoFile.toLowerCase().includes('.mp4')) ||
            (videoFile && videoFile.isActualVideo) ||
            (tempVideo.videoWidth && tempVideo.videoHeight);

          if (isActualVideo && tempVideo.videoWidth && tempVideo.videoHeight) {
            const vw = tempVideo.videoWidth;
            const vh = tempVideo.videoHeight;
            setVideoDimensions({
              width: vw,
              height: vh,
              aspectRatio: vw / vh,
            });
          }
        };
        tempVideo.addEventListener('loadedmetadata', onLoadedMetadata);
        // Avoid noisy console warnings on transient load errors
        tempVideo.addEventListener('error', () => {});
      }
    } catch (error) {
      // Keep critical errors, but avoid noisy logs otherwise
      console.error('Error processing videoFile:', error);
      setVideoUrl(null);
      setIsVideoFile(false);
    }

    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [videoFile, onDurationChange]);



  // Sync crop settings with parent if provided
  useEffect(() => {
    if (cropSettings) {
      // Normalize incoming crop settings to ensure flip flags exist
      const normalized = {
        ...cropSettings,
        x: cropSettings.x ?? 0,
        y: cropSettings.y ?? 0,
        width: cropSettings.width ?? 100,
        height: cropSettings.height ?? 100,
        aspectRatio: cropSettings.aspectRatio ?? null,
        flipX: cropSettings.flipX ?? false,
        flipY: cropSettings.flipY ?? false,
      };
      setAppliedCropSettings(normalized);
      setTempCropSettings(normalized);
    }
  }, [cropSettings]);

  // Handle crop toggle
  const handleCropToggle = () => {
    const newEnabled = !isCropEnabled;
    setIsCropEnabled(newEnabled);
    if (newEnabled) {
      // When enabling, start with current applied settings
      setTempCropSettings(appliedCropSettings);
    } else {
      // When disabling without applying, revert to applied settings
      setTempCropSettings(appliedCropSettings);
    }
  };

  // Handle temporary crop change (while adjusting)
  const handleTempCropChange = (newCrop) => {
    setTempCropSettings(newCrop);
  };

  // Handle applying the crop
  const handleApplyCrop = () => {
    setAppliedCropSettings(tempCropSettings);
    if (onCropChange) {
      onCropChange(tempCropSettings);
    }
    setIsCropEnabled(false);
  };

  // Handle canceling the crop
  const handleCancelCrop = () => {
    setTempCropSettings(appliedCropSettings);
    setIsCropEnabled(false);
  };

  // Handle clearing the crop entirely
  const handleClearCrop = () => {
    const resetCrop = {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      aspectRatio: null,
      flipX: false,
      flipY: false,
    };
    setAppliedCropSettings(resetCrop);
    setTempCropSettings(resetCrop);
    if (onCropChange) {
      onCropChange(resetCrop);
    }
    setIsCropEnabled(false);
  };


  // Calculate composition dimensions based on actual video dimensions or resolution fallback
  const getCompositionDimensions = () => {
    // If we have actual video dimensions, use them with the target resolution height
    if (videoDimensions && isVideoFile) {
      const resolution = subtitleCustomization?.resolution || '1080p';
      let targetHeight;

      switch (resolution) {
        case '360p':
          targetHeight = 360;
          break;
        case '480p':
          targetHeight = 480;
          break;
        case '720p':
          targetHeight = 720;
          break;
        case '1440p':
          targetHeight = 1440;
          break;
        case '4K':
          targetHeight = 2160;
          break;
        case '8K':
          targetHeight = 4320;
          break;
        case '1080p':
        default:
          targetHeight = 1080;
          break;
      }

      // Adjust composition aspect ratio based on crop width/height, including expand-only
      const cs = isCropEnabled ? tempCropSettings : appliedCropSettings;
      let effectiveAspectRatio = videoDimensions.aspectRatio;
      if (cs && (cs.width !== 100 || cs.height !== 100)) {
        const cropWidthRatio = cs.width / 100;
        const cropHeightRatio = cs.height / 100;
        // New AR = originalAR * (cropWidthRatio / cropHeightRatio)
        effectiveAspectRatio = videoDimensions.aspectRatio * (cropWidthRatio / cropHeightRatio);
      }

      const targetWidth = Math.round(targetHeight * effectiveAspectRatio);
      const width = targetWidth % 2 === 0 ? targetWidth : targetWidth + 1;
      const height = targetHeight % 2 === 0 ? targetHeight : targetHeight + 1;

      return { width, height };
    }

    // Fallback to default 16:9 dimensions for audio files or when video dimensions aren't available yet
    const resolution = subtitleCustomization?.resolution || '1080p';
    switch (resolution) {
      case '360p':
        return { width: 640, height: 360 };
      case '480p':
        return { width: 854, height: 480 };
      case '720p':
        return { width: 1280, height: 720 };
      case '1440p':
        return { width: 2560, height: 1440 };
      case '4K':
        return { width: 3840, height: 2160 };
      case '8K':
        return { width: 7680, height: 4320 };
      case '1080p':
      default:
        return { width: 1920, height: 1080 };
    }
  };

  // Calculate duration in frames
  const getDurationInFrames = () => {
    const frameRate = subtitleCustomization?.frameRate || 30;
    if (duration > 0) {
      return Math.ceil(duration * frameRate);
    }
    // Fallback: calculate from subtitles
    if (subtitles && subtitles.length > 0) {
      const lastSubtitle = subtitles[subtitles.length - 1];
      return Math.ceil((lastSubtitle.end + 2) * frameRate); // Add 2 second buffer
    }
    return 30 * frameRate; // Default 30 seconds
  };

  // Handle player events
  const handlePlayerTimeUpdate = (frame) => {
    const frameRate = subtitleCustomization?.frameRate || 30;
    const timeInSeconds = frame / frameRate;
    setCurrentTime(timeInSeconds);
    if (onTimeUpdate) {
      onTimeUpdate(timeInSeconds);
    }
  };

  const handlePlay = () => {
    setIsPlaying(true);
    if (onPlay) {
      onPlay();
    }
  };

  const handlePause = () => {
    setIsPlaying(false);
    if (onPause) {
      onPause();
    }
  };

  const handleSeek = (frame) => {
    const frameRate = subtitleCustomization?.frameRate || 30;
    const timeInSeconds = frame / frameRate;
    setCurrentTime(timeInSeconds);
    if (onSeek) {
      onSeek(timeInSeconds);
    }
  };

  // Spacebar handler for play/pause
  useEffect(() => {
    const handleSpacebar = (event) => {
      // Only handle spacebar if the preview panel is focused
      if (event.code === 'Space' && event.target.closest('.video-preview-panel')) {
        event.preventDefault();
        event.stopPropagation();

        if (actualPlayerRef.current) {
          if (isPlaying) {
            actualPlayerRef.current.pause();
          } else {
            actualPlayerRef.current.play();
          }
        }
      }
    };

    document.addEventListener('keydown', handleSpacebar);
    return () => {
      document.removeEventListener('keydown', handleSpacebar);
    };
  }, [isPlaying]);

  if (!videoFile || !videoUrl) {
    return (
      <>
        <div className="placeholder-content">
          <div className="placeholder-icon">
            <span className="material-symbols-rounded" style={{ fontSize: '64px' }}>movie_off</span>
          </div>
          <p>{t('videoRendering.noVideoSelected', 'No video selected')}</p>
          <small>{t('videoRendering.selectVideoFileToPreview', 'Select a video file to see preview')}</small>
          <div className="powered-by-remotion">
            <span>{t('videoRendering.poweredByRemotion', 'powered by Remotion')}</span>
          </div>
        </div>
      </>
    );
  }

  const { width, height } = getCompositionDimensions();
  const durationInFrames = getDurationInFrames();
  const frameRate = subtitleCustomization?.frameRate || 30;

  // Debug logging


  // Ensure we have valid dimensions
  const safeWidth = width > 0 ? width : 1920;
  const safeHeight = height > 0 ? height : 1080;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* Video player */}
      <Player
        ref={actualPlayerRef}
        component={SubtitledVideoComposition}
        durationInFrames={durationInFrames}
        compositionWidth={safeWidth}
        compositionHeight={safeHeight}
        fps={frameRate}
        controls
        style={{
          width: '100%',
          height: '100%',
          borderRadius: '8px',
          overflow: 'hidden',
        }}
        inputProps={{
          videoUrl: videoUrl,
          narrationUrl: narrationAudioUrl,
          subtitles: subtitles || [],
          metadata: {
            subtitleCustomization: subtitleCustomization,
            resolution: subtitleCustomization?.resolution || '1080p',
            frameRate: frameRate,
          },
          isVideoFile: isVideoFile,
          originalAudioVolume: originalAudioVolume,
          narrationVolume: narrationVolume,
          cropSettings: (() => {
            const cs = isCropEnabled ? tempCropSettings : appliedCropSettings;
            return cs ?? null;
          })(),
        }}
        onFrame={handlePlayerTimeUpdate}
        onPlay={handlePlay}
        onPause={handlePause}
        onSeek={handleSeek}
      />

      {/* Crop controls overlay - directly on video */}
      {videoFile && videoDimensions && (
        <VideoCropControls
          isEnabled={isCropEnabled}
          onToggle={handleCropToggle}
          cropSettings={tempCropSettings}
          onCropChange={handleTempCropChange}
          onApply={handleApplyCrop}
          onCancel={handleCancelCrop}
          onClear={handleClearCrop}
          videoDimensions={videoDimensions}

          hasAppliedCrop={
            (appliedCropSettings.width !== 100 ||
             appliedCropSettings.height !== 100 ||
             appliedCropSettings.x !== 0 ||
             appliedCropSettings.y !== 0)
          }
        />
      )}
    </div>
  );
});

export default RemotionVideoPreview;
