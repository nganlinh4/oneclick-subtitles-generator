import React, { useEffect, useRef, useState } from 'react';

/**
 * FloatingScrollbar component
 * Creates a custom floating scrollbar that doesn't affect layout
 * and prevents horizontal fluctuation when scrollbars appear and disappear
 *
 * Smart behavior:
 * - Shows quickly when scrolling starts
 * - Hides quickly when scrolling stops
 * - Only visible when needed
 * - Doesn't interfere with page interaction
 */
const FloatingScrollbar = () => {
  const thumbRef = useRef(null);
  const containerRef = useRef(null);
  const trackRef = useRef(null);
  const trackHoldIntervalRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [scrollStartPosition, setScrollStartPosition] = useState(null);
  const [initialScrollTop, setInitialScrollTop] = useState(0);
  const [isScrolling, setIsScrolling] = useState(false); // Used in JSX className
  const scrollingTimeoutRef = useRef(null);
  const lastScrollTop = useRef(0);
  const scrollDirectionRef = useRef(null);
  const activityTimeoutRef = useRef(null);
  const hideTimeoutRef = useRef(null);

  // Calculate the thumb height and position based on scroll position
  const updateThumbPosition = () => {
    if (!thumbRef.current || !containerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = document.documentElement;

    // Check if scrolling is actually needed
    const isScrollNeeded = scrollHeight > clientHeight;

    // If no scrolling is needed, hide the scrollbar and return
    if (!isScrollNeeded) {
      if (containerRef.current) {
        containerRef.current.classList.remove('scrolling');
        containerRef.current.classList.add('fade-out');

        // Add a class to completely hide the scrollbar after fade-out
        setTimeout(() => {
          if (containerRef.current && !isScrollNeeded) {
            containerRef.current.classList.add('hidden');
          }
        }, 300); // Match the fade-out transition duration
      }
      return;
    } else if (containerRef.current) {
      // If scrolling is needed, make sure the hidden class is removed
      containerRef.current.classList.remove('hidden');
    }

    // Determine scroll direction
    const direction = scrollTop > lastScrollTop.current ? 'down' : 'up';
    scrollDirectionRef.current = direction;
    lastScrollTop.current = scrollTop;

    // Calculate the thumb height proportional to the visible portion of content
    const thumbHeight = Math.max(
      (clientHeight / scrollHeight) * clientHeight,
      30 // Minimum thumb height in pixels
    );

    // Calculate the thumb position
    const thumbTop = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - thumbHeight);

    // Update the thumb style
    thumbRef.current.style.height = `${thumbHeight}px`;
    thumbRef.current.style.top = `${thumbTop}px`;

    // Show the scrollbar when scrolling and scrolling is needed
    if (containerRef.current && isScrollNeeded) {
      // Remove fade-out class if it exists
      containerRef.current.classList.remove('fade-out');
      // Add scrolling class
      containerRef.current.classList.add('scrolling');

      // Clear any existing timeouts
      if (scrollingTimeoutRef.current) {
        clearTimeout(scrollingTimeoutRef.current);
      }
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }

      // Set a timeout to start hiding the scrollbar after scrolling stops
      scrollingTimeoutRef.current = setTimeout(() => {
        if (containerRef.current) {
          // Add fade-out class for smooth transition
          containerRef.current.classList.add('fade-out');
          // Remove scrolling class after fade-out animation completes
          hideTimeoutRef.current = setTimeout(() => {
            if (containerRef.current) {
              containerRef.current.classList.remove('scrolling');
            }
          }, 300); // Match the fade-out transition duration
        }
      }, 600); // Hide after 600ms of inactivity
    }
  };

  // Handle mouse down on the thumb
  const handleThumbMouseDown = (e) => {
    e.preventDefault();
    setIsDragging(true);
    setScrollStartPosition(e.clientY);
    setInitialScrollTop(document.documentElement.scrollTop);
    document.body.style.userSelect = 'none'; // Prevent text selection while dragging
  };

  // Handle mouse move while dragging
  const handleDocumentMouseMove = (e) => {
    if (!isDragging || scrollStartPosition === null) return;

    const { scrollHeight, clientHeight } = document.documentElement;
    const scrollDelta = e.clientY - scrollStartPosition;
    const scrollFactor = scrollHeight / clientHeight;

    // Update scroll position
    window.scrollTo({
      top: initialScrollTop + (scrollDelta * scrollFactor),
      behavior: 'auto'
    });
  };

  // Handle mouse up to end dragging
  const handleDocumentMouseUp = () => {
    if (isDragging) {
      setIsDragging(false);
      setScrollStartPosition(null);
      document.body.style.userSelect = ''; // Restore text selection
    }
    // Stop track hold scrolling
    if (trackHoldIntervalRef.current) {
      clearInterval(trackHoldIntervalRef.current);
      trackHoldIntervalRef.current = null;
    }
  };

  // Page-like scroll by viewport step
  const pageScrollBy = (direction) => {
    const { clientHeight } = document.documentElement;
    const step = Math.max(clientHeight - 40, 40); // keep some overlap like native
    window.scrollBy({ top: direction === 'down' ? step : -step, behavior: 'auto' });
  };

  // Handle clicking/holding on track to page scroll like native
  const handleTrackMouseDown = (e) => {
    if (!thumbRef.current || !containerRef.current) return;
    e.preventDefault();

    const thumbRect = thumbRef.current.getBoundingClientRect();
    const clickedBelow = e.clientY > thumbRect.bottom;
    const clickedAbove = e.clientY < thumbRect.top;

    // Only act when clicking outside the thumb area
    if (!clickedAbove && !clickedBelow) return;

    const direction = clickedBelow ? 'down' : 'up';

    // Perform an initial page step
    pageScrollBy(direction);

    // Ensure the scrollbar stays visible while holding
    containerRef.current.classList.remove('fade-out');
    containerRef.current.classList.remove('hidden');
    containerRef.current.classList.add('scrolling');

    // Start repeating page scroll while mouse is held down
    if (trackHoldIntervalRef.current) {
      clearInterval(trackHoldIntervalRef.current);
    }
    trackHoldIntervalRef.current = setInterval(() => pageScrollBy(direction), 120);
  };

  // Handle document mouse move for edge detection
  const handleEdgeDetection = (e) => {
    // Check if scrolling is needed
    const { scrollHeight, clientHeight } = document.documentElement;
    const isScrollNeeded = scrollHeight > clientHeight;

    if (!isScrollNeeded || !containerRef.current) return;

    // Get viewport width
    const viewportWidth = document.documentElement.clientWidth;

    // Define the edge detection zone (pixels from right edge)
    // This should match the width of the floating-scrollbar-container in CSS
    const edgeThreshold = 30;

    // Check if mouse is near the right edge
    const isNearRightEdge = viewportWidth - e.clientX <= edgeThreshold;

    if (isNearRightEdge) {
      // Show the scrollbar when near the right edge
      containerRef.current.classList.remove('fade-out');
      containerRef.current.classList.remove('hidden');
      containerRef.current.classList.add('scrolling');

      // Clear any existing hide timeout
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
        hideTimeoutRef.current = null;
      }
    } else if (containerRef.current.classList.contains('scrolling') && !isDragging) {
      // Start hiding the scrollbar when mouse moves away from the edge (and not dragging)
      if (!hideTimeoutRef.current) {
        hideTimeoutRef.current = setTimeout(() => {
          if (containerRef.current) {
            containerRef.current.classList.add('fade-out');
            setTimeout(() => {
              if (containerRef.current) {
                containerRef.current.classList.remove('scrolling');
              }
            }, 300);
          }
        }, 600);
      }
    }
  };

  // Set up event listeners
  useEffect(() => {
    // Initial update
    updateThumbPosition();

    // Add scroll event listener with passive option for better performance
    window.addEventListener('scroll', updateThumbPosition, { passive: true });

    // Add resize event listener with passive option for better performance
    window.addEventListener('resize', updateThumbPosition, { passive: true });

    // Store the combined mousemove handler for cleanup
    const combinedMouseMoveHandler = (e) => {
      handleDocumentMouseMove(e);
      handleEdgeDetection(e);
    };

    // Add mouse move for dragging and edge detection
    document.addEventListener('mousemove', combinedMouseMoveHandler);

    document.addEventListener('mouseup', handleDocumentMouseUp);

    // Add wheel event listener to detect mousewheel scrolling
    const onWheel = () => {
      // Check if scrolling is needed before showing the scrollbar
      const { scrollHeight, clientHeight } = document.documentElement;
      const isScrollNeeded = scrollHeight > clientHeight;

      // Only show scrollbar if scrolling is actually needed
      if (containerRef.current && isScrollNeeded) {
        containerRef.current.classList.remove('fade-out');
        containerRef.current.classList.remove('hidden');
        containerRef.current.classList.add('scrolling');
      }
    };
    window.addEventListener('wheel', onWheel, { passive: true });

    // Create a ResizeObserver to detect changes in document height
    const resizeObserver = new ResizeObserver((entries) => {
      // Check if scrolling is needed after content size changes
      const { scrollHeight, clientHeight } = document.documentElement;
      const isScrollNeeded = scrollHeight > clientHeight;

      // If scrolling is not needed, hide the scrollbar
      if (!isScrollNeeded && containerRef.current) {
        containerRef.current.classList.remove('scrolling');
        containerRef.current.classList.add('fade-out');

        // Add a class to completely hide the scrollbar after fade-out
        setTimeout(() => {
          if (containerRef.current && !(document.documentElement.scrollHeight > document.documentElement.clientHeight)) {
            containerRef.current.classList.add('hidden');
          }
        }, 300); // Match the fade-out transition duration
      } else if (isScrollNeeded && containerRef.current) {
        // If scrolling is needed, make sure the hidden class is removed
        containerRef.current.classList.remove('hidden');
        // Update the thumb position
        updateThumbPosition();
      }
    });

    // Observe the document body for size changes
    resizeObserver.observe(document.body);

    // Clean up event listeners
    return () => {
      window.removeEventListener('scroll', updateThumbPosition);
      window.removeEventListener('resize', updateThumbPosition);
      window.removeEventListener('wheel', onWheel);
      document.removeEventListener('mousemove', combinedMouseMoveHandler);
      document.removeEventListener('mouseup', handleDocumentMouseUp);

      // Disconnect the resize observer
      resizeObserver.disconnect();

      // Clear all timeouts
      if (scrollingTimeoutRef.current) {
        clearTimeout(scrollingTimeoutRef.current);
      }
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current);
      }
      // Store ref value in a variable to avoid the cleanup function using a changed ref value
      const activityTimeout = activityTimeoutRef.current;
      if (activityTimeout) {
        clearTimeout(activityTimeout);
      }
    };
  }, [isDragging, scrollStartPosition, initialScrollTop, handleDocumentMouseMove, handleDocumentMouseUp, handleEdgeDetection]);

  // Check if scrolling is needed for initial render
  const [isScrollNeededState, setIsScrollNeededState] = useState(false);

  // Update the scroll needed state on mount and when dependencies change
  useEffect(() => {
    const checkIfScrollNeeded = () => {
      const { scrollHeight, clientHeight } = document.documentElement;
      setIsScrollNeededState(scrollHeight > clientHeight);
    };

    // Check immediately
    checkIfScrollNeeded();

    // Also check after a short delay to account for dynamic content loading
    const timeoutId = setTimeout(checkIfScrollNeeded, 100);

    return () => clearTimeout(timeoutId);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`floating-scrollbar-container ${isScrolling ? 'scrolling' : ''} ${!isScrollNeededState ? 'hidden' : ''}`}
    >
      {/* Visible track behind the thumb */}
      <div
        ref={trackRef}
        className="floating-scrollbar-track"
        onMouseDown={handleTrackMouseDown}
      />
      {/* Thumb */}
      <div
        ref={thumbRef}
        className={`floating-scrollbar-thumb ${isDragging ? 'dragging' : ''}`}
        onMouseDown={handleThumbMouseDown}
      />
    </div>
  );
};

export default FloatingScrollbar;
