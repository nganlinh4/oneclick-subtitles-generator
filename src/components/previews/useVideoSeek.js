import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/**
 * Owns timeline seek-dragging (mouse + touch), volume-slider dragging, and the
 * mobile "tap outside to collapse the volume slider" behaviour. Media writes
 * are delegated to the central seek coordinator; lyric/timeline commands are
 * not inferred from the published playhead here.
 *
 * Returns { isDragging, setIsDragging, dragTime, setDragTime, dragTimeRef,
 *           isVolumeSliderVisible, setIsVolumeSliderVisible,
 *           isVolumeDragging, setIsVolumeDragging,
 *           handleTimelineMouseDown, handleTimelineTouchStart }.
 */
const useVideoSeek = ({
  videoRef,
  videoDuration,
  sourceKey = null,
  seekTo,
  setVolume,
  setIsMuted,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [dragTime, setDragTime] = useState(0);
  const dragTimeRef = useRef(0);
  const [isVolumeSliderVisible, setIsVolumeSliderVisible] = useState(false);
  const [isVolumeDragging, setIsVolumeDragging] = useState(false);
  const activeTimelineDragRef = useRef(null);
  const latestSourceKeyRef = useRef(sourceKey);
  latestSourceKeyRef.current = sourceKey;

  const cancelTimelineDrag = useCallback((resetState = true) => {
    const drag = activeTimelineDragRef.current;
    if (drag === null) return;

    activeTimelineDragRef.current = null;
    drag.detach();
    if (resetState) setIsDragging(false);
  }, []);

  const dragStillOwnsMedia = useCallback((drag) => (
    activeTimelineDragRef.current === drag
    && videoRef.current === drag.video
    && Object.is(latestSourceKeyRef.current, drag.sourceKey)
  ), [videoRef]);

  // A drag belongs to the exact logical source and video element that began it. A source change
  // cancels before paint; unmount removes the document listeners without trying to update state.
  useLayoutEffect(() => {
    cancelTimelineDrag();
  }, [cancelTimelineDrag, sourceKey]);

  useEffect(() => () => {
    cancelTimelineDrag(false);
  }, [cancelTimelineDrag]);

  const handleTimelineMouseDown = useCallback((e) => {
    const video = videoRef.current;
    if (!video || videoDuration === 0) return;

    // Only one timeline gesture may own the document listeners. Starting another gesture cancels
    // the first without applying its partial time.
    cancelTimelineDrag();

    // Store the timeline container reference for consistent dragging
    const timelineContainer = e.currentTarget;
    const rect = timelineContainer.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const newTime = Math.max(0, Math.min((clickX / rect.width) * videoDuration, videoDuration));

    // Set initial drag state
    setIsDragging(true);
    setDragTime(newTime);
    dragTimeRef.current = newTime;

    const drag = {
      detach: () => {},
      sourceKey,
      time: newTime,
      video,
    };

    const handleMouseMove = (moveEvent) => {
      if (!dragStillOwnsMedia(drag)) {
        if (activeTimelineDragRef.current === drag) cancelTimelineDrag();
        return;
      }
      // Use the stored timeline container reference instead of searching for it
      const rect = timelineContainer.getBoundingClientRect();
      const clickX = moveEvent.clientX - rect.left;
      const movedTime = Math.max(0, Math.min((clickX / rect.width) * videoDuration, videoDuration));
      drag.time = movedTime;
      setDragTime(movedTime);
      dragTimeRef.current = movedTime;
    };

    const handleMouseUp = () => {
      if (!dragStillOwnsMedia(drag)) {
        if (activeTimelineDragRef.current === drag) cancelTimelineDrag();
        return;
      }

      // Always apply the final time, whether moved or just clicked
      const finalTime = drag.time;
      cancelTimelineDrag();
      seekTo(finalTime, { reason: 'timeline-pointer' });
    };

    drag.detach = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
    activeTimelineDragRef.current = drag;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [cancelTimelineDrag, dragStillOwnsMedia, sourceKey, videoDuration, videoRef, seekTo]);

  // Touch support for timeline
  const handleTimelineTouchStart = useCallback((e) => {
    const video = videoRef.current;
    if (!video || videoDuration === 0 || !e.touches[0]) return;

    e.preventDefault();
    cancelTimelineDrag();
    // Store the timeline container reference for consistent dragging
    const timelineContainer = e.currentTarget;
    const rect = timelineContainer.getBoundingClientRect();
    const touch = e.touches[0];
    const touchX = touch.clientX - rect.left;
    const newTime = Math.max(0, Math.min((touchX / rect.width) * videoDuration, videoDuration));

    // Set initial drag state
    setIsDragging(true);
    setDragTime(newTime);
    dragTimeRef.current = newTime;

    const drag = {
      detach: () => {},
      sourceKey,
      time: newTime,
      video,
    };

    const handleTouchMove = (moveEvent) => {
      moveEvent.preventDefault();
      if (!dragStillOwnsMedia(drag)) {
        if (activeTimelineDragRef.current === drag) cancelTimelineDrag();
        return;
      }
      // Use the stored timeline container reference instead of searching for it
      if (moveEvent.touches[0]) {
        const rect = timelineContainer.getBoundingClientRect();
        const touchX = moveEvent.touches[0].clientX - rect.left;
        const movedTime = Math.max(0, Math.min((touchX / rect.width) * videoDuration, videoDuration));
        drag.time = movedTime;
        setDragTime(movedTime);
        dragTimeRef.current = movedTime;
      }
    };

    const handleTouchEnd = () => {
      if (!dragStillOwnsMedia(drag)) {
        if (activeTimelineDragRef.current === drag) cancelTimelineDrag();
        return;
      }

      // Always apply the final time
      const finalTime = drag.time;
      cancelTimelineDrag();
      seekTo(finalTime, { reason: 'timeline-touch' });
    };

    const handleTouchCancel = () => {
      if (activeTimelineDragRef.current === drag) cancelTimelineDrag();
    };

    drag.detach = () => {
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
      document.removeEventListener('touchcancel', handleTouchCancel);
    };
    activeTimelineDragRef.current = drag;
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
    document.addEventListener('touchcancel', handleTouchCancel);
  }, [cancelTimelineDrag, dragStillOwnsMedia, sourceKey, videoDuration, videoRef, seekTo]);

  // Handle volume slider dragging
  useEffect(() => {
    if (!isVolumeDragging) return;

    const volumeSlider = document.querySelector('.expanding-volume-slider');

    const updateFromClientY = (clientY) => {
      if (!volumeSlider) return;
      const rect = volumeSlider.getBoundingClientRect();
      const newVolume = Math.max(0, Math.min(1, (rect.bottom - clientY) / rect.height));
      setVolume(newVolume);
      if (videoRef.current) {
        videoRef.current.volume = newVolume;
        videoRef.current.muted = newVolume === 0;
        setIsMuted(newVolume === 0);
      }
    };

    const handleMouseMove = (e) => {
      updateFromClientY(e.clientY);
    };

    const handleMouseUp = () => {
      setIsVolumeDragging(false);
    };

    const handleTouchMove = (e) => {
      // Prevent scrolling while dragging the volume slider
      e.preventDefault();
      const touch = e.touches && e.touches[0];
      if (touch) {
        updateFromClientY(touch.clientY);
      }
    };

    const handleTouchEnd = () => {
      setIsVolumeDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isVolumeDragging, videoRef, setVolume, setIsMuted]);

  // Mobile: keep volume slider expanded after touch until user taps outside
  useEffect(() => {
    const handleOutside = (e) => {
      if (!isVolumeSliderVisible) return;
      const wrapper = document.querySelector('.volume-pill-wrapper');
      if (wrapper && !wrapper.contains(e.target)) {
        setIsVolumeSliderVisible(false);
      }
    };

    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
    };
  }, [isVolumeSliderVisible, setIsVolumeSliderVisible]);

  return {
    isDragging,
    setIsDragging,
    dragTime,
    setDragTime,
    dragTimeRef,
    isVolumeSliderVisible,
    setIsVolumeSliderVisible,
    isVolumeDragging,
    setIsVolumeDragging,
    handleTimelineMouseDown,
    handleTimelineTouchStart,
  };
};

export default useVideoSeek;
