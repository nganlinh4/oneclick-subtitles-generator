import { useRef, useCallback } from 'react';
import { LYRICS_EDITOR_ACTIONS } from '../platform/durableLyricsHistory';

/**
 * Drag mechanics for the lyrics editor.
 *
 * Owns the drag interaction state (dragInfo ref), the throttling refs, and the
 * core `updateTimings` helper that applies a new timing value to the lyrics
 * array (optionally shifting subsequent lyrics when sticky mode is on).
 *
 * Closes over parent state via params so it can read the current lyrics and
 * push history / propagate updates.
 *
 * @param {Object}   params
 * @param {Array}    params.lyrics            Current lyrics array.
 * @param {Function} params.setLyrics         Setter for the lyrics array.
 * @param {Function} params.onUpdateLyrics    Callback invoked with updated lyrics.
 * @param {Function} params.commitLyricsMutation Commits one logical optimistic edit.
 * @param {boolean}  params.isSticky          Whether sticky (cascade) mode is on.
 */
export const useLyricsEditorDrag = ({
  lyrics,
  setLyrics,
  onUpdateLyrics,
  commitLyricsMutation,
  isSticky,
}) => {
  const dragInfo = useRef({
    dragging: false,
    index: null,
    field: null,
    startX: 0,
    startValue: 0,
    lastDragEnd: 0,
    baseline: null,
    latest: null,
  });

  // Keep track of the last updated value to avoid unnecessary updates
  const lastUpdatedValueRef = useRef({ index: -1, field: null, value: 0 });

  // Throttle state to reduce updates
  const lastUpdateTimeRef = useRef(0);
  const pendingUpdateRef = useRef(null);

  const updateTimings = useCallback((index, field, newValue, _duration) => {
    // Skip if the value hasn't changed significantly
    if (lastUpdatedValueRef.current.index === index &&
        lastUpdatedValueRef.current.field === field &&
        Math.abs(lastUpdatedValueRef.current.value - newValue) < 0.001) {
      return;
    }

    // Update the last updated value
    lastUpdatedValueRef.current = { index, field, value: newValue };

    const oldLyrics = [...lyrics];
    const currentLyric = oldLyrics[index]; // Avoid unnecessary spread
    const delta = newValue - currentLyric[field];

    if (Math.abs(delta) < 0.001) return;

    // Create a new array only if we're actually changing something
    const updatedLyrics = [];

    // Only process lyrics that need to be updated
    for (let i = 0; i < oldLyrics.length; i++) {
      const lyric = oldLyrics[i];

      if (i === index) {
        // Update the current lyric
        if (field === 'start') {
          if (isSticky) {
            // When sticky mode is on, maintain the duration by adjusting the end time
            const length = lyric.end - lyric.start;
            updatedLyrics.push({
              ...lyric,
              start: newValue,
              end: newValue + length
            });
          } else {
            // When sticky mode is off, only adjust the start time
            updatedLyrics.push({
              ...lyric,
              start: newValue
            });
          }
        } else {
          updatedLyrics.push({ ...lyric, [field]: newValue });
        }
      } else if (i > index && isSticky) {
        // Update subsequent lyrics if sticky mode is on
        const newStart = Math.max(0, lyric.start + delta);
        updatedLyrics.push({
          ...lyric,
          start: newStart,
          end: Math.max(newStart + 0.1, lyric.end + delta)
        });
      } else {
        // Keep unchanged lyrics as-is (no spread needed)
        updatedLyrics.push(lyric);
      }
    }

    setLyrics(updatedLyrics);
    dragInfo.current.latest = updatedLyrics;
    if (onUpdateLyrics) {
      onUpdateLyrics(updatedLyrics);
    }

    // Dispatch a custom event to notify that subtitle timings have changed
    // This is used by the aligned narration component to auto-regenerate
    window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
      detail: {
        index,
        field,
        newValue,
        updatedLyrics
      }
    }));
  }, [lyrics, setLyrics, onUpdateLyrics, isSticky]);

  const startDrag = useCallback((index, field, startX, startValue) => {
    const baseline = JSON.parse(JSON.stringify(lyrics));
    dragInfo.current = {
      dragging: true,
      index,
      field,
      startX,
      startValue,
      lastDragEnd: dragInfo.current.lastDragEnd,
      baseline,
      latest: baseline,
    };
  }, [lyrics]);

  const handleDrag = useCallback((clientX, duration) => {
    const { dragging, index, field, startX, startValue } = dragInfo.current;
    if (!dragging) return;

    // Calculate the new value
    const deltaX = clientX - startX;
    const deltaTime = deltaX * 0.01;
    let newValue = startValue + deltaTime;

    const lyric = lyrics[index];
    if (field === 'start') {
      newValue = Math.max(0, newValue);
      if (!isSticky) newValue = Math.min(lyric.end - 0.1, newValue);
    } else {
      // For end time, ensure it's after the start time and within duration
      newValue = Math.max(lyric.start + 0.1, Math.min(duration || 9999, newValue));
    }

    newValue = Math.round(newValue * 100) / 100;

    // Throttle updates to reduce rendering
    const now = performance.now();
    if (now - lastUpdateTimeRef.current < 30) { // Limit to ~33fps
      // If we already have a pending update, cancel it
      if (pendingUpdateRef.current) {
        cancelAnimationFrame(pendingUpdateRef.current);
      }

      // Schedule a new update
      pendingUpdateRef.current = requestAnimationFrame(() => {
        updateTimings(index, field, newValue, duration);
        pendingUpdateRef.current = null;
      });
      return;
    }

    // Update immediately if enough time has passed
    lastUpdateTimeRef.current = now;
    updateTimings(index, field, newValue, duration);
  }, [isSticky, lyrics, updateTimings]);

  const endDrag = useCallback(() => {
    // Cancel any pending animation frame
    if (pendingUpdateRef.current) {
      cancelAnimationFrame(pendingUpdateRef.current);
      pendingUpdateRef.current = null;
    }

    const baseline = dragInfo.current.baseline;
    const latest = dragInfo.current.latest;

    // Record the time of the drag end
    dragInfo.current.lastDragEnd = Date.now();

    // Reset drag state
    dragInfo.current = {
      ...dragInfo.current,
      dragging: false,
      index: null,
      field: null,
      startX: 0,
      startValue: 0,
      baseline: null,
      latest: null,
    };

    if (baseline !== null && latest !== null) {
      commitLyricsMutation(latest, LYRICS_EDITOR_ACTIONS.TIMING_DRAG, {
        baseline,
        alreadyApplied: true,
      });
    }

    // Reset the last updated value reference
    lastUpdatedValueRef.current = { index: -1, field: null, value: 0 };

    // Dispatch a custom event to notify that subtitle timings have changed
    // This is especially important after a drag operation completes
    window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
      detail: {
        action: 'drag-end',
        timestamp: Date.now()
      }
    }));
  }, [commitLyricsMutation]);

  const isDragging = useCallback((index, field) =>
    dragInfo.current.dragging &&
    dragInfo.current.index === index &&
    dragInfo.current.field === field, []);

  const getLastDragEnd = useCallback(() => dragInfo.current.lastDragEnd, []);

  return {
    startDrag,
    handleDrag,
    endDrag,
    isDragging,
    getLastDragEnd
  };
};
