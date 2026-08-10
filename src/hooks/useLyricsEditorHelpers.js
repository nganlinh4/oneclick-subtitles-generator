import { useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { LYRICS_EDITOR_ACTIONS } from '../platform/durableLyricsHistory';

/**
 * Editing helpers for the lyrics editor: the translation-warning emitter and the
 * range-based operations (clear / move / live-preview move).
 *
 * `showTranslationWarning` is exposed so the orchestrating hook can reuse it for
 * delete/edit/insert/merge/split handlers. The range operations close over the
 * history setters so they can push undo state.
 *
 * @param {Object}   params
 * @param {Array}    params.lyrics           Current lyrics array.
 * @param {Function} params.setLyrics        Setter for the lyrics array.
 * @param {Function} params.onUpdateLyrics   Callback invoked with updated lyrics.
 * @param {Function} params.commitLyricsMutation Commits one logical optimistic edit.
 */
export const useLyricsEditorHelpers = ({
  lyrics,
  setLyrics,
  onUpdateLyrics,
  commitLyricsMutation,
}) => {
  const { t } = useTranslation();

  // Helper function to show translation warning
  const showTranslationWarning = useCallback((message) => {
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
  }, []);

  // Clear all subtitles fully inside a time range [start, end]
  const clearSubtitlesInRange = useCallback((start, end) => {
    if (start == null || end == null || end <= start) return;
    // Remove subtitles fully contained within the range
    const updated = lyrics.filter(l => !(l.start >= start && l.end <= end));
    commitLyricsMutation(updated, LYRICS_EDITOR_ACTIONS.CLEAR_RANGE);

    // Notify timing change
    window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
      detail: { action: 'clear-range', start, end, updatedLyrics: updated }
    }));
    // Translation warning
    showTranslationWarning(t('translation.warningDeleted', 'You have deleted a subtitle. Translations may be outdated. Please translate again.'));
  }, [lyrics, commitLyricsMutation, showTranslationWarning, t]);

  // Move all subtitles fully inside a time range by delta seconds (apply immediately)
  const moveSubtitlesInRange = useCallback((start, end, delta) => {
    if (start == null || end == null || end <= start || !delta) return;
    const updated = lyrics.map(l => {
      if (l.start >= start && l.end <= end) {
        const newStart = Math.max(0, l.start + delta);
        const newEnd = Math.max(newStart + 0.1, l.end + delta);
        return { ...l, start: newStart, end: newEnd };
      }
      return l;
    });
    commitLyricsMutation(updated, LYRICS_EDITOR_ACTIONS.MOVE_RANGE);

    window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
      detail: { action: 'move-range', start, end, delta, updatedLyrics: updated }
    }));
  }, [lyrics, commitLyricsMutation]);

  // Live range move preview with baseline
  const movingRangeRef = useRef({
    active: false,
    start: 0,
    end: 0,
    baseline: null,
    latest: null,
  });

  const beginRangeMove = useCallback((start, end) => {
    if (start == null || end == null || end <= start) return;
    movingRangeRef.current = {
      active: true,
      start,
      end,
      baseline: JSON.parse(JSON.stringify(lyrics)),
      latest: JSON.parse(JSON.stringify(lyrics)),
    };
  }, [lyrics]);

  const previewRangeMove = useCallback((delta) => {
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
    movingRangeRef.current.latest = updated;
    setLyrics(updated);
    onUpdateLyrics && onUpdateLyrics(updated);
  }, [setLyrics, onUpdateLyrics]);

  const commitRangeMove = useCallback(() => {
    const state = movingRangeRef.current;
    if (!state.active) return;
    commitLyricsMutation(
      state.latest,
      LYRICS_EDITOR_ACTIONS.MOVE_RANGE,
      { baseline: state.baseline, alreadyApplied: true }
    );
    movingRangeRef.current = {
      active: false,
      start: 0,
      end: 0,
      baseline: null,
      latest: null,
    };

    // Notify timing change (generic)
    window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
      detail: { action: 'move-range-commit', timestamp: Date.now() }
    }));
  }, [commitLyricsMutation]);

  const cancelRangeMove = useCallback(() => {
    const state = movingRangeRef.current;
    if (!state.active) return;
    // Revert to baseline
    if (state.baseline) {
      setLyrics(state.baseline);
      onUpdateLyrics && onUpdateLyrics(state.baseline);
    }
    movingRangeRef.current = {
      active: false,
      start: 0,
      end: 0,
      baseline: null,
      latest: null,
    };
  }, [setLyrics, onUpdateLyrics]);

  return {
    showTranslationWarning,
    clearSubtitlesInRange,
    moveSubtitlesInRange,
    beginRangeMove,
    previewRangeMove,
    commitRangeMove,
    cancelRangeMove
  };
};
