import { act, renderHook, waitFor } from '@testing-library/react';
import { useLyricsEditor } from './useLyricsEditor';
import { isUuidV7 } from '../platform/projectSnapshotAdapter';

const commitLyricsMutation = vi.fn();

const historyApi = {
  history: [],
  redoStack: [],
  checkpointHistory: [],
  durableCanUndo: false,
  durableCanRedo: false,
  handleUndo: vi.fn(),
  handleRedo: vi.fn(),
  handleReset: vi.fn(),
  createCheckpoint: vi.fn(),
  handleJumpToCheckpoint: vi.fn(),
  captureStateBeforeMerge: vi.fn(),
  observeExternalLyrics: vi.fn(),
  commitLyricsMutation,
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('./useLyricsEditorHistory', () => ({
  useLyricsEditorHistory: () => historyApi,
}));

vi.mock('./useLyricsEditorDrag', () => ({
  useLyricsEditorDrag: () => ({
    startDrag: vi.fn(),
    handleDrag: vi.fn(),
    endDrag: vi.fn(),
    isDragging: false,
    getLastDragEnd: vi.fn(),
  }),
}));

vi.mock('./useLyricsEditorHelpers', () => ({
  useLyricsEditorHelpers: () => ({
    showTranslationWarning: vi.fn(),
    clearSubtitlesInRange: vi.fn(),
    moveSubtitlesInRange: vi.fn(),
    beginRangeMove: vi.fn(),
    previewRangeMove: vi.fn(),
    commitRangeMove: vi.fn(),
    cancelRangeMove: vi.fn(),
  }),
}));

const originalRows = [
  { id: 'a', text: 'A', start: 1, end: 2 },
  { id: 'b', text: 'B', start: 4, end: 5 },
  { id: 'c', text: 'C', start: 7, end: 8 },
];

const insertedTexts = (rows) => rows.map((row) => row.text);

beforeEach(() => {
  commitLyricsMutation.mockClear();
});

it.each([
  ['before the first row', 0, ['', 'A', 'B', 'C'], [0, 1]],
  ['between the first and middle rows', 1, ['A', '', 'B', 'C'], [2, 3.5]],
  ['between the middle and last rows', 2, ['A', 'B', '', 'C'], [5, 6.5]],
  ['after the last row', 3, ['A', 'B', 'C', ''], [8, 10]],
])('commits an undoable insert %s from insertion gap %i', async (
  _description,
  insertionIndex,
  expectedTexts,
  expectedTiming
) => {
  const { result } = renderHook(() => useLyricsEditor(originalRows, vi.fn()));
  await waitFor(() => expect(result.current.lyrics).toEqual(originalRows));

  act(() => result.current.handleInsertLyric(insertionIndex));

  expect(commitLyricsMutation).toHaveBeenCalledOnce();
  const [nextRows, action] = commitLyricsMutation.mock.calls[0];
  expect(insertedTexts(nextRows)).toEqual(expectedTexts);
  const insertedRow = nextRows.find((row) => row.text === '');
  expect(isUuidV7(insertedRow.id)).toBe(true);
  expect([insertedRow.start, insertedRow.end]).toEqual(expectedTiming);
  expect(action).toBe('insert');
});

it('creates a real gap and shifts only following rows when adjacent cues touch', async () => {
  const touchingRows = [
    { id: 'a', text: 'A', start: 0, end: 1 },
    { id: 'b', text: 'B', start: 1, end: 2 },
    { id: 'c', text: 'C', start: 2, end: 3 },
  ];
  const { result } = renderHook(() => useLyricsEditor(touchingRows, vi.fn()));
  await waitFor(() => expect(result.current.lyrics).toEqual(touchingRows));

  act(() => result.current.handleInsertLyric(1));

  const [nextRows] = commitLyricsMutation.mock.calls[0];
  expect(nextRows).toEqual([
    touchingRows[0],
    expect.objectContaining({ text: '', start: 1, end: 1.2 }),
    { ...touchingRows[1], start: 1.2, end: 2.2 },
    { ...touchingRows[2], start: 2.2, end: 3.2 },
  ]);
  expect(isUuidV7(nextRows[1].id)).toBe(true);
});

it('makes room for a valid prepend without overlapping a cue that starts at zero', async () => {
  const zeroBasedRows = [
    { id: 'a', text: 'A', start: 0, end: 1 },
    { id: 'b', text: 'B', start: 2, end: 3 },
  ];
  const { result } = renderHook(() => useLyricsEditor(zeroBasedRows, vi.fn()));
  await waitFor(() => expect(result.current.lyrics).toEqual(zeroBasedRows));

  act(() => result.current.handleInsertLyric(0));

  const [nextRows] = commitLyricsMutation.mock.calls[0];
  expect(nextRows).toEqual([
    expect.objectContaining({ text: '', start: 0, end: 0.2 }),
    { ...zeroBasedRows[0], start: 0.2, end: 1.2 },
    { ...zeroBasedRows[1], start: 2.2, end: 3.2 },
  ]);
  expect(isUuidV7(nextRows[0].id)).toBe(true);
});

it('refuses row indices outside the explicit insertion-gap range', async () => {
  const { result } = renderHook(() => useLyricsEditor(originalRows, vi.fn()));
  await waitFor(() => expect(result.current.lyrics).toEqual(originalRows));

  act(() => {
    result.current.handleInsertLyric(-1);
    result.current.handleInsertLyric(originalRows.length + 1);
  });

  expect(commitLyricsMutation).not.toHaveBeenCalled();
});
