import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import {
  pruneLyricsCheckpointHistory,
  pruneLyricsHistoryStacks,
  useLyricsEditorHistory,
} from './useLyricsEditorHistory';
import { LYRICS_EDITOR_ACTIONS } from '../platform/durableLyricsHistory';

const controller = {
  refresh: vi.fn(async () => undefined),
  record: vi.fn(async () => ({ ok: true })),
  undo: vi.fn(async () => ({ ok: true, navigated: true, rows: [] })),
  redo: vi.fn(async () => ({ ok: true, navigated: true, rows: [] })),
  flush: vi.fn(async () => undefined),
  dispose: vi.fn(),
};
let controllerCallbacks;

vi.mock('../platform/durableLyricsHistory', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createDurableLyricsHistory: vi.fn((callbacks) => {
      controllerCallbacks = callbacks;
      return controller;
    }),
    registerDurableLyricsHistoryFlusher: vi.fn(() => () => undefined),
  };
});

const rows = (text) => [{ id: 1, start: 0, end: 1, text }];
const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

it('evicts farthest and oversized snapshots under the joint local byte budget', () => {
  const farthest = rows('x'.repeat(40));
  const near = rows('B');
  const redo = rows('C');
  const retainedBytes = JSON.stringify(near).length + JSON.stringify(redo).length;
  expect(pruneLyricsHistoryStacks([farthest, near], [redo], {
    maxEntries: 3,
    maxStateBytes: 1_024,
    maxTotalBytes: retainedBytes,
  })).toEqual({ history: [near], redo: [redo] });

  expect(pruneLyricsHistoryStacks([farthest], [], {
    maxEntries: 3,
    maxStateBytes: JSON.stringify(near).length,
    maxTotalBytes: 1_024,
  })).toEqual({ history: [], redo: [] });
});

const useHarness = (initialRows, onUpdateLyrics = vi.fn()) => {
  const [lyrics, setLyrics] = useState(initialRows);
  const history = useLyricsEditorHistory({
    lyrics,
    setLyrics,
    onUpdateLyrics,
    savedLyrics: initialRows,
  });
  return { lyrics, ...history };
};

beforeEach(() => {
  vi.clearAllMocks();
  controller.refresh.mockResolvedValue(undefined);
  controller.record.mockResolvedValue({ ok: true });
  controller.undo.mockResolvedValue({ ok: true, navigated: true, rows: rows('A') });
  controller.redo.mockResolvedValue({ ok: true, navigated: true, rows: rows('B') });
});

it('renders text immediately and flushes its pending durable revision before undo', async () => {
  controller.undo.mockResolvedValue({
    ok: true,
    native: false,
    navigated: false,
    rows: null,
  });
  const onUpdate = vi.fn();
  const { result } = renderHook(() => useHarness(rows('A'), onUpdate));

  act(() => {
    result.current.commitLyricsMutation(rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
  });
  expect(result.current.lyrics).toEqual(rows('B'));
  expect(controller.record).not.toHaveBeenCalled();

  act(() => result.current.handleUndo());
  expect(controller.record).toHaveBeenCalledWith(
    rows('A'),
    rows('B'),
    LYRICS_EDITOR_ACTIONS.TEXT
  );
  expect(controller.record.mock.invocationCallOrder[0])
    .toBeLessThan(controller.undo.mock.invocationCallOrder[0]);
  expect(result.current.lyrics).toEqual(rows('A'));
  await waitFor(() => expect(controller.undo).toHaveBeenCalledTimes(1));
  expect(result.current.lyrics).toEqual(rows('A'));
  expect(result.current.redoStack).toEqual([rows('B')]);
});

it('groups rapid typing into one local and durable revision at the quiet edge', async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useHarness(rows('A')));

  act(() => {
    result.current.commitLyricsMutation(rows('AB'), LYRICS_EDITOR_ACTIONS.TEXT);
    result.current.commitLyricsMutation(rows('ABC'), LYRICS_EDITOR_ACTIONS.TEXT);
    vi.advanceTimersByTime(499);
  });
  expect(result.current.lyrics).toEqual(rows('ABC'));
  expect(result.current.history).toEqual([rows('A')]);
  expect(controller.record).not.toHaveBeenCalled();

  await act(async () => {
    vi.advanceTimersByTime(1);
    await Promise.resolve();
  });
  expect(controller.record).toHaveBeenCalledTimes(1);
  expect(controller.record).toHaveBeenCalledWith(
    rows('A'),
    rows('ABC'),
    LYRICS_EDITOR_ACTIONS.TEXT
  );
  vi.useRealTimers();
});

it('flushes a pending text group before the next non-text revision', () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useHarness(rows('A')));

  act(() => {
    result.current.commitLyricsMutation(rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
    result.current.commitLyricsMutation(rows('C'), LYRICS_EDITOR_ACTIONS.DELETE);
  });
  expect(result.current.lyrics).toEqual(rows('C'));
  expect(result.current.history).toEqual([rows('A'), rows('B')]);
  expect(controller.record.mock.calls).toEqual([
    [rows('A'), rows('B'), LYRICS_EDITOR_ACTIONS.TEXT],
    [rows('B'), rows('C'), LYRICS_EDITOR_ACTIONS.DELETE],
  ]);

  act(() => vi.advanceTimersByTime(500));
  expect(controller.record).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});

it('enqueues a pending text group before disposing on unmount', () => {
  vi.useFakeTimers();
  const { result, unmount } = renderHook(() => useHarness(rows('A')));
  act(() => {
    result.current.commitLyricsMutation(rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
  });
  expect(controller.record).not.toHaveBeenCalled();

  unmount();
  expect(controller.record).toHaveBeenCalledWith(
    rows('A'),
    rows('B'),
    LYRICS_EDITOR_ACTIONS.TEXT
  );
  expect(controller.record.mock.invocationCallOrder[0])
    .toBeLessThan(controller.dispose.mock.invocationCallOrder[0]);
  vi.useRealTimers();
});

it('hydrates restart-safe undo availability and applies the native target without a local stack', async () => {
  controller.undo.mockResolvedValue({
    ok: true,
    navigated: true,
    rows: rows('Persisted parent'),
  });
  const { result } = renderHook(() => useHarness(rows('Current')));

  act(() => controllerCallbacks.onStatus({ canUndo: true, canRedo: false }));
  expect(result.current.durableCanUndo).toBe(true);
  expect(result.current.history).toEqual([]);

  act(() => result.current.handleUndo());
  await waitFor(() => expect(result.current.lyrics).toEqual(rows('Persisted parent')));
  expect(result.current.redoStack).toEqual([rows('Current')]);
});

it('rolls an optimistic local navigation back if the guarded native cursor refuses it', async () => {
  controller.undo.mockResolvedValue({ ok: true, navigated: false, rows: null });
  const { result } = renderHook(() => useHarness(rows('A')));
  act(() => {
    result.current.commitLyricsMutation(rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
  });

  act(() => result.current.handleUndo());
  expect(result.current.lyrics).toEqual(rows('A'));
  await waitFor(() => expect(result.current.lyrics).toEqual(rows('B')));
  expect(result.current.history).toEqual([]);
  expect(result.current.redoStack).toEqual([]);
});

it('treats non-durable display aliases as the same native undo target', async () => {
  const aliased = [{
    id: 99,
    start: 0,
    end: 1,
    startTime: 0,
    endTime: 1,
    text: 'A',
    transientConfidence: 0.75,
  }];
  controller.undo.mockResolvedValue({ ok: true, navigated: true, rows: rows('A') });
  const { result } = renderHook(() => useHarness(aliased));
  act(() => {
    result.current.commitLyricsMutation(rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
    result.current.handleUndo();
  });

  await waitFor(() => expect(controller.undo).toHaveBeenCalledTimes(1));
  expect(result.current.history).toEqual([]);
  expect(result.current.redoStack).toEqual([rows('B')]);
});

it('coalesces progressive external previews into one revision after the quiet edge', async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useHarness(rows('Before')));

  act(() => {
    result.current.captureStateBeforeMerge();
    result.current.observeExternalLyrics(rows('Preview 1'));
    result.current.observeExternalLyrics(rows('Preview 2'));
    vi.advanceTimersByTime(749);
  });
  expect(controller.record).not.toHaveBeenCalled();

  await act(async () => {
    vi.advanceTimersByTime(1);
    await Promise.resolve();
  });
  expect(controller.record).toHaveBeenCalledWith(
    rows('Before'),
    rows('Preview 2'),
    LYRICS_EDITOR_ACTIONS.EXTERNAL_MERGE
  );
  expect(result.current.history).toEqual([rows('Before')]);
  vi.useRealTimers();
});

it('does not create a volatile or durable entry when an external merge returns to baseline', async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useHarness(rows('Before')));

  act(() => {
    result.current.captureStateBeforeMerge();
    result.current.observeExternalLyrics(rows('Preview'));
    result.current.observeExternalLyrics(rows('Before'));
  });
  expect(result.current.history).toEqual([rows('Before')]);

  await act(async () => {
    vi.advanceTimersByTime(750);
    await Promise.resolve();
  });
  expect(controller.record).not.toHaveBeenCalled();
  expect(result.current.history).toEqual([]);
  expect(result.current.redoStack).toEqual([]);
  vi.useRealTimers();
});

it('ignores an older navigation correction after a newer local edit', async () => {
  const pendingUndo = deferred();
  controller.undo.mockReturnValue(pendingUndo.promise);
  const { result } = renderHook(() => useHarness(rows('A')));
  act(() => {
    result.current.commitLyricsMutation(rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
    result.current.handleUndo();
    result.current.commitLyricsMutation(rows('D'), LYRICS_EDITOR_ACTIONS.TEXT);
  });
  expect(result.current.lyrics).toEqual(rows('D'));

  await act(async () => {
    pendingUndo.resolve({ ok: true, navigated: false, rows: null });
    await pendingUndo.promise;
  });
  expect(result.current.lyrics).toEqual(rows('D'));
});

it('clears volatile stacks when the durable controller reconciles a stale track', () => {
  const { result } = renderHook(() => useHarness(rows('A')));
  act(() => {
    result.current.commitLyricsMutation(rows('B'), LYRICS_EDITOR_ACTIONS.TEXT);
  });
  expect(result.current.history).toHaveLength(1);

  act(() => controllerCallbacks.onReconcile(rows('Authoritative')));
  expect(result.current.lyrics).toEqual(rows('Authoritative'));
  expect(result.current.history).toEqual([]);
  expect(result.current.redoStack).toEqual([]);
});

it('matches the native 256-state retention window after more than 256 edits', async () => {
  let nativeCursor = 300;
  controller.undo.mockImplementation(async () => {
    nativeCursor -= 1;
    return { ok: true, navigated: true, rows: rows(`v${nativeCursor}`) };
  });
  const { result } = renderHook(() => useHarness(rows('v0')));

  act(() => {
    for (let index = 1; index <= 300; index += 1) {
      result.current.commitLyricsMutation(
        rows(`v${index}`),
        LYRICS_EDITOR_ACTIONS.INSERT
      );
    }
  });
  expect(result.current.history).toHaveLength(255);
  expect(result.current.history[0]).toEqual(rows('v45'));

  await act(async () => {
    for (let index = 0; index < 255; index += 1) result.current.handleUndo();
    await Promise.resolve();
  });
  expect(controller.undo).toHaveBeenCalledTimes(255);
  expect(result.current.history).toEqual([]);
  expect(result.current.redoStack).toHaveLength(255);
  expect(result.current.lyrics).toEqual(rows('v45'));

  act(() => result.current.handleUndo());
  expect(controller.undo).toHaveBeenCalledTimes(255);
  expect(result.current.lyrics).toEqual(rows('v45'));
});

it('keeps only four byte-bounded session checkpoints', () => {
  const { result } = renderHook(() => useHarness(rows('v0')));
  act(() => {
    for (let index = 1; index <= 6; index += 1) {
      result.current.commitLyricsMutation(
        rows(`v${index}`),
        LYRICS_EDITOR_ACTIONS.INSERT
      );
      result.current.createCheckpoint();
    }
  });
  expect(result.current.checkpointHistory).toEqual([
    rows('v3'),
    rows('v4'),
    rows('v5'),
    rows('v6'),
  ]);

  const near = rows('N');
  const newest = rows('O');
  const oversized = rows('x'.repeat(40));
  expect(pruneLyricsCheckpointHistory([oversized, near, newest], {
    maxEntries: 4,
    maxStateBytes: JSON.stringify(near).length,
    maxTotalBytes: JSON.stringify(near).length + JSON.stringify(newest).length,
  })).toEqual([near, newest]);
});
