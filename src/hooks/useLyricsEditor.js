import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLyricsEditorDrag } from './useLyricsEditorDrag';
import { useLyricsEditorHistory } from './useLyricsEditorHistory';
import { useLyricsEditorHelpers } from './useLyricsEditorHelpers';
import { LYRICS_EDITOR_ACTIONS } from '../platform/durableLyricsHistory';

// Debug logging gate (enable by setting localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };

/**
 * Lyrics editor hook. Orchestrates the editor's core state and composes the
 * drag, history, and helper sub-hooks. The returned object is the stable public
 * API consumed across the app — keep its shape identical when refactoring.
 */
export const useLyricsEditor = (initialLyrics, onUpdateLyrics) => {
  const { t } = useTranslation();
  const [lyrics, setLyrics] = useState([]);
  const [originalLyrics, setOriginalLyrics] = useState([]);
  const [savedLyrics, setSavedLyrics] = useState([]);
  const [isAtOriginalState, setIsAtOriginalState] = useState(true);
  const [isAtSavedState, setIsAtSavedState] = useState(true);
  const [isSticky, setIsSticky] = useState(true);
  const initialLyricsRef = useRef(initialLyrics);
  const cacheBoundaryRowsRef = useRef(null);
  const awaitingCacheRowsRef = useRef(false);
  initialLyricsRef.current = initialLyrics;

  const handleCacheIdChange = useCallback(() => {
    // The parent subtitle hydration is asynchronous. Remember the old prop identity so the child
    // cannot repopulate media A's rows during the intervening reset render.
    cacheBoundaryRowsRef.current = initialLyricsRef.current;
    awaitingCacheRowsRef.current = true;
    setLyrics([]);
    setOriginalLyrics([]);
    setSavedLyrics([]);
    setIsAtOriginalState(true);
    setIsAtSavedState(true);
  }, []);

  // Undo / redo / checkpoint management (owns history + redo + checkpoint state)
  const {
    history,
    redoStack,
    checkpointHistory,
    durableCanUndo,
    durableCanRedo,
    handleUndo,
    handleRedo,
    handleReset,
    createCheckpoint,
    handleJumpToCheckpoint,
    captureStateBeforeMerge,
    observeExternalLyrics,
    commitLyricsMutation,
  } = useLyricsEditorHistory({
    lyrics,
    setLyrics,
    onUpdateLyrics,
    savedLyrics,
    onCacheIdChange: handleCacheIdChange,
  });

  // Drag mechanics (timing drag + sticky cascade)
  const {
    startDrag,
    handleDrag,
    endDrag,
    isDragging,
    getLastDragEnd
  } = useLyricsEditorDrag({
    lyrics,
    setLyrics,
    onUpdateLyrics,
    commitLyricsMutation,
    isSticky,
  });

  // Editing helpers (translation warning + range operations)
  const {
    showTranslationWarning,
    clearSubtitlesInRange,
    moveSubtitlesInRange,
    beginRangeMove,
    previewRangeMove,
    commitRangeMove,
    cancelRangeMove
  } = useLyricsEditorHelpers({
    lyrics,
    setLyrics,
    onUpdateLyrics,
    commitLyricsMutation,
  });

  // Sync with incoming lyrics
  useEffect(() => {
    if (awaitingCacheRowsRef.current) {
      if (initialLyrics === cacheBoundaryRowsRef.current) return;
      awaitingCacheRowsRef.current = false;
      cacheBoundaryRowsRef.current = null;
      const nextRows = Array.isArray(initialLyrics)
        ? JSON.parse(JSON.stringify(initialLyrics))
        : [];
      setLyrics(nextRows);
      setOriginalLyrics(JSON.parse(JSON.stringify(nextRows)));
      setSavedLyrics(JSON.parse(JSON.stringify(nextRows)));
      setIsAtOriginalState(true);
      setIsAtSavedState(true);
      return;
    }
    if (initialLyrics && initialLyrics.length > 0) {
      observeExternalLyrics(initialLyrics);
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
  }, [initialLyrics, observeExternalLyrics, originalLyrics, savedLyrics]);

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

  const handleDeleteLyric = (index) => {
    const updatedLyrics = lyrics.filter((_, i) => i !== index);
    commitLyricsMutation(updatedLyrics, LYRICS_EDITOR_ACTIONS.DELETE);

    // Show warning about translations
    showTranslationWarning(t('translation.warningDeleted', 'You have deleted a subtitle. Translations may be outdated. Please translate again.'));
  };

  const handleTextEdit = (index, newText) => {
    const updatedLyrics = lyrics.map((lyric, i) =>
      i === index ? { ...lyric, text: newText } : lyric
    );
    commitLyricsMutation(updatedLyrics, LYRICS_EDITOR_ACTIONS.TEXT);

    // Show warning about translations
    showTranslationWarning(t('translation.warningEdited', 'You have edited the text of original subtitles. Translations may be outdated. Please translate again.'));
  };

  const handleInsertLyric = (index) => {
    // Handle special case: creating the very first lyric when list is empty
    if (lyrics.length === 0) {
      const newLyric = { text: '', start: 0, end: 2.0 };
      const updatedLyrics = [newLyric];
      commitLyricsMutation(updatedLyrics, LYRICS_EDITOR_ACTIONS.INSERT);
      // Show warning about translations
      showTranslationWarning(t('translation.warningInserted', 'You have inserted a new subtitle. Translations may be outdated. Please translate again.'));
      return;
    }

    // Handle special case: inserting at the beginning (before the first lyric)
    if (index < 0 || (index === 0 && lyrics.length > 0)) {
      const firstLyric = lyrics[0];
      const minimumDuration = 0.2;
      const shift = Math.max(0, minimumDuration - firstLyric.start);
      const shiftedLyrics = shift === 0 ? lyrics : lyrics.map((lyric) => ({
        ...lyric,
        start: lyric.start + shift,
        end: lyric.end + shift,
      }));
      const newEndTime = shiftedLyrics[0].start;
      const newStartTime = Math.max(0, newEndTime - 2.0);

      const newLyric = {
        text: '',
        start: newStartTime,
        end: newEndTime
      };

      const updatedLyrics = [newLyric, ...shiftedLyrics];

      commitLyricsMutation(updatedLyrics, LYRICS_EDITOR_ACTIONS.INSERT);

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

      commitLyricsMutation(updatedLyrics, LYRICS_EDITOR_ACTIONS.INSERT);

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
      // Reserve one valid minimum-duration cue and move following cues just enough to fit it.
      newEndTime = newStartTime + minGap;
      const lengthToAdd = Math.max(0, newEndTime - nextLyric.start);

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
        end: newEndTime
      };

      const finalLyrics = [
        ...updatedLyrics.slice(0, index + 1),
        newLyric,
        ...updatedLyrics.slice(index + 1)
      ];

      commitLyricsMutation(finalLyrics, LYRICS_EDITOR_ACTIONS.INSERT);

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

      commitLyricsMutation(updatedLyrics, LYRICS_EDITOR_ACTIONS.INSERT);

      // Show warning about translations
      showTranslationWarning(t('translation.warningInserted', 'You have inserted a new subtitle. Translations may be outdated. Please translate again.'));
    }
  };

  // Merge the current lyric with the next one
  const handleMergeLyrics = (index) => {
    // Make sure there's a next lyric to merge with
    if (index >= lyrics.length - 1) return;

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

    commitLyricsMutation(updatedLyrics, LYRICS_EDITOR_ACTIONS.MERGE);

    // Show warning about translations
    showTranslationWarning(t('translation.warningMerged', 'You have merged subtitles. Translations may be outdated. Please translate again.'));
  };

  // Handle smart subtitle splitting
  const handleSplitSubtitles = (newLyrics) => {
    commitLyricsMutation(newLyrics, LYRICS_EDITOR_ACTIONS.SPLIT);

    // Show warning about translations
    showTranslationWarning(t('translation.warningSplit', 'You have split subtitles. Translations may be outdated. Please translate again.'));
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
  const updateSavedLyrics = useCallback(() => {
    const currentState = JSON.parse(JSON.stringify(lyrics));
    setSavedLyrics(currentState);
    setIsAtSavedState(true);

    // Also create a checkpoint when saving
    createCheckpoint();
  }, [lyrics, createCheckpoint]);

  // Bulk-apply new subtitle timings (used by the narration-lane smart arrange / drag). Undoable.
  const applyTimings = (newLyrics) => {
    if (!Array.isArray(newLyrics)) return;
    commitLyricsMutation(newLyrics, LYRICS_EDITOR_ACTIONS.APPLY_TIMINGS);
  };

  return {
    lyrics,
    isSticky,
    setIsSticky,
    isAtOriginalState,
    isAtSavedState,
    canUndo: history.length > 0 || durableCanUndo,
    canRedo: redoStack.length > 0 || durableCanRedo,
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
    createCheckpoint,
    applyTimings
  };
};
