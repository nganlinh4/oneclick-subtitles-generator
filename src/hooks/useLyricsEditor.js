import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { v7 as uuidv7 } from 'uuid';
import { useLyricsEditorDrag } from './useLyricsEditorDrag';
import { useLyricsEditorHistory } from './useLyricsEditorHistory';
import { useLyricsEditorHelpers } from './useLyricsEditorHelpers';
import { LYRICS_EDITOR_ACTIONS } from '../platform/durableLyricsHistory';
import { regroupWordsOffline, regroupPreservingEdits } from '../platform/localCaptionRegrouping';

/**
 * Lyrics editor hook. Orchestrates the editor's core state and composes the
 * drag, history, and helper sub-hooks. The returned object is the stable public
 * API consumed across the app — keep its shape identical when refactoring.
 */
export const useLyricsEditor = (initialLyrics, onUpdateLyrics, { hasTranslation = false } = {}) => {
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

  // handleDeleteLyric/handleTextEdit/handleInsertLyric/handleMergeLyrics below reach LyricItem
  // rows as the onDelete/onTextEdit/onInsert/onMerge props, and LyricItem is wrapped in a
  // React.memo comparator that skips a row's re-render for most prop changes (see LyricItem.js).
  // A row that hasn't independently re-rendered keeps whatever version of these handlers it last
  // mounted with; if that version closed over `lyrics` by value, clicking e.g. delete on that row
  // would filter a stale snapshot and silently discard any edit made elsewhere since. Reading the
  // live array through this ref instead -- same shape as the `dragInfo`/`isStickyRef` pattern in
  // useLyricsEditorDrag -- makes the mutation correct regardless of which closure vintage fired it.
  const lyricsRef = useRef(lyrics);
  lyricsRef.current = lyrics;

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
    hasTranslation,
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
    if (Array.isArray(initialLyrics)) {
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
    const updatedLyrics = lyricsRef.current.filter((_, i) => i !== index);
    commitLyricsMutation(updatedLyrics, LYRICS_EDITOR_ACTIONS.DELETE);

    // Show warning about translations
    showTranslationWarning(t('translation.warningDeleted', 'You have deleted a subtitle. Translations may be outdated. Please translate again.'));
  };

  const handleTextEdit = (index, newText) => {
    const updatedLyrics = lyricsRef.current.map((lyric, i) =>
      i === index
        ? {
            ...lyric,
            text: newText,
            userEdited: true,
            manual_state: 'edited_text',
            alignment_status: 'Modified',
          }
        : lyric
    );
    commitLyricsMutation(updatedLyrics, LYRICS_EDITOR_ACTIONS.TEXT);

    // Show warning about translations
    showTranslationWarning(t('translation.warningEdited', 'You have edited the text of original subtitles. Translations may be outdated. Please translate again.'));
  };

  // `insertionIndex` identifies a gap, not a row: 0 is before the first row and
  // lyrics.length is after the last row. This keeps every above/below action distinct.
  const handleInsertLyric = (insertionIndex) => {
    // Read the live array (not the closed-over `lyrics` state variable): see the lyricsRef comment
    // above the ref declaration for why. This shadows `lyrics` for the rest of the function on
    // purpose, so every reference below already resolves to the fresh snapshot.
    const lyrics = lyricsRef.current;
    if (!Number.isSafeInteger(insertionIndex)
        || insertionIndex < 0
        || insertionIndex > lyrics.length) return;

    // Handle special case: creating the very first lyric when list is empty
    if (lyrics.length === 0) {
      const newLyric = { id: uuidv7(), text: '', start: 0, end: 2.0 };
      const updatedLyrics = [newLyric];
      commitLyricsMutation(updatedLyrics, LYRICS_EDITOR_ACTIONS.INSERT);
      // Show warning about translations
      showTranslationWarning(t('translation.warningInserted', 'You have inserted a new subtitle. Translations may be outdated. Please translate again.'));
      return;
    }

    // Handle special case: inserting at the beginning (before the first lyric)
    if (insertionIndex === 0) {
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
        id: uuidv7(),
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

    const prevLyric = lyrics[insertionIndex - 1];
    const nextLyric = lyrics[insertionIndex];

    // Handle case when inserting after the last lyric
    if (!nextLyric) {
      // Create a new lyric after the last one
      const newStartTime = prevLyric.end;
      const newEndTime = prevLyric.end + 2.0; // Add 2 seconds for the new lyric

      const newLyric = {
        id: uuidv7(),
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
        if (i < insertionIndex) return lyric;
        return {
          ...lyric,
          start: lyric.start + lengthToAdd,
          end: lyric.end + lengthToAdd
        };
      });

      const newLyric = {
        id: uuidv7(),
        text: '',
        start: newStartTime,
        end: newEndTime
      };

      const finalLyrics = [
        ...updatedLyrics.slice(0, insertionIndex),
        newLyric,
        ...updatedLyrics.slice(insertionIndex)
      ];

      commitLyricsMutation(finalLyrics, LYRICS_EDITOR_ACTIONS.INSERT);

      // Show warning about translations
      showTranslationWarning(t('translation.warningInserted', 'You have inserted a new subtitle. Translations may be outdated. Please translate again.'));
    } else {
      // If gap is large enough, insert in the middle
      const midPoint = prevLyric.end + gap / 2;
      const newLyric = {
        id: uuidv7(),
        text: '',
        start: prevLyric.end,
        end: midPoint + (gap / 4) // Give the new lyric 75% of the first half of the gap
      };

      const updatedLyrics = [
        ...lyrics.slice(0, insertionIndex),
        newLyric,
        ...lyrics.slice(insertionIndex)
      ];

      commitLyricsMutation(updatedLyrics, LYRICS_EDITOR_ACTIONS.INSERT);

      // Show warning about translations
      showTranslationWarning(t('translation.warningInserted', 'You have inserted a new subtitle. Translations may be outdated. Please translate again.'));
    }
  };

  // Merge the current lyric with the next one
  const handleMergeLyrics = (index) => {
    // See the lyricsRef comment above: read the live array, not the closed-over state variable.
    const lyrics = lyricsRef.current;
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

  // Offline zero-provider regrouping (F17). Undoable.
  const handleRegroup = (policy, options = {}, preserveManualEdits = true) => {
    const current = lyricsRef.current;
    if (!current || current.length === 0) return;

    const words = options.words || current.words || deriveWordsFromCues(current);
    const customOpts = {
      max_words: options.maxWords ?? options.max_words,
      max_duration_ms: (options.maxDuration ?? options.max_duration ?? 5.0) * 1000,
      pause_threshold_ms: options.pauseThreshold ?? options.pause_threshold_ms ?? 300,
      split_on_punctuation: options.splitOnPunctuation ?? options.split_on_punctuation ?? true,
    };

    const newLyrics = preserveManualEdits
      ? regroupPreservingEdits(words, current, policy, customOpts)
      : regroupWordsOffline(words, policy, customOpts);

    if (current.words) newLyrics.words = current.words;
    if (current.turns) newLyrics.turns = current.turns;
    if (current.revisionId) newLyrics.revisionId = current.revisionId;

    commitLyricsMutation(newLyrics, LYRICS_EDITOR_ACTIONS.REGROUP);
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
    handleRegroup,
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

function deriveWordsFromCues(cues) {
  if (Array.isArray(cues.words) && cues.words.length > 0) {
    return cues.words;
  }
  const words = [];
  for (const cue of cues) {
    if (Array.isArray(cue.words) && cue.words.length > 0) {
      words.push(...cue.words);
      continue;
    }
    const cueStartMs = cue.start_ms ?? Math.round((cue.start || 0) * 1000);
    const cueEndMs = cue.end_ms ?? Math.round((cue.end || 0) * 1000);
    const cueDuration = Math.max(10, cueEndMs - cueStartMs);
    const tokens = (cue.text || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const tokenDuration = Math.round(cueDuration / tokens.length);
    for (let i = 0; i < tokens.length; i++) {
      const startMs = cueStartMs + i * tokenDuration;
      const endMs = i === tokens.length - 1 ? cueEndMs : startMs + tokenDuration;
      words.push({
        id: cue.word_ids?.[i] || `${cue.id || 'cue'}_w${i + 1}`,
        text: tokens[i],
        start_ms: startMs,
        end_ms: endMs,
        speaker_id: cue.speaker || cue.speaker_id || null,
        provenance: 'Provider',
        alignment_status: 'Aligned',
      });
    }
  }
  return words;
}
