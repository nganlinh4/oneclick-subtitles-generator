import { useEffect, useState, useCallback } from 'react';

/**
 * Owns all fullscreen DOM logic for VideoPreview:
 *  - handleFullscreenChange (resize/style the video to fill the screen, cleanup on exit)
 *  - handleFullscreenExit (used by both the button and the ESC/F key path)
 *
 * Keeps videoRef/videoContainerRef external (passed in) and threads the control
 * setters it needs (controls visibility / custom controls / hover) up to the parent.
 *
 * Returns { isFullscreen, setIsFullscreen, handleFullscreenExit }.
 */
const useFullscreenSubtitles = ({
  videoRef,
  videoContainerRef,
  setControlsVisible,
  setShowCustomControls,
  setIsVideoHovered,
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false); // Track fullscreen state

  // Function to handle fullscreen exit (used by both button and ESC key)
  const handleFullscreenExit = useCallback(() => {

    // Try all exit fullscreen methods
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(console.error);
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen();
    } else if (document.msExitFullscreen) {
      document.msExitFullscreen();
    }

    // Force state update if needed
    setTimeout(() => {
      const stillFullscreen = !!(document.fullscreenElement ||
                               document.webkitFullscreenElement ||
                               document.mozFullScreenElement ||
                               document.msFullscreenElement);
      if (!stillFullscreen) {

        // Reset all styles
        const videoElement = document.querySelector('.native-video-container video');
        const videoWrapper = document.querySelector('.native-video-container .video-wrapper');
        const container = document.querySelector('.native-video-container');

        if (videoElement) {
          videoElement.style.removeProperty('width');
          videoElement.style.removeProperty('height');
          videoElement.style.removeProperty('object-fit');
          videoElement.style.removeProperty('position');
          videoElement.style.removeProperty('top');
          videoElement.style.removeProperty('left');
          videoElement.style.removeProperty('z-index');
          videoElement.style.removeProperty('max-width');
          videoElement.style.removeProperty('max-height');
          videoElement.style.removeProperty('min-width');
          videoElement.style.removeProperty('min-height');
          videoElement.style.removeProperty('transform');
          videoElement.style.removeProperty('border-radius');
          videoElement.classList.remove('fullscreen-video');
        }

        if (videoWrapper) {
          videoWrapper.style.removeProperty('width');
          videoWrapper.style.removeProperty('height');
          videoWrapper.style.removeProperty('position');
          videoWrapper.style.removeProperty('top');
          videoWrapper.style.removeProperty('left');
          videoWrapper.style.removeProperty('z-index');
          videoWrapper.style.removeProperty('overflow');
        }

        if (container) {
          container.style.removeProperty('width');
          container.style.removeProperty('height');
          container.style.removeProperty('position');
          container.style.removeProperty('top');
          container.style.removeProperty('left');
          container.style.removeProperty('z-index');
          container.style.removeProperty('background');
          // Reset cursor to default
          container.style.cursor = 'default';
        }

        setIsFullscreen(false);
        setControlsVisible(false); // Reset controls to hidden when exiting fullscreen (normal mode uses hover)
        // FIX: Check if mouse is still hovering and set state accordingly
        if (videoContainerRef.current?.matches(':hover')) {
          setIsVideoHovered(true);
        } else {
          setIsVideoHovered(false);
        }
      }
    }, 100);
  }, [videoContainerRef, setControlsVisible, setIsVideoHovered]);

  // Handle fullscreen changes
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    // Function to handle fullscreen change events
    const handleFullscreenChange = () => {
      const isDocFullscreen = !!document.fullscreenElement ||
                             !!document.webkitFullscreenElement ||
                             !!document.mozFullScreenElement ||
                             !!document.msFullscreenElement;

      // Check if our video container is the fullscreen element
      const container = videoContainerRef.current;
      const isVideoFullscreen = isDocFullscreen &&
                              (document.fullscreenElement === container ||
                               document.webkitFullscreenElement === container ||
                               document.mozFullScreenElement === container ||
                               document.msFullscreenElement === container);


      setIsFullscreen(isVideoFullscreen);

      // Reset control states when exiting fullscreen
      if (!isVideoFullscreen) {
        setControlsVisible(false); // Reset controls to hidden when exiting fullscreen (normal mode uses hover)
        // FIX: Check hover state when exiting
        if (videoContainerRef.current?.matches(':hover')) {
          setIsVideoHovered(true);
        } else {
          setIsVideoHovered(false);
        }
      }

      // If entering fullscreen, create the subtitle container and setup controls
      if (isVideoFullscreen) {
        // Add a class to the video element to help with styling
        videoElement.classList.add('fullscreen-video');

        setControlsVisible(true);
        setShowCustomControls(true); // Force custom controls to be rendered

        // Force controls to be visible by directly setting CSS
        setTimeout(() => {
          const container = videoContainerRef.current;
          if (container) {
            const controlElements = container.querySelectorAll('[style*="opacity"]');
            controlElements.forEach((element) => {
              // className can be an object on SVG elements (SVGAnimatedString), so don't assume it's a string
              const classAttr = typeof element.className === 'string'
                ? element.className
                : (element.getAttribute && element.getAttribute('class')) || '';
              const hasLiquidGlass = element.classList && element.classList.contains('liquid-glass');
              const hasInteractive = element.classList && element.classList.contains('interactive');

              if ((hasLiquidGlass && hasInteractive) || (classAttr.includes('liquid-glass') && classAttr.includes('interactive'))) {
                element.style.setProperty('opacity', '1', 'important');
                element.style.setProperty('pointer-events', 'auto', 'important');
                element.style.setProperty('z-index', '999999', 'important');
                element.style.setProperty('display', 'flex', 'important');
                element.style.setProperty('visibility', 'visible', 'important');
                element.style.setProperty('transform', 'none', 'important');
              }
            });
          }
        }, 100);

        // Force video and container to fill fullscreen with JavaScript
        setTimeout(() => {
          if (videoElement) {

            // Use setProperty with important flag to override any existing styles
            videoElement.style.setProperty('width', '100vw', 'important');
            videoElement.style.setProperty('height', '100vh', 'important');
            videoElement.style.setProperty('object-fit', 'contain', 'important');
            videoElement.style.setProperty('position', 'fixed', 'important');
            videoElement.style.setProperty('top', '0', 'important');
            videoElement.style.setProperty('left', '0', 'important');
            videoElement.style.setProperty('z-index', '1', 'important');
            videoElement.style.setProperty('max-width', 'none', 'important');
            videoElement.style.setProperty('max-height', 'none', 'important');
            videoElement.style.setProperty('min-width', '100vw', 'important');
            videoElement.style.setProperty('min-height', '100vh', 'important');
            videoElement.style.setProperty('transform', 'none', 'important');
            videoElement.style.setProperty('border-radius', '0', 'important');

            // Also remove any conflicting attributes
            videoElement.removeAttribute('width');
            videoElement.removeAttribute('height');


            // Force video wrapper styles
            const videoWrapper = videoElement.closest('.video-wrapper');
            if (videoWrapper) {
              videoWrapper.style.setProperty('width', '100vw', 'important');
              videoWrapper.style.setProperty('height', '100vh', 'important');
              videoWrapper.style.setProperty('position', 'fixed', 'important');
              videoWrapper.style.setProperty('top', '0', 'important');
              videoWrapper.style.setProperty('left', '0', 'important');
              videoWrapper.style.setProperty('z-index', '1', 'important'); // Lower than subtitle container
              videoWrapper.style.setProperty('overflow', 'hidden', 'important');
            }

            // Force container styles
            if (container) {
              container.style.setProperty('width', '100vw', 'important');
              container.style.setProperty('height', '100vh', 'important');
              container.style.setProperty('position', 'fixed', 'important');
              container.style.setProperty('top', '0', 'important');
              container.style.setProperty('left', '0', 'important');
              container.style.setProperty('z-index', '998', 'important');
              container.style.setProperty('display', 'block', 'important');
              container.style.setProperty('padding', '0', 'important');
              container.style.setProperty('margin', '0', 'important');
            }

          }
        }, 100);
      } else {
        // If exiting fullscreen, force our manual exit function to ensure proper cleanup

        videoElement.classList.remove('fullscreen-video');

        // Call our manual exit function to ensure all styles are properly reset
        // Use setTimeout to avoid potential conflicts with the browser's own cleanup
        setTimeout(() => {

          // Reset all styles using the same logic as the button
          const videoElement = document.querySelector('.native-video-container video');
          const videoWrapper = document.querySelector('.native-video-container .video-wrapper');
          const container = videoContainerRef.current;

          if (videoElement) {
            videoElement.style.removeProperty('width');
            videoElement.style.removeProperty('height');
            videoElement.style.removeProperty('object-fit');
            videoElement.style.removeProperty('position');
            videoElement.style.removeProperty('top');
            videoElement.style.removeProperty('left');
            videoElement.style.removeProperty('z-index');
            videoElement.style.removeProperty('max-width');
            videoElement.style.removeProperty('max-height');
            videoElement.style.removeProperty('min-width');
            videoElement.style.removeProperty('min-height');
            videoElement.style.removeProperty('transform');
            videoElement.style.removeProperty('border-radius');
            videoElement.classList.remove('fullscreen-video');
          }

          if (videoWrapper) {
            videoWrapper.style.removeProperty('width');
            videoWrapper.style.removeProperty('height');
            videoWrapper.style.removeProperty('position');
            videoWrapper.style.removeProperty('top');
            videoWrapper.style.removeProperty('left');
            videoWrapper.style.removeProperty('z-index');
            videoWrapper.style.removeProperty('overflow');
          }

          if (container) {
            container.style.removeProperty('width');
            container.style.removeProperty('height');
            container.style.removeProperty('position');
            container.style.removeProperty('top');
            container.style.removeProperty('left');
            container.style.removeProperty('z-index');
            container.style.removeProperty('background');
            container.style.removeProperty('display');
            container.style.removeProperty('padding');
            container.style.removeProperty('margin');
            // Reset cursor to default
            container.style.cursor = 'default';
          }

        }, 50);

        // Additional cleanup: If we're not in fullscreen but still have fullscreen styles, force cleanup
        if (!isDocFullscreen) {
          setTimeout(() => {
            // Force reset all possible fullscreen styles
            const allVideos = document.querySelectorAll('video');
            allVideos.forEach(video => {
              if (video.style.position === 'fixed' || video.style.width === '100vw') {
                video.style.removeProperty('width');
                video.style.removeProperty('height');
                video.style.removeProperty('object-fit');
                video.style.removeProperty('position');
                video.style.removeProperty('top');
                video.style.removeProperty('left');
                video.style.removeProperty('z-index');
                video.style.removeProperty('max-width');
                video.style.removeProperty('max-height');
                video.style.removeProperty('min-width');
                video.style.removeProperty('min-height');
                video.style.removeProperty('transform');
                video.style.removeProperty('border-radius');
                video.classList.remove('fullscreen-video');
              }
            });

            // Force reset all video wrappers
            const allWrappers = document.querySelectorAll('.video-wrapper');
            allWrappers.forEach(wrapper => {
              if (wrapper.style.position === 'fixed' || wrapper.style.width === '100vw') {
                wrapper.style.removeProperty('width');
                wrapper.style.removeProperty('height');
                wrapper.style.removeProperty('position');
                wrapper.style.removeProperty('top');
                wrapper.style.removeProperty('left');
                wrapper.style.removeProperty('z-index');
                wrapper.style.removeProperty('overflow');
              }
            });

            // Force reset all video containers
            const allContainers = document.querySelectorAll('.native-video-container');
            allContainers.forEach(container => {
              if (container.style.position === 'fixed' || container.style.width === '100vw') {
                container.style.removeProperty('width');
                container.style.removeProperty('height');
                container.style.removeProperty('position');
                container.style.removeProperty('top');
                container.style.removeProperty('left');
                container.style.removeProperty('z-index');
                container.style.removeProperty('display');
                container.style.removeProperty('padding');
                container.style.removeProperty('margin');
                container.style.cursor = 'default';
              }
            });

            // Ensure React state is also updated
            setIsFullscreen(false);
            setControlsVisible(false); // Reset controls to hidden when exiting fullscreen (normal mode uses hover)
            // FIX: Check hover state when exiting
            if (videoContainerRef.current?.matches(':hover')) {
              setIsVideoHovered(true);
            } else {
              setIsVideoHovered(false);
            }
          }, 50);
        }
      }
    };

    // Add event listeners for all browser variants
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    // Add window-level listener to catch any missed fullscreen changes
    const handleWindowResize = () => {
      // Check if we think we're in fullscreen but actually aren't
      const isActuallyFullscreen = !!(document.fullscreenElement ||
                                     document.webkitFullscreenElement ||
                                     document.mozFullScreenElement ||
                                     document.msFullscreenElement);

      if (isFullscreen && !isActuallyFullscreen) {
        handleFullscreenChange();
      }
    };

    window.addEventListener('resize', handleWindowResize);

    // Add ESC key listener - let browser handle exit, but ensure our cleanup runs
    const handleEscKey = (event) => {
      if (event.key === 'Escape' && isFullscreen) {
        // Don't prevent default - let browser handle the exit
        // Our handleFullscreenChange will be called and will do the proper cleanup
      }
    };

    document.addEventListener('keydown', handleEscKey);

    // Clean up
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
      window.removeEventListener('resize', handleWindowResize);
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [
    videoRef,
    videoContainerRef,
    handleFullscreenExit,
    isFullscreen,
    setControlsVisible,
    setShowCustomControls,
    setIsVideoHovered,
  ]);

  return { isFullscreen, setIsFullscreen, handleFullscreenExit };
};

export default useFullscreenSubtitles;
