import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createDurableLyricsHistory,
  LYRICS_EDITOR_ACTIONS,
  registerDurableLyricsHistoryFlusher,
} from '../platform/durableLyricsHistory';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import {
  subscribeCurrentCacheId,
  subscribeCurrentSubtitleProjectRefresh,
} from '../utils/userSubtitlesStore';
import {
  clone,
  pruneLyricsCheckpointHistory,
  pruneLyricsHistoryStacks,
  same,
} from './lyricsEditorHistoryState';

// A range move (and every other durable edit: text, insert, delete, merge, split, timing drag,
// clear range) applies optimistically in the UI before its native revision commits. When that
// native commit fails, the optimistic change is not actually durable -- without this toast the
// customer sees the edit "hold" on screen with nothing telling them it never saved, which is
// exactly the silent-failure class this project watches for. One dedupe key collapses a burst of
// rapid failures (e.g. a saturated history queue) into a single notice instead of a flood.
const EDIT_FAILED_TOAST_KEY = 'subtitle-edit-failed';
const notifyEditFailed = (message) => {
  try {
    window.addToast?.(message, 'error', 8_000, EDIT_FAILED_TOAST_KEY);
  } catch {
    // Notification failure cannot reverse the underlying commit failure.
  }
};

const EMPTY_DURABLE_STATUS = Object.freeze({ canUndo: false, canRedo: false });
const EXTERNAL_MERGE_QUIET_MS = 750;
const TEXT_EDIT_QUIET_MS = 500;

const pushBounded = (stack, value) => [...stack, value];

/**
 * Immediate editor history plus a serialized native revision mirror. The in-memory stacks keep
 * controls responsive; the native cursor is authoritative across restarts. Checkpoint membership
 * remains session-local, although a checkpoint jump itself is persisted as a normal revision.
 */
export const useLyricsEditorHistory = ({
  lyrics,
  setLyrics,
  onUpdateLyrics,
  savedLyrics,
  onCacheIdChange,
}) => {
  const { t } = useTranslation();
  const [history, setHistoryState] = useState([]);
  const [redoStack, setRedoStackState] = useState([]);
  const [checkpointHistory, setCheckpointHistoryState] = useState([]);
  const [durableStatus, setDurableStatus] = useState(EMPTY_DURABLE_STATUS);

  const lyricsRef = useRef(lyrics);
  const historyRef = useRef(history);
  const redoRef = useRef(redoStack);
  const checkpointRef = useRef(checkpointHistory);
  const durableStatusRef = useRef(durableStatus);
  const savedLyricsRef = useRef(savedLyrics);
  const callbacksRef = useRef({ setLyrics, onUpdateLyrics });
  const durableRef = useRef(null);
  const navigationPendingRef = useRef(false);
  const externalMergeRef = useRef(null);
  const pendingTextRef = useRef(null);
  const viewGenerationRef = useRef(0);
  // Read live from the durable-history effect's onError, which is created once (see below) and
  // must not tear down and rebuild the whole durable queue every time the locale changes.
  const tRef = useRef(t);

  lyricsRef.current = lyrics;
  savedLyricsRef.current = savedLyrics;
  callbacksRef.current = { setLyrics, onUpdateLyrics };
  tRef.current = t;

  const replaceLyrics = useCallback((rows) => {
    const copied = clone(rows);
    viewGenerationRef.current += 1;
    lyricsRef.current = copied;
    callbacksRef.current.setLyrics(copied);
    callbacksRef.current.onUpdateLyrics?.(copied);
  }, []);

  const applyStacks = useCallback((nextHistory, nextRedo) => {
    const bounded = pruneLyricsHistoryStacks(nextHistory, nextRedo);
    historyRef.current = bounded.history;
    redoRef.current = bounded.redo;
    setHistoryState(bounded.history);
    setRedoStackState(bounded.redo);
  }, []);

  const setHistory = useCallback((value) => {
    const next = typeof value === 'function' ? value(historyRef.current) : value;
    applyStacks(next, redoRef.current);
  }, [applyStacks]);

  const setRedoStack = useCallback((value) => {
    const next = typeof value === 'function' ? value(redoRef.current) : value;
    applyStacks(historyRef.current, next);
  }, [applyStacks]);

  const setCheckpointHistory = useCallback((value) => {
    const next = typeof value === 'function' ? value(checkpointRef.current) : value;
    const bounded = pruneLyricsCheckpointHistory(next);
    checkpointRef.current = bounded;
    setCheckpointHistoryState(bounded);
  }, []);

  const publishDurableStatus = useCallback((status) => {
    durableStatusRef.current = status;
    setDurableStatus(status);
  }, []);

  const finishPendingText = useCallback(() => {
    const pending = pendingTextRef.current;
    if (pending === null) return Promise.resolve();
    if (pending.timer !== null) window.clearTimeout(pending.timer);
    pendingTextRef.current = null;
    if (same(pending.baseline, pending.latest)) {
      setHistory(pending.historyBefore);
      setRedoStack(pending.redoBefore);
      return Promise.resolve();
    }
    return durableRef.current?.record(
      pending.baseline,
      pending.latest,
      LYRICS_EDITOR_ACTIONS.TEXT
    ) ?? Promise.resolve();
  }, [setHistory, setRedoStack]);

  const cancelPendingText = useCallback(() => {
    const pending = pendingTextRef.current;
    if (pending?.timer != null) window.clearTimeout(pending.timer);
    pendingTextRef.current = null;
  }, []);

  const cancelExternalMerge = useCallback(() => {
    const pending = externalMergeRef.current;
    if (pending?.timer != null) window.clearTimeout(pending.timer);
    externalMergeRef.current = null;
  }, []);

  const resetToAuthoritativeRows = useCallback((rows) => {
    cancelPendingText();
    cancelExternalMerge();
    setHistory([]);
    setRedoStack([]);
    replaceLyrics(rows);
  }, [
    cancelExternalMerge,
    cancelPendingText,
    replaceLyrics,
    setHistory,
    setRedoStack,
  ]);

  const finishExternalMerge = useCallback(() => {
    const pending = externalMergeRef.current;
    if (pending === null) return Promise.resolve();
    if (pending.timer !== null) window.clearTimeout(pending.timer);
    externalMergeRef.current = null;
    if (pending.latest !== null && !same(pending.baseline, pending.latest)) {
      return durableRef.current?.record(
        pending.baseline,
        pending.latest,
        LYRICS_EDITOR_ACTIONS.EXTERNAL_MERGE
      ) ?? Promise.resolve();
    }
    if (pending.captured) {
      setHistory(pending.historyBefore);
      setRedoStack(pending.redoBefore);
    }
    return Promise.resolve();
  }, [setHistory, setRedoStack]);

  useEffect(() => {
    const durable = createDurableLyricsHistory({
      onStatus: publishDurableStatus,
      onReconcile: resetToAuthoritativeRows,
      onError: (error) => {
        console.error('[durableLyricsHistory] Native history failed:', error);
        notifyEditFailed(tRef.current(
          'subtitlesInput.editFailed',
          'Your last edit could not be saved. Please try again.'
        ));
      },
    });
    durableRef.current = durable;
    const unregisterCacheId = isDesktopRuntime()
      ? subscribeCurrentCacheId((cacheId, previousCacheId) => {
          cancelPendingText();
          cancelExternalMerge();
          navigationPendingRef.current = false;
          viewGenerationRef.current += 1;
          applyStacks([], []);
          setCheckpointHistory([]);
          onCacheIdChange?.(cacheId, previousCacheId);
          void durable.refresh();
        })
      : () => undefined;
    // A replacement download can advance the same project without changing its URL cache alias.
    // Reset the optimistic editor boundary and reload that exact project's authoritative rows;
    // otherwise the next edit can be based on the snapshot from before media activation.
    const unregisterProjectRefresh = isDesktopRuntime()
      ? subscribeCurrentSubtitleProjectRefresh((cacheId) => {
          cancelPendingText();
          cancelExternalMerge();
          navigationPendingRef.current = false;
          viewGenerationRef.current += 1;
          applyStacks([], []);
          setCheckpointHistory([]);
          onCacheIdChange?.(cacheId, cacheId);
          void durable.refresh();
        })
      : () => undefined;
    const unregisterFlusher = registerDurableLyricsHistoryFlusher(async () => {
      await finishPendingText();
      await finishExternalMerge();
      await durable.flush();
    });
    void durable.refresh();
    return () => {
      unregisterCacheId();
      unregisterProjectRefresh();
      unregisterFlusher();
      finishPendingText();
      finishExternalMerge();
      durable.dispose();
      if (durableRef.current === durable) durableRef.current = null;
    };
  }, [
    applyStacks,
    cancelExternalMerge,
    cancelPendingText,
    finishExternalMerge,
    finishPendingText,
    onCacheIdChange,
    publishDurableStatus,
    resetToAuthoritativeRows,
    setCheckpointHistory,
  ]);

  const commitLyricsMutation = useCallback((nextRows, action, options = {}) => {
    if (!Array.isArray(nextRows)) return false;
    const baseline = clone(options.baseline ?? lyricsRef.current);
    const next = clone(nextRows);
    if (same(baseline, next)) return false;
    finishExternalMerge();

    if (action === LYRICS_EDITOR_ACTIONS.TEXT) {
      let pending = pendingTextRef.current;
      if (pending !== null && !same(pending.latest, baseline)) {
        finishPendingText();
        pending = null;
      }
      if (pending === null) {
        pending = {
          baseline,
          latest: next,
          timer: null,
          historyBefore: historyRef.current,
          redoBefore: redoRef.current,
        };
        pendingTextRef.current = pending;
        setRedoStack([]);
        setHistory((previous) => pushBounded(previous, baseline));
      } else {
        pending.latest = next;
      }

      if (options.alreadyApplied !== true) {
        replaceLyrics(next);
      } else {
        viewGenerationRef.current += 1;
        lyricsRef.current = next;
      }
      if (pending.timer !== null) window.clearTimeout(pending.timer);
      pending.timer = window.setTimeout(finishPendingText, TEXT_EDIT_QUIET_MS);
      return true;
    }

    finishPendingText();

    setRedoStack([]);
    if (options.pushHistory !== false) {
      setHistory((previous) => pushBounded(previous, baseline));
    }
    if (options.alreadyApplied !== true) {
      replaceLyrics(next);
    } else {
      viewGenerationRef.current += 1;
      lyricsRef.current = next;
    }
    void durableRef.current?.record(baseline, next, action);
    return true;
  }, [
    finishExternalMerge,
    finishPendingText,
    replaceLyrics,
    setHistory,
    setRedoStack,
  ]);

  const resolveOptimisticNavigation = useCallback((
    result,
    optimisticRows,
    previousRows,
    expectedGeneration
  ) => {
    if (expectedGeneration !== viewGenerationRef.current) return;
    if (!result?.ok || result.native === false) return;
    if (!result.navigated) {
      if (optimisticRows !== null) {
        setHistory([]);
        setRedoStack([]);
        replaceLyrics(previousRows);
      }
      return;
    }
    if (optimisticRows === null) {
      setRedoStack((previous) => pushBounded(previous, previousRows));
      replaceLyrics(result.rows);
      return;
    }
    if (!same(result.rows, optimisticRows)) resetToAuthoritativeRows(result.rows);
  }, [replaceLyrics, resetToAuthoritativeRows, setHistory, setRedoStack]);

  const handleUndo = useCallback(() => {
    if (navigationPendingRef.current) return;
    finishPendingText();
    finishExternalMerge();
    const current = clone(lyricsRef.current);
    const localHistory = historyRef.current;
    if (localHistory.length > 0) {
      const target = clone(localHistory[localHistory.length - 1]);
      setHistory(localHistory.slice(0, -1));
      setRedoStack((previous) => pushBounded(previous, current));
      replaceLyrics(target);
      const expectedGeneration = viewGenerationRef.current;
      void durableRef.current?.undo().then((result) => {
        resolveOptimisticNavigation(result, target, current, expectedGeneration);
      });
      return;
    }
    if (!durableStatusRef.current.canUndo || durableRef.current === null) return;

    navigationPendingRef.current = true;
    const expectedGeneration = viewGenerationRef.current;
    void durableRef.current.undo().then((result) => {
      resolveOptimisticNavigation(result, null, current, expectedGeneration);
    }).finally(() => {
      navigationPendingRef.current = false;
    });
  }, [
    finishExternalMerge,
    finishPendingText,
    replaceLyrics,
    resolveOptimisticNavigation,
    setHistory,
    setRedoStack,
  ]);

  const handleRedo = useCallback(() => {
    if (navigationPendingRef.current) return;
    finishPendingText();
    finishExternalMerge();
    const current = clone(lyricsRef.current);
    const localRedo = redoRef.current;
    if (localRedo.length > 0) {
      const target = clone(localRedo[localRedo.length - 1]);
      setRedoStack(localRedo.slice(0, -1));
      setHistory((previous) => pushBounded(previous, current));
      replaceLyrics(target);
      const expectedGeneration = viewGenerationRef.current;
      void durableRef.current?.redo().then((result) => {
        if (expectedGeneration !== viewGenerationRef.current) return;
        if (!result?.ok || result.native === false) return;
        if (!result.navigated) {
          setHistory([]);
          setRedoStack([]);
          replaceLyrics(current);
        } else if (!same(result.rows, target)) {
          resetToAuthoritativeRows(result.rows);
        }
      });
      return;
    }
    if (!durableStatusRef.current.canRedo || durableRef.current === null) return;

    navigationPendingRef.current = true;
    const expectedGeneration = viewGenerationRef.current;
    void durableRef.current.redo().then((result) => {
      if (expectedGeneration !== viewGenerationRef.current) return;
      if (result?.ok && result.navigated) {
        setHistory((previous) => pushBounded(previous, current));
        replaceLyrics(result.rows);
      }
    }).finally(() => {
      navigationPendingRef.current = false;
    });
  }, [
    finishExternalMerge,
    finishPendingText,
    replaceLyrics,
    resetToAuthoritativeRows,
    setHistory,
    setRedoStack,
  ]);

  const handleReset = useCallback(() => {
    if (savedLyricsRef.current.length > 0) {
      commitLyricsMutation(savedLyricsRef.current, LYRICS_EDITOR_ACTIONS.RESET);
    }
  }, [commitLyricsMutation]);

  const createCheckpoint = useCallback(() => {
    const current = clone(lyricsRef.current);
    setCheckpointHistory((previous) => [...previous, current]);
  }, [setCheckpointHistory]);

  const handleJumpToCheckpoint = useCallback(() => {
    if (checkpointHistory.length === 0) return;
    const current = clone(lyricsRef.current);
    let targetIndex = -1;
    for (let index = checkpointHistory.length - 1; index >= 0; index -= 1) {
      if (!same(checkpointHistory[index], current)) {
        targetIndex = index;
        break;
      }
    }
    if (targetIndex === -1) {
      if (checkpointHistory.length <= 1) return;
      targetIndex = 0;
    }
    commitLyricsMutation(
      checkpointHistory[targetIndex],
      LYRICS_EDITOR_ACTIONS.CHECKPOINT
    );
    setCheckpointHistory(checkpointHistory.slice(0, targetIndex));
  }, [checkpointHistory, commitLyricsMutation, setCheckpointHistory]);

  const captureStateBeforeMerge = useCallback(() => {
    finishPendingText();
    finishExternalMerge();
    const baseline = clone(lyricsRef.current);
    externalMergeRef.current = {
      baseline,
      latest: null,
      timer: null,
      captured: false,
      historyBefore: historyRef.current,
      redoBefore: redoRef.current,
    };
  }, [finishExternalMerge, finishPendingText]);

  const observeExternalLyrics = useCallback((rows) => {
    if (!Array.isArray(rows)) return;
    if (!same(rows, lyricsRef.current)) viewGenerationRef.current += 1;
    const pending = externalMergeRef.current;
    if (pending === null) return;
    pending.latest = clone(rows);
    if (!pending.captured && !same(pending.baseline, pending.latest)) {
      pending.captured = true;
      setRedoStack([]);
      setHistory(pushBounded(pending.historyBefore, pending.baseline));
    }
    if (pending.timer !== null) window.clearTimeout(pending.timer);
    pending.timer = window.setTimeout(finishExternalMerge, EXTERNAL_MERGE_QUIET_MS);
  }, [finishExternalMerge, setHistory, setRedoStack]);

  const refreshDurableHistory = useCallback(() => {
    finishPendingText();
    finishExternalMerge();
    void durableRef.current?.refresh();
  }, [finishExternalMerge, finishPendingText]);

  return {
    history,
    setHistory,
    redoStack,
    setRedoStack,
    checkpointHistory,
    setCheckpointHistory,
    durableCanUndo: durableStatus.canUndo,
    durableCanRedo: durableStatus.canRedo,
    handleUndo,
    handleRedo,
    handleReset,
    createCheckpoint,
    handleJumpToCheckpoint,
    captureStateBeforeMerge,
    observeExternalLyrics,
    finishExternalMerge,
    refreshDurableHistory,
    commitLyricsMutation,
  };
};
