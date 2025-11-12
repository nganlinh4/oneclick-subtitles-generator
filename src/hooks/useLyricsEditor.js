import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

// Debug logging gate (enable by setting localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };

export const useLyricsEditor = (initialLyrics, onUpdateLyrics) => {
  const { t } = useTranslation();
  const [lyrics, setLyrics] = useState([]);
  const [history, setHistory] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [checkpointHistory, setCheckpointHistory] = useState([]); // Stack of saved checkpoints
  const [originalLyrics, setOriginalLyrics] = useState([]);
  const [savedLyrics, setSavedLyrics] = useState([]);
  const [isAtOriginalState, setIsAtOriginalState] = useState(true);
  const [isAtSavedState, setIsAtSavedState] = useState(true);
  const [isSticky, setIsSticky] = useState(true);

  const dragInfo = useRef({
    dragging: false,
    index: null,
    field: null,
    startX: 0,
    startValue: 0,
    lastDragEnd: 0
  });

  // Sync with incoming lyrics
  useEffect(() => {
    if (initialLyrics && initialLyrics.length > 0) {
      setLyrics(initialLyrics);
      if (originalLyrics.length === 0) {
        setOriginalLyrics(JSON.parse(JSON.stringify(initialLyrics)));
      }
      if (savedLyrics.length === 0) {
        setSavedLyrics(JSON.parse(JSON.stringify(initialLyrics)));
      }
      setIsAtOriginalState(JSON.stringify(initialLyrics) === JSON.stringify(originalLyrics));
      setIsAtSavedState(JSON.stringify(initialLyrics) === JSON.stringify(savedLyrics));
    }
  }, [initialLyrics, originalLyrics, savedLyrics]);

  // Track whether current lyrics match original lyrics
  useEffect(() => {
    if (originalLyrics.length > 0) {
      const areEqual = lyrics.length === originalLyrics.length &&
        lyrics.every((lyric, index) => {
          const origLyric = originalLyrics[index];
          return (
            lyric.text === origLyric.text &&
            Math.abs(lyric.start - origLyric.start) < 0.001 &&
            Math.abs(lyric.end - origLyric.end) < 0.001
          );
        });

      setIsAtOriginalState(areEqual);
    }
  }, [lyrics, originalLyrics]);

  // Track whether current lyrics match saved lyrics
  useEffect(() => {
    if (savedLyrics.length > 0) {
      const areEqual = lyrics.length === savedLyrics.length &&
        lyrics.every((lyric, index) => {
          const savedLyric = savedLyrics[index];
          return (
            lyric.text === savedLyric.text &&
            Math.abs(lyric.start - savedLyric.start) < 0.001 &&
            Math.abs(lyric.end - savedLyric.end) < 0.001
          );
        });

      setIsAtSavedState(areEqual);
    }
  }, [lyrics, savedLyrics]);

  const handleUndo = () => {
    if (history.length > 0) {
      // Get the current state and the last history state
      const currentState = JSON.parse(JSON.stringify(lyrics));
      const lastState = history[history.length - 1];

      // Add current state to redo stack
      setRedoStack(prevRedoStack => [...prevRedoStack, currentState]);

      // Set lyrics to the last history state
      setLyrics(lastState);
      if (onUpdateLyrics) {
        onUpdateLyrics(lastState);
      }

      // Remove the last state from history
      setHistory(prevHistory => prevHistory.slice(0, -1));
    }
  };

  // Use useCallback to prevent handleRedo from changing on every render
  const handleRedo = useCallback(() => {
    if (redoStack.length > 0) {
      // Get the current state and the last redo state
      const currentState = JSON.parse(JSON.stringify(lyrics));
      const redoState = redoStack[redoStack.length - 1];

      // Add current state to history
      setHistory(prevHistory => [...prevHistory, currentState]);

      // Set lyrics to the redo state
      setLyrics(redoState);
      if (onUpdateLyrics) {
        onUpdateLyrics(redoState);
      }

      // Remove the last state from redo stack
      setRedoStack(prevRedoStack => prevRedoStack.slice(0, -1));
    }
  }, [redoStack, lyrics, onUpdateLyrics]);

  const handleReset = () => {
    if (savedLyrics.length > 0) {
      const currentState = JSON.parse(JSON.stringify(lyrics));
      const savedState = JSON.parse(JSON.stringify(savedLyrics));

      if (JSON.stringify(currentState) !== JSON.stringify(savedState)) {
        // Add current state to history
        setHistory(prevHistory => [...prevHistory, currentState]);

        // Clear redo stack when resetting
        setRedoStack([]);

        // Set lyrics to saved state instead of original state
        setLyrics(savedState);
        if (onUpdateLyrics) {
          onUpdateLyrics(savedState);
        }
      }
    }
  };

  // Keep track of the last updated value to avoid unnecessary updates
  const lastUpdatedValueRef = useRef({ index: -1, field: null, value: 0 });

  const updateTimings = (index, field, newValue, _duration) => {
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
  };

  const startDrag = (index, field, startX, startValue) => {
    setHistory(prevHistory => [...prevHistory, JSON.parse(JSON.stringify(lyrics))]);
    dragInfo.current = {
      dragging: true,
      index,
      field,
      startX,
      startValue
    };
  };

  // Throttle state to reduce updates
  const lastUpdateTimeRef = useRef(0);
  const pendingUpdateRef = useRef(null);

  const handleDrag = (clientX, duration) => {
    const { dragging, index, field, startX, startValue } = dragInfo.current;
    if (!dragging) return;

    // Calculate the new value
    const deltaX = clientX - startX;
    const deltaTime = deltaX * 0.01;
    let newValue = startValue + deltaTime;

    const lyric = lyrics[index];
    if (field === 'start') {
      // Only restrict start time to be non-negative
      newValue = Math.max(0, newValue);
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
  };

  const endDrag = () => {
    // Cancel any pending animation frame
    if (pendingUpdateRef.current) {
      cancelAnimationFrame(pendingUpdateRef.current);
      pendingUpdateRef.current = null;
    }

    // Record the time of the drag end
    dragInfo.current.lastDragEnd = Date.now();

    // Reset drag state
    dragInfo.current = {
      ...dragInfo.current,
      dragging: false,
      index: null,
      field: null,
      startX: 0,
      startValue: 0
    };

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
  };

  const isDragging = (index, field) =>
    dragInfo.current.dragging &&
    dragInfo.current.index === index &&
    dragInfo.current.field === field;

  const getLastDragEnd = () => dragInfo.current.lastDragEnd;

  // Helper function to show translation warning
  const showTranslationWarning = (message) => {
    try {
      // Check if there are actual translations available
      // Use the same logic as the subtitle language selector
      const hasTranslation = window.translatedSubtitles &&
                            Array.isArray(window.translatedSubtitles) &&
                            window.translatedSubtitles.length > 0;

      if (hasTranslation) {
        // Show a warning toast that translations may be outdated
        const warningEvent = new CustomEvent('translation-warning', {
          detail: { message }
        });
        window.dispatchEvent(warningEvent);
      }
    } catch (error) {
      console.error('Error checking for translations:', error);
    }
  };

  const handleDeleteLyric = (index) => {
    setHistory(prevHistory => [...prevHistory, JSON.parse(JSON.stringify(lyrics))]);
    const updatedLyrics = lyrics.filter((_, i) => i !== index);
    setLyrics(updatedLyrics);
    if (onUpdateLyrics) {
      onUpdateLyrics(updatedLyrics);
    }

    // Show warning about translations
    showTranslationWarning(t('translation.warningDeleted', 'You have deleted a subtitle. Translations may be outdated. Please translate again.'));
  };

  const handleTextEdit = (index, newText) => {
    setHistory(prevHistory => [...prevHistory, JSON.parse(JSON.stringify(lyrics))]);
    const updatedLyrics = lyrics.map((lyric, i) =>
      i === index ? { ...lyric, text: newText } : lyric
    );
    setLyrics(updatedLyrics);
    if (onUpdateLyrics) {
      onUpdateLyrics(updatedLyrics);
    }

    // Show warning about translations
    showTranslationWarning(t('translation.warningEdited', 'You have edited the text of original subtitles. Translations may be outdated. Please translate again.'));
  };

  const handleInsertLyric = (index) => {
    setHistory(prevHistory => [...prevHistory, JSON.parse(JSON.stringify(lyrics))]);

    // Handle special case: creating the very first lyric when list is empty
    if (lyrics.length === 0) {
      const newLyric = { text: '', start: 0, end: 2.0 };
      const updatedLyrics = [newLyric];
      setLyrics(updatedLyrics);
      if (onUpdateLyrics) {
        onUpdateLyrics(updatedLyrics);
      }
      // Show warning about translations
      showTranslationWarning(t('translation.warningInserted', 'You have inserted a new subtitle. Translations may be outdated. Please translate again.'));
      return;
    }

    // Handle special case: inserting at the beginning (before the first lyric)
    if (index < 0 || (index === 0 && lyrics.length > 0)) {
      const firstLyric = lyrics[0];
      // Create a new lyric before the first one
      const newStartTime = Math.max(0, firstLyric.start - 2.0); // 2 seconds before first lyric, but not negative
      const newEndTime = firstLyric.start;

      const newLyric = {
        text: '',
        start: newStartTime,
        end: newEndTime
      };

      const updatedLyrics = [newLyric, ...lyrics];

      setLyrics(updatedLyrics);
      if (onUpdateLyrics) {
        onUpdateLyrics(updatedLyrics);
      }

      // Show warning about translations
      showTranslationWarning(t('translation.warningInserted', 'You have inserted a new subtitle. Translations may be outdated. Please translate again.'));
      return;
    }

    const prevLyric = lyrics[index];
    const nextLyric = lyrics[index + 1];

    // Handle case when inserting after the last lyric
    if (!nextLyric) {
      // Create a new lyric after the last one
      const newStartTime = prevLyric.end;
      const newEndTime = prevLyric.end + 2.0; // Add 2 seconds for the new lyric

      const newLyric = {
        text: '',
        start: newStartTime,
        end: newEndTime
      };

      const updatedLyrics = [...lyrics, newLyric];

      setLyrics(updatedLyrics);
      if (onUpdateLyrics) {
        onUpdateLyrics(updatedLyrics);
      }

      // Show warning about translations
      showTranslationWarning(t('translation.warningInserted', 'You have inserted a new subtitle. Translations may be outdated. Please translate again.'));
      return;
    }

    // For cases when there is a next lyric
    // Calculate the gap between the two lyrics
    const gap = nextLyric.start - prevLyric.end;

    // If the gap is too small (less than 0.2s), expand it by moving the next lyric
    const minGap = 0.2;
    let newStartTime = prevLyric.end;
    let newEndTime = nextLyric.start;

    if (gap < minGap) {
      // Move the next lyric to create minimum gap
      const lengthToAdd = minGap - gap;
      newEndTime = nextLyric.start + lengthToAdd;

      // Update all following lyrics to maintain gaps
      const updatedLyrics = lyrics.map((lyric, i) => {
        if (i <= index) return lyric;
        return {
          ...lyric,
          start: lyric.start + lengthToAdd,
          end: lyric.end + lengthToAdd
        };
      });

      const newLyric = {
        text: '',
        start: newStartTime,
        end: newEndTime - minGap
      };

      const finalLyrics = [
        ...updatedLyrics.slice(0, index + 1),
        newLyric,
        ...updatedLyrics.slice(index + 1)
      ];

      setLyrics(finalLyrics);
      if (onUpdateLyrics) {
        onUpdateLyrics(finalLyrics);
      }

      // Show warning about translations
      showTranslationWarning(t('translation.warningInserted', 'You have inserted a new subtitle. Translations may be outdated. Please translate again.'));
    } else {
      // If gap is large enough, insert in the middle
      const midPoint = prevLyric.end + gap / 2;
      const newLyric = {
        text: '',
        start: prevLyric.end,
        end: midPoint + (gap / 4) // Give the new lyric 75% of the first half of the gap
      };

      const updatedLyrics = [
        ...lyrics.slice(0, index + 1),
        newLyric,
        ...lyrics.slice(index + 1)
      ];

      setLyrics(updatedLyrics);
      if (onUpdateLyrics) {
        onUpdateLyrics(updatedLyrics);
      }

      // Show warning about translations
      showTranslationWarning(t('translation.warningInserted', 'You have inserted a new subtitle. Translations may be outdated. Please translate again.'));
    }
  };

  // Merge the current lyric with the next one
  const handleMergeLyrics = (index) => {
    // Make sure there's a next lyric to merge with
    if (index >= lyrics.length - 1) return;

    // Save current state to history
    setHistory(prevHistory => [...prevHistory, JSON.parse(JSON.stringify(lyrics))]);

    const currentLyric = lyrics[index];
    const nextLyric = lyrics[index + 1];

    // Create a new merged lyric
    const mergedLyric = {
      id: currentLyric.id,
      text: `${currentLyric.text} ${nextLyric.text}`.trim(),
      start: currentLyric.start,
      end: nextLyric.end
    };

    // Create updated lyrics array with the merged lyric
    const updatedLyrics = [
      ...lyrics.slice(0, index),
      mergedLyric,
      ...lyrics.slice(index + 2)
    ];

    // Update state
    setLyrics(updatedLyrics);
    if (onUpdateLyrics) {
      onUpdateLyrics(updatedLyrics);
    }

    // Show warning about translations
    showTranslationWarning(t('translation.warningMerged', 'You have merged subtitles. Translations may be outdated. Please translate again.'));
  };

  // Handle smart subtitle splitting
  const handleSplitSubtitles = (newLyrics) => {
    // Save current state to history for undo functionality
    setHistory(prevHistory => [...prevHistory, JSON.parse(JSON.stringify(lyrics))]);

    // Clear redo stack since we're making a new change
    setRedoStack([]);

    // Update lyrics with the split subtitles
    setLyrics(newLyrics);
    if (onUpdateLyrics) {
      onUpdateLyrics(newLyrics);
    }

    // Show warning about translations
    showTranslationWarning(t('translation.warningSplit', 'You have split subtitles. Translations may be outdated. Please translate again.'));
  };

  // Clear all subtitles fully inside a time range [start, end]
  const clearSubtitlesInRange = (start, end) => {
    if (start == null || end == null || end <= start) return;
    setHistory(prevHistory => [...prevHistory, JSON.parse(JSON.stringify(lyrics))]);
    setRedoStack([]);
    // Remove subtitles fully contained within the range
    const updated = lyrics.filter(l => !(l.start >= start && l.end <= end));
    setLyrics(updated);
    onUpdateLyrics && onUpdateLyrics(updated);

    // Notify timing change
    window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
      detail: { action: 'clear-range', start, end, updatedLyrics: updated }
    }));
    // Translation warning
    showTranslationWarning(t('translation.warningDeleted', 'You have deleted a subtitle. Translations may be outdated. Please translate again.'));
  };

  // Move all subtitles fully inside a time range by delta seconds (apply immediately)
  const moveSubtitlesInRange = (start, end, delta) => {
    if (start == null || end == null || end <= start || !delta) return;
    setHistory(prevHistory => [...prevHistory, JSON.parse(JSON.stringify(lyrics))]);
    setRedoStack([]);
    const updated = lyrics.map(l => {
      if (l.start >= start && l.end <= end) {
        const newStart = Math.max(0, l.start + delta);
        const newEnd = Math.max(newStart + 0.1, l.end + delta);
        return { ...l, start: newStart, end: newEnd };
      }
      return l;
    });
    setLyrics(updated);
    onUpdateLyrics && onUpdateLyrics(updated);

    window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
      detail: { action: 'move-range', start, end, delta, updatedLyrics: updated }
    }));
  };

  // Live range move preview with baseline
  const movingRangeRef = useRef({ active: false, start: 0, end: 0, baseline: null });

  const beginRangeMove = (start, end) => {
    if (start == null || end == null || end <= start) return;
    movingRangeRef.current = {
      active: true,
      start,
      end,
      baseline: JSON.parse(JSON.stringify(lyrics))
    };
  };

  const previewRangeMove = (delta) => {
    const state = movingRangeRef.current;
    if (!state.active || state.baseline == null) return;
    const { start, end, baseline } = state;
    const updated = baseline.map(l => {
      if (l.start >= start && l.end <= end) {
        const newStart = Math.max(0, l.start + delta);
        const newEnd = Math.max(newStart + 0.1, l.end + delta);
        return { ...l, start: newStart, end: newEnd };
      }
      return l;
    });
    setLyrics(updated);
    onUpdateLyrics && onUpdateLyrics(updated);
  };

  const commitRangeMove = () => {
    const state = movingRangeRef.current;
    if (!state.active) return;
    // Push baseline to history to allow undo
    setHistory(prevHistory => [...prevHistory, state.baseline]);
    setRedoStack([]);
    movingRangeRef.current = { active: false, start: 0, end: 0, baseline: null };

    // Notify timing change (generic)
    window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
      detail: { action: 'move-range-commit', timestamp: Date.now() }
    }));
  };

  const cancelRangeMove = () => {
    const state = movingRangeRef.current;
    if (!state.active) return;
    // Revert to baseline
    if (state.baseline) {
      setLyrics(state.baseline);
      onUpdateLyrics && onUpdateLyrics(state.baseline);
    }
    movingRangeRef.current = { active: false, start: 0, end: 0, baseline: null };
  };

  // Add event listener for redo action
  useEffect(() => {
    const handleRedoEvent = () => {
      handleRedo();
    };

    window.addEventListener('redo-action', handleRedoEvent);

    return () => {
      window.removeEventListener('redo-action', handleRedoEvent);
    };
  }, [handleRedo]);

  // Add event listener for translation reset to clear window.translatedSubtitles
  useEffect(() => {
    const handleTranslationReset = () => {
      // Clear the window.translatedSubtitles when translations are reset
      if (window.translatedSubtitles) {
        window.translatedSubtitles = null;
        dbg('Cleared window.translatedSubtitles due to translation reset');
      }
    };

    window.addEventListener('translation-reset', handleTranslationReset);

    return () => {
      window.removeEventListener('translation-reset', handleTranslationReset);
    };
  }, []);

  // Function to update the saved lyrics state when the user saves the subtitles
  const updateSavedLyrics = () => {
    const currentState = JSON.parse(JSON.stringify(lyrics));
    setSavedLyrics(currentState);
    setIsAtSavedState(true);

    // Also create a checkpoint when saving
    createCheckpoint();
  };

  // Function to create a checkpoint (called when save happens)
  const createCheckpoint = () => {
    const currentState = JSON.parse(JSON.stringify(lyrics));
    // Limit checkpoint history to 10 entries to avoid memory issues
    setCheckpointHistory(prevCheckpoints => {
      const newCheckpoints = [...prevCheckpoints, currentState];
      if (newCheckpoints.length > 10) {
        return newCheckpoints.slice(-10); // Keep only the last 10 checkpoints
      }
      return newCheckpoints;
    });
    dbg('[LyricsEditor] Created checkpoint at save');
  };

  // Function to jump to previous checkpoints (cycles through checkpoint history)
  const handleJumpToCheckpoint = () => {
    if (checkpointHistory.length > 0) {
      const currentState = JSON.parse(JSON.stringify(lyrics));

      // Find the most recent checkpoint that differs from current state
      let targetCheckpointIndex = -1;
      for (let i = checkpointHistory.length - 1; i >= 0; i--) {
        const checkpoint = checkpointHistory[i];
        if (JSON.stringify(checkpoint) !== JSON.stringify(currentState)) {
          targetCheckpointIndex = i;
          break;
        }
      }

      // If no different checkpoint found, use the oldest one (index 0)
      if (targetCheckpointIndex === -1) {
        // If we're already at all checkpoints, jump to the oldest
        if (checkpointHistory.length > 1) {
          targetCheckpointIndex = 0;
        } else {
          dbg('[LyricsEditor] No different checkpoint available');
          return;
        }
      }

      const targetCheckpoint = checkpointHistory[targetCheckpointIndex];

      // Save current state to regular history for normal undo
      setHistory(prevHistory => [...prevHistory, currentState]);

      // Clear redo stack
      setRedoStack([]);

      // Jump to the checkpoint
      setLyrics(targetCheckpoint);
      if (onUpdateLyrics) {
        onUpdateLyrics(targetCheckpoint);
      }

      // Remove all checkpoints after the one we jumped to (keep earlier ones)
      setCheckpointHistory(prevCheckpoints => prevCheckpoints.slice(0, targetCheckpointIndex));

      dbg(`[LyricsEditor] Jumped to checkpoint ${targetCheckpointIndex + 1} of ${checkpointHistory.length}`);
    }
  };

  // Function to capture state before merging operations for undo/redo
  const captureStateBeforeMerge = () => {
    const currentState = JSON.parse(JSON.stringify(lyrics));
    setHistory(prevHistory => [...prevHistory, currentState]);
    // Clear redo stack since we're making a new change
    setRedoStack([]);
    dbg('[LyricsEditor] Captured state before merge operation for undo/redo');
  };

  return {
    lyrics,
    isSticky,
    setIsSticky,
    isAtOriginalState,
    isAtSavedState,
    canUndo: history.length > 0,
    canRedo: redoStack.length > 0,
    canJumpToCheckpoint: checkpointHistory.length > 0,
    handleUndo,
    handleRedo,
    handleReset,
    handleJumpToCheckpoint,
    startDrag,
    handleDrag,
    endDrag,
    isDragging,
    getLastDragEnd,
    handleDeleteLyric,
    handleTextEdit,
    handleInsertLyric,
    handleMergeLyrics,
    handleSplitSubtitles,
    clearSubtitlesInRange,
    moveSubtitlesInRange,
    beginRangeMove,
    previewRangeMove,
    commitRangeMove,
    cancelRangeMove,
    updateSavedLyrics,
    captureStateBeforeMerge,
    createCheckpoint
  };
};
