import { useEffect, useState } from 'react';

/**
 * Owns the custom playback-control state that only the controls + render need
 * (isPlaying, playbackSpeed, speed-menu visibility, buffered/buffering/loading)
 * and wires up the video-element event handlers, the keyboard shortcuts, and the
 * fullscreen mouse-move / auto-hide behaviour.
 *
 * State that is shared across the other hooks (videoDuration, volume, isMuted,
 * showCustomControls, controlsVisible, isVideoHovered) stays in the parent and is
 * threaded in via setters. Shared refs (videoRef, videoContainerRef,
 * hideControlsTimeoutRef) are passed in too.
 *
 * Returns { isPlaying, setIsPlaying, playbackSpeed, setPlaybackSpeed,
 *           isSpeedMenuVisible, setIsSpeedMenuVisible,
 *           bufferedProgress, isBuffering, isVideoLoading }.
 */
const useVideoControls = ({
  videoRef,
  videoContainerRef,
  hideControlsTimeoutRef,
  videoUrl,
  videoDuration,
  isLoaded,
  isFullscreen,
  handleFullscreenExit,
  setDuration,
  setVideoDuration,
  setVolume,
  setIsMuted,
  setShowCustomControls,
  setControlsVisible,
  onDirectionalSeek,
  seekBy,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [isSpeedMenuVisible, setIsSpeedMenuVisible] = useState(false);
  const [bufferedProgress, setBufferedProgress] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isVideoLoading, setIsVideoLoading] = useState(true);

  // Custom video controls event handlers
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    const handleLoadedMetadata = () => {
      setVideoDuration(videoElement.duration);
      setDuration(videoElement.duration);
      setVolume(videoElement.volume);
      setIsMuted(videoElement.muted);
      setShowCustomControls(true);
      if (videoElement.buffered.length > 0 && videoElement.duration > 0) {
        const bufferedEnd = videoElement.buffered.end(videoElement.buffered.length - 1);
        setBufferedProgress((bufferedEnd / videoElement.duration) * 100);
      }
    };

    const updateBufferedProgress = () => {
      if (videoElement.buffered.length > 0 && videoDuration > 0) {
        const bufferedEnd = videoElement.buffered.end(videoElement.buffered.length - 1);
        setBufferedProgress((bufferedEnd / videoDuration) * 100);
      }
    };

    const handlePlay = () => {
      setIsPlaying(true);
    };

    const handlePause = () => {
      setIsPlaying(false);
    };

    const handleVolumeChange = () => {
      setVolume(videoElement.volume);
      setIsMuted(videoElement.muted);
    };

    const handleLoadStart = () => {
      setIsVideoLoading(true);
    };

    const handleCanPlay = () => {
      setIsVideoLoading(false);
    };

    const handleWaiting = () => {
      setIsBuffering(true);
    };

    const handleCanPlayThrough = () => {
      setIsBuffering(false);
    };

    // Add video event listeners
    videoElement.addEventListener('loadedmetadata', handleLoadedMetadata);
    videoElement.addEventListener('progress', updateBufferedProgress);
    videoElement.addEventListener('play', handlePlay);
    videoElement.addEventListener('pause', handlePause);
    videoElement.addEventListener('volumechange', handleVolumeChange);
    videoElement.addEventListener('loadstart', handleLoadStart);
    videoElement.addEventListener('canplay', handleCanPlay);
    videoElement.addEventListener('waiting', handleWaiting);
    videoElement.addEventListener('canplaythrough', handleCanPlayThrough);

    return () => {
      videoElement.removeEventListener('loadedmetadata', handleLoadedMetadata);
      videoElement.removeEventListener('progress', updateBufferedProgress);
      videoElement.removeEventListener('play', handlePlay);
      videoElement.removeEventListener('pause', handlePause);
      videoElement.removeEventListener('volumechange', handleVolumeChange);
      videoElement.removeEventListener('loadstart', handleLoadStart);
      videoElement.removeEventListener('canplay', handleCanPlay);
      videoElement.removeEventListener('waiting', handleWaiting);
      videoElement.removeEventListener('canplaythrough', handleCanPlayThrough);
    };
  }, [
    videoRef,
    videoUrl,
    setDuration,
    videoDuration,
    setVideoDuration,
    setVolume,
    setIsMuted,
    setShowCustomControls,
  ]);

  // Handle keyboard shortcuts for video control
  useEffect(() => {
    const handleKeyDown = (event) => {
      // Handle multiple keyboard shortcuts
      const validKeys = ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyM', 'KeyF', 'KeyK'];
      // Safely check event.key - it might be undefined during browser autocomplete
      const eventKey = event.key ? event.key.toLowerCase() : '';
      if (!validKeys.includes(event.code) && !['k', 'm', 'f', ' '].includes(eventKey)) return;

      // Global playback shortcuts must never steal an application or browser command. In
      // particular, Ctrl+A/arrow selection and Alt+arrow navigation belong to the focused owner.
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;

      // Do not consume arrows/space from an interactive or editable owner. Checking the event
      // target as well as activeElement covers synthetic clicks, range sliders, dropdowns and
      // focus transitions which have not reached document.activeElement yet.
      const target = event.target instanceof Element ? event.target : null;
      const activeElement = document.activeElement instanceof Element
        ? document.activeElement
        : null;
      const interactiveSelector = [
        'input', 'textarea', 'select', 'button', '[contenteditable="true"]',
        '[role="slider"]', '[role="spinbutton"]', '[role="combobox"]',
        '[role="menu"]', '[role="menuitem"]', '[role="option"]',
      ].join(',');
      if (target?.closest(interactiveSelector) || activeElement?.closest(interactiveSelector)) {
        return;
      }

      // Don't handle spacebar if a modal is open (check for common modal classes)
      const hasOpenModal = document.querySelector(
        '.modal-overlay, .settings-modal-overlay, .advanced-settings-modal-overlay, ' +
        '.download-modal-overlay, .segment-retry-modal-overlay, .prompt-editor-overlay, ' +
        '.subtitles-input-modal-overlay, .custom-modal-overlay'
      );
      if (hasOpenModal) {
        return;
      }

      // Don't handle spacebar if the video rendering section is expanded and focused
      // This prevents conflicts with the render tab's own preview
      const videoRenderingSection = document.querySelector('.video-rendering-section.expanded');
      const videoPreviewPanel = document.querySelector('.video-preview-panel');
      if (videoRenderingSection && videoPreviewPanel) {
        // Check if the user is interacting with the video rendering section
        const isInVideoRenderingArea = target?.closest('.video-rendering-section') ||
                                      target?.closest('.video-preview-panel');
        if (isInVideoRenderingArea) {
          return; // Let the render tab's preview handle its own spacebar events
        }
      }

      // Only proceed if video element exists and is loaded
      const videoElement = videoRef.current;
      if (!videoElement || !isLoaded) return;

      // Prevent default behavior for handled keys
      event.preventDefault();
      event.stopPropagation();

      // Handle different keyboard shortcuts
      // Safely check event.key - it might be undefined during browser autocomplete
      switch (event.code || eventKey) {
        case 'Space':
        case ' ':
        case 'KeyK':
        case 'k':
          // Toggle play/pause
          if (videoElement.paused) {
            videoElement.play().catch(error => {
              console.error('Error playing video:', error);
            });
          } else {
            videoElement.pause();
          }
          break;

        case 'ArrowUp':
          // Volume up
          videoElement.volume = Math.min(1, videoElement.volume + 0.1);
          setVolume(videoElement.volume);
          if (videoElement.muted) {
            videoElement.muted = false;
            setIsMuted(false);
          }
          break;

        case 'ArrowDown':
          // Volume down
          videoElement.volume = Math.max(0, videoElement.volume - 0.1);
          setVolume(videoElement.volume);
          if (videoElement.volume === 0) {
            videoElement.muted = true;
            setIsMuted(true);
          }
          break;

        case 'ArrowLeft':
          seekBy(-5, { reason: 'global-arrow' });
          onDirectionalSeek?.('backward');
          break;

        case 'ArrowRight':
          seekBy(5, { reason: 'global-arrow' });
          onDirectionalSeek?.('forward');
          break;

        case 'KeyM':
        case 'm':
          // Toggle mute
          videoElement.muted = !videoElement.muted;
          setIsMuted(videoElement.muted);
          if (!videoElement.muted && videoElement.volume === 0) {
            videoElement.volume = 0.5;
            setVolume(0.5);
          }
          break;

        case 'KeyF':
        case 'f':
          // Toggle fullscreen using actual document fullscreen state (avoid stale React state)
          {
            const isDocFullscreen = !!(document.fullscreenElement ||
                                       document.webkitFullscreenElement ||
                                       document.mozFullScreenElement ||
                                       document.msFullscreenElement);
            if (isDocFullscreen) {
              handleFullscreenExit();
            } else {
              const container = videoContainerRef.current;
              if (container) {
                if (container.requestFullscreen) {
                  container.requestFullscreen();
                } else if (container.webkitRequestFullscreen) {
                  container.webkitRequestFullscreen();
                } else if (container.mozRequestFullScreen) {
                  container.mozRequestFullScreen();
                } else if (container.msRequestFullscreen) {
                  container.msRequestFullscreen();
                }
              }
            }
          }
          break;

        default:
          break;
      }
    };

    // Add global keydown listener
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    isLoaded,
    videoDuration,
    handleFullscreenExit,
    videoRef,
    videoContainerRef,
    setVolume,
    setIsMuted,
    onDirectionalSeek,
    seekBy,
  ]);

  // Mouse movement with auto-hide in fullscreen
  useEffect(() => {
    const handleMouseMove = () => {
      // Only set controlsVisible in fullscreen mode
      if (isFullscreen) {
        setControlsVisible(true);

        // Always restore cursor when showing controls
        const videoContainer = videoContainerRef.current;
        if (videoContainer) {
          videoContainer.style.cursor = 'default';
        }

        // Clear existing timer
        if (hideControlsTimeoutRef.current) {
          clearTimeout(hideControlsTimeoutRef.current);
        }

        // Set new timer to hide controls after 1 second
        hideControlsTimeoutRef.current = setTimeout(() => {
          setControlsVisible(false);
          // Hide cursor too
          const videoContainer = videoContainerRef.current;
          if (videoContainer) {
            videoContainer.style.cursor = 'none';
          }
        }, 1000);
      }
      // In normal mode, don't touch controlsVisible - let hover handle it
    };

    const videoContainer = videoContainerRef.current;
    if (videoContainer) {
      videoContainer.addEventListener('mousemove', handleMouseMove);
      return () => {
        videoContainer.removeEventListener('mousemove', handleMouseMove);
        if (hideControlsTimeoutRef.current) {
          clearTimeout(hideControlsTimeoutRef.current);
        }
      };
    }
  }, [isFullscreen, videoContainerRef, hideControlsTimeoutRef, setControlsVisible]);

  return {
    isPlaying,
    setIsPlaying,
    playbackSpeed,
    setPlaybackSpeed,
    isSpeedMenuVisible,
    setIsSpeedMenuVisible,
    bufferedProgress,
    isBuffering,
    isVideoLoading,
  };
};

export default useVideoControls;
