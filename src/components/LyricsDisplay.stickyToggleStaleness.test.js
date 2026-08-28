import { fireEvent, render, waitFor } from '@testing-library/react';

import { useLyricsEditor } from '../hooks/useLyricsEditor';
import { useLyricsDrag } from '../hooks/useLyricsDrag';
import LyricsHeader from './lyrics/LyricsHeader';
import LyricsVirtualizedList from './LyricsVirtualizedList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

// Same leaf-only mock LyricItem.insert.test.js uses -- the tooltip's hover/portal machinery is
// unrelated to the drag/memo behavior under test.
vi.mock('./common/Tooltip.jsx', () => ({
  default: ({ children }) => children,
}));

// Same react-window stub NarrationResults.test.js uses: render every row unconditionally (no
// virtualization window) so a real `MemoizedLyricItem` mounts per row and its own memo comparator
// -- the actual boundary this regression is about -- decides whether each row re-renders.
vi.mock('react-window', async () => {
  const ReactModule = await import('react');
  return {
    VariableSizeList: ReactModule.forwardRef(({ children: Row, itemCount, itemData }, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({ resetAfterIndex: () => {}, scrollToItem: () => {} }));
      return (
        <div>
          {Array.from({ length: itemCount }, (_, index) => (
            <Row key={index} index={index} style={{}} data={itemData} />
          ))}
        </div>
      );
    }),
  };
});

// Composes useLyricsEditor -> useLyricsDrag -> LyricsHeader/LyricsVirtualizedList exactly the way
// LyricsDisplay.js wires them (see src/components/LyricsDisplay.js:187-221, 434-440, 495-521),
// dropping only the concerns that are not part of the sticky-toggle + drag path this regression
// protects (waveform, timeline visualization, translation/export, undo keyboard shortcuts config).
function LyricsDragHarness({ initialLyrics, currentTime, duration, onUpdateLyrics }) {
  const {
    lyrics,
    isSticky,
    setIsSticky,
    startDrag,
    handleDrag,
    endDrag,
    isDragging,
    getLastDragEnd,
    handleDeleteLyric,
    handleTextEdit,
    handleInsertLyric,
    handleMergeLyrics,
    canUndo,
    canRedo,
    canJumpToCheckpoint,
    isAtOriginalState,
    isAtSavedState,
    handleUndo,
    handleRedo,
    handleReset,
    handleJumpToCheckpoint,
  } = useLyricsEditor(initialLyrics, onUpdateLyrics);

  // Same currentIndex formula as LyricsDisplay.js:224-228.
  const currentIndex = lyrics.findIndex((lyric, index) => {
    const nextLyric = lyrics[index + 1];
    return currentTime >= lyric.start &&
      (nextLyric ? currentTime < (lyric.end + (nextLyric.start - lyric.end) / 2) - 0.001 : currentTime <= lyric.end);
  });

  const { handleMouseDown, handleTouchStart } = useLyricsDrag({
    lyrics,
    duration,
    startDrag,
    handleDrag,
    endDrag,
  });

  return (
    <div>
      <LyricsHeader
        allowEditing
        isSticky={isSticky}
        setIsSticky={setIsSticky}
        canUndo={canUndo}
        canRedo={canRedo}
        canJumpToCheckpoint={canJumpToCheckpoint}
        isAtOriginalState={isAtOriginalState}
        isAtSavedState={isAtSavedState}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onReset={handleReset}
        onJumpToCheckpoint={handleJumpToCheckpoint}
        onSave={() => {}}
        autoScrollEnabled={false}
        setAutoScrollEnabled={() => {}}
        lyrics={lyrics}
        onSplitSubtitles={() => {}}
        selectedRange={null}
      />
      <LyricsVirtualizedList
        lyrics={lyrics}
        currentIndex={currentIndex}
        currentTime={currentTime}
        allowEditing
        isDragging={isDragging}
        getRowHeight={() => 50}
        onLyricClick={() => {}}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        getLastDragEnd={getLastDragEnd}
        onDelete={handleDeleteLyric}
        onTextEdit={handleTextEdit}
        onInsert={handleInsertLyric}
        onMerge={handleMergeLyrics}
        timeFormat="seconds"
      />
    </div>
  );
}

const buildLyrics = () => ([
  { id: 'a', text: 'Row A', start: 2, end: 4 },
  { id: 'b', text: 'Row B', start: 6, end: 8 },
  { id: 'c', text: 'Row C', start: 10, end: 12 },
]);

describe('LyricsDisplay drag wiring vs. the LyricItem memo boundary', () => {
  beforeEach(() => {
    // handleMouseMove always defers the actual drag update through rAF (useLyricsDrag.js); run it
    // synchronously so a single mousemove resolves deterministically without a real animation frame.
    vi.stubGlobal('requestAnimationFrame', (cb) => { cb(); return 0; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drags an untouched row using the live sticky setting after toggling it off, not a stale closure', async () => {
    const onUpdateLyrics = vi.fn();
    // currentTime is deliberately before every possible dragged start (the drag below clamps at
    // 0 at most) so isCurrentLyric -- and therefore ContinuousProgressIndicator's self-scheduling
    // rAF loop -- never engages for any row, whether the drag computed a correct or a buggy result.
    const { container } = render(
      <LyricsDragHarness
        initialLyrics={buildLyrics()}
        currentTime={-1}
        duration={20}
        onUpdateLyrics={onUpdateLyrics}
      />
    );

    await waitFor(() => {
      expect(container.querySelectorAll('[data-lyric-index]')).toHaveLength(3);
    });

    // Sticky defaults to on. Flipping it off is the *only* state change between mount and the drag
    // below -- nothing the MemoizedLyricItem comparator checks (isCurrentLyric, currentTime-while-
    // current, lyric identity, isDragging) changes as a result, so every row bails on re-render and
    // keeps whatever onMouseDown closure it mounted with.
    const stickyToggle = container.querySelector('.sticky-toggle');
    expect(stickyToggle).toHaveClass('active');
    fireEvent.click(stickyToggle);
    expect(stickyToggle).not.toHaveClass('active');

    // Drag row 0's start handle backward by 2s. This row was never independently re-rendered since
    // mount, let alone since the toggle click above.
    const startHandle = container.querySelectorAll('.start-time')[0];
    fireEvent.mouseDown(startHandle, { clientX: 1000 });
    fireEvent.mouseMove(document, { clientX: 800 }); // deltaX -200px * 0.01 s/px = -2s
    fireEvent.mouseUp(document);

    await waitFor(() => expect(onUpdateLyrics).toHaveBeenCalled());
    const finalRows = onUpdateLyrics.mock.calls[onUpdateLyrics.mock.calls.length - 1][0];

    // Sticky is OFF: only the dragged row's start may move. Its own end, and every later cue, must
    // stay exactly where they were -- no cascade.
    expect(finalRows[0]).toMatchObject({ start: 0, end: 4 });
    expect(finalRows[1]).toMatchObject({ start: 6, end: 8 });
    expect(finalRows[2]).toMatchObject({ start: 10, end: 12 });
  });
});
