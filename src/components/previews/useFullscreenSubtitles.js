import { useEffect, useState, useCallback } from 'react';

/**
 * Owns the fullscreen DOM logic for VideoPreview: it forces the video, wrapper and container to
 * fill the screen on entry, resets those styles on exit, and threads the control setters it
 * needs (controls visibility / custom controls / hover) up to the parent.
 *
 * Returns { isFullscreen, setIsFullscreen, handleFullscreenExit }.
 */

const VIDEO_FULLSCREEN_STYLES = Object.freeze([
  ['width', '100vw'],
  ['height', '100vh'],
  ['object-fit', 'contain'],
  ['position', 'fixed'],
  ['top', '0'],
  ['left', '0'],
  ['z-index', '1'],
  ['max-width', 'none'],
  ['max-height', 'none'],
  ['min-width', '100vw'],
  ['min-height', '100vh'],
  ['transform', 'none'],
  ['border-radius', '0'],
]);
const WRAPPER_FULLSCREEN_STYLES = Object.freeze([
  ['width', '100vw'],
  ['height', '100vh'],
  ['position', 'fixed'],
  ['top', '0'],
  ['left', '0'],
  ['z-index', '1'], // below the subtitle container
  ['overflow', 'hidden'],
]);
const CONTAINER_FULLSCREEN_STYLES = Object.freeze([
  ['width', '100vw'],
  ['height', '100vh'],
  ['position', 'fixed'],
  ['top', '0'],
  ['left', '0'],
  ['z-index', '998'],
  ['display', 'block'],
  ['padding', '0'],
  ['margin', '0'],
]);
const FULLSCREEN_CONTROL_STYLES = Object.freeze([
  ['opacity', '1'],
  ['pointer-events', 'auto'],
  ['z-index', '999999'],
  ['display', 'flex'],
  ['visibility', 'visible'],
  ['transform', 'none'],
]);

const VIDEO_RESET = VIDEO_FULLSCREEN_STYLES.map(([name]) => name);
const WRAPPER_RESET = WRAPPER_FULLSCREEN_STYLES.map(([name]) => name);
const CONTAINER_POSITION_RESET = Object.freeze(['width', 'height', 'position', 'top', 'left', 'z-index']);
const CONTAINER_BOX_RESET = Object.freeze(['display', 'padding', 'margin']);

const applyImportant = (element, styles) => {
  styles.forEach(([name, value]) => element.style.setProperty(name, value, 'important'));
};

const removeStyles = (element, names) => {
  names.forEach((name) => element.style.removeProperty(name));
};

const resetVideo = (video) => {
  removeStyles(video, VIDEO_RESET);
  video.classList.remove('fullscreen-video');
};

const resetContainer = (container, extraNames) => {
  removeStyles(container, CONTAINER_POSITION_RESET);
  removeStyles(container, extraNames);
  container.style.cursor = 'default';
};

const currentFullscreenElement = () => document.fullscreenElement
  || document.webkitFullscreenElement
  || document.mozFullScreenElement
  || document.msFullscreenElement
  || null;

const isStillFullscreenStyled = (element) => (
  element.style.position === 'fixed' || element.style.width === '100vw'
);

// className can be an SVGAnimatedString on SVG elements, so read the attribute as a fallback.
const isInteractiveGlass = (element) => {
  const classAttr = typeof element.className === 'string'
    ? element.className
    : (element.getAttribute && element.getAttribute('class')) || '';
  const hasClasses = element.classList
    && element.classList.contains('liquid-glass')
    && element.classList.contains('interactive');
  return hasClasses || (classAttr.includes('liquid-glass') && classAttr.includes('interactive'));
};

const exitDocumentFullscreen = () => {
  if (document.exitFullscreen) {
    document.exitFullscreen().catch(console.error);
  } else if (document.webkitExitFullscreen) {
    document.webkitExitFullscreen();
  } else if (document.mozCancelFullScreen) {
    document.mozCancelFullScreen();
  } else if (document.msExitFullscreen) {
    document.msExitFullscreen();
  }
};

const useFullscreenSubtitles = ({
  videoRef,
  videoContainerRef,
  setControlsVisible,
  setShowCustomControls,
  setIsVideoHovered,
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Normal (non-fullscreen) mode shows controls on hover, so resync hover on every exit.
  const leaveFullscreenState = useCallback(() => {
    setControlsVisible(false);
    setIsVideoHovered(Boolean(videoContainerRef.current?.matches(':hover')));
  }, [videoContainerRef, setControlsVisible, setIsVideoHovered]);

  // Used by the exit button and the ESC/F key path.
  const handleFullscreenExit = useCallback(() => {
    exitDocumentFullscreen();

    setTimeout(() => {
      if (currentFullscreenElement()) return;
      const videoElement = document.querySelector('.native-video-container video');
      const videoWrapper = document.querySelector('.native-video-container .video-wrapper');
      const container = document.querySelector('.native-video-container');
      if (videoElement) resetVideo(videoElement);
      if (videoWrapper) removeStyles(videoWrapper, WRAPPER_RESET);
      if (container) resetContainer(container, ['background']);
      setIsFullscreen(false);
      leaveFullscreenState();
    }, 100);
  }, [leaveFullscreenState]);

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    const enterFullscreen = (container) => {
      videoElement.classList.add('fullscreen-video');
      setControlsVisible(true);
      setShowCustomControls(true);

      // Force the custom controls visible over the fullscreen video.
      setTimeout(() => {
        const current = videoContainerRef.current;
        if (!current) return;
        current.querySelectorAll('[style*="opacity"]').forEach((element) => {
          if (isInteractiveGlass(element)) applyImportant(element, FULLSCREEN_CONTROL_STYLES);
        });
      }, 100);

      // Force video and container to fill the screen, overriding any existing styles.
      setTimeout(() => {
        applyImportant(videoElement, VIDEO_FULLSCREEN_STYLES);
        videoElement.removeAttribute('width');
        videoElement.removeAttribute('height');
        const videoWrapper = videoElement.closest('.video-wrapper');
        if (videoWrapper) applyImportant(videoWrapper, WRAPPER_FULLSCREEN_STYLES);
        if (container) applyImportant(container, CONTAINER_FULLSCREEN_STYLES);
      }, 100);
    };

    const exitFullscreen = (isDocFullscreen) => {
      videoElement.classList.remove('fullscreen-video');

      // Deferred so the browser's own cleanup runs first.
      setTimeout(() => {
        const video = document.querySelector('.native-video-container video');
        const videoWrapper = document.querySelector('.native-video-container .video-wrapper');
        const container = videoContainerRef.current;
        if (video) resetVideo(video);
        if (videoWrapper) removeStyles(videoWrapper, WRAPPER_RESET);
        if (container) resetContainer(container, ['background', ...CONTAINER_BOX_RESET]);
      }, 50);

      if (isDocFullscreen) return;
      // Sweep any element still carrying fullscreen styles, then settle React state.
      setTimeout(() => {
        document.querySelectorAll('video').forEach((video) => {
          if (isStillFullscreenStyled(video)) resetVideo(video);
        });
        document.querySelectorAll('.video-wrapper').forEach((wrapper) => {
          if (isStillFullscreenStyled(wrapper)) removeStyles(wrapper, WRAPPER_RESET);
        });
        document.querySelectorAll('.native-video-container').forEach((container) => {
          if (isStillFullscreenStyled(container)) resetContainer(container, CONTAINER_BOX_RESET);
        });
        setIsFullscreen(false);
        leaveFullscreenState();
      }, 50);
    };

    const handleFullscreenChange = () => {
      const fullscreenElement = currentFullscreenElement();
      const container = videoContainerRef.current;
      const isVideoFullscreen = fullscreenElement !== null && fullscreenElement === container;

      setIsFullscreen(isVideoFullscreen);
      if (isVideoFullscreen) {
        enterFullscreen(container);
      } else {
        leaveFullscreenState();
        exitFullscreen(fullscreenElement !== null);
      }
    };

    // Catches an exit whose fullscreenchange event was missed.
    const handleWindowResize = () => {
      if (isFullscreen && !currentFullscreenElement()) handleFullscreenChange();
    };

    const fullscreenEvents = ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'];
    fullscreenEvents.forEach((name) => document.addEventListener(name, handleFullscreenChange));
    window.addEventListener('resize', handleWindowResize);

    return () => {
      fullscreenEvents.forEach((name) => document.removeEventListener(name, handleFullscreenChange));
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [
    videoRef,
    videoContainerRef,
    isFullscreen,
    leaveFullscreenState,
    setControlsVisible,
    setShowCustomControls,
  ]);

  return { isFullscreen, setIsFullscreen, handleFullscreenExit };
};

export default useFullscreenSubtitles;
