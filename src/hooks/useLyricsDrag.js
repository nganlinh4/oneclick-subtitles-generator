import { useRef } from 'react';

/**
 * Mouse + touch drag handlers for adjusting lyric timings. Closes over the
 * editor's drag primitives plus current lyrics/duration via params. Returns the
 * down/start handlers wired with throttled move + cleanup-on-release.
 */
export const useLyricsDrag = ({ lyrics, duration, startDrag, handleDrag, endDrag }) => {
  // Throttle move events to ~60fps
  const lastMoveTimeRef = useRef(0);

  // Setup drag event handlers with performance optimizations
  const handleMouseDown = (e, index, field) => {
    e.preventDefault();
    e.stopPropagation();
    startDrag(index, field, e.clientX, lyrics[index][field]);

    // Use passive event listeners for better performance
    document.addEventListener('mousemove', handleMouseMove, { passive: false });
    document.addEventListener('mouseup', handleMouseUp, { passive: false });

    // Add a class to the body to indicate dragging is in progress
    document.body.classList.add('lyrics-dragging');
  };

  const handleMouseMove = (e) => {
    e.preventDefault();

    // Throttle mousemove events
    const now = performance.now();
    if (now - lastMoveTimeRef.current < 16) { // ~60fps
      return;
    }
    lastMoveTimeRef.current = now;

    // Use requestAnimationFrame for smoother updates
    requestAnimationFrame(() => {
      handleDrag(e.clientX, duration);
    });
  };

  const handleMouseUp = (e) => {
    e.preventDefault();
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    document.body.classList.remove('lyrics-dragging');
    endDrag();
  };

  // Touch drag support for mobile
  const handleTouchStart = (e, index, field) => {
    if (!e.touches || e.touches.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const touch = e.touches[0];
    startDrag(index, field, touch.clientX, lyrics[index][field]);

    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd, { passive: false });
    document.addEventListener('touchcancel', handleTouchEnd, { passive: false });
    document.body.classList.add('lyrics-dragging');
  };

  const handleTouchMove = (e) => {
    if (!e.touches || e.touches.length === 0) return;
    e.preventDefault();

    const now = performance.now();
    if (now - lastMoveTimeRef.current < 16) {
      return;
    }
    lastMoveTimeRef.current = now;

    const touch = e.touches[0];
    requestAnimationFrame(() => {
      handleDrag(touch.clientX, duration);
    });
  };

  const handleTouchEnd = (e) => {
    e.preventDefault();
    document.removeEventListener('touchmove', handleTouchMove);
    document.removeEventListener('touchend', handleTouchEnd);
    document.removeEventListener('touchcancel', handleTouchEnd);
    document.body.classList.remove('lyrics-dragging');
    endDrag();
  };

  return { handleMouseDown, handleTouchStart };
};
