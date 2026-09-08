import { VariableSizeList as List } from 'react-window';
import LyricItem from './lyrics/LyricItem';

// Virtualized row renderer for lyrics (simplified for deterministic height)
const VirtualizedLyricRow = ({ index, style, data }) => {
  const {
    lyrics,
    currentIndex,
    currentTime,
    allowEditing,
    isDragging,
    onLyricClick,
    onMouseDown,
    onTouchStart,
    getLastDragEnd,
    onDelete,
    onTextEdit,
    onInsert,
    onMerge,
    timeFormat
  } = data;

  const lyric = lyrics[index];
  const hasNextLyric = index < lyrics.length - 1;

  // The complex height measurement logic has been removed.
  // The layout is now controlled by getRowHeight and CSS.
  return (
    <div style={style}>
      <LyricItem
        key={index} // key is appropriate here within the mapping context of the parent
        lyric={lyric}
        index={index}
        isCurrentLyric={index === currentIndex}
        currentTime={currentTime}
        allowEditing={allowEditing}
        isDragging={isDragging}
        onLyricClick={onLyricClick}
        onMouseDown={onMouseDown}
        onTouchStart={onTouchStart}
        getLastDragEnd={getLastDragEnd}
        onDelete={onDelete}
        onTextEdit={onTextEdit}
        onInsert={onInsert}
        onMerge={onMerge}
        hasNextLyric={hasNextLyric}
        timeFormat={timeFormat}
      />
    </div>
  );
};

// Virtualized list of lyric rows (react-window wrapper). Pure UI; props only.
const LyricsVirtualizedList = ({
  listRef,
  lyrics,
  currentIndex,
  currentTime,
  allowEditing,
  isDragging,
  getRowHeight,
  onLyricClick,
  onMouseDown,
  onTouchStart,
  getLastDragEnd,
  onDelete,
  onTextEdit,
  onInsert,
  onMerge,
  timeFormat
}) => {
  return (
    <List
      ref={listRef}
      className="lyrics-container"
      height={300} // Reduced height for more compact view
      width="100%"
      itemCount={lyrics.length}
      itemSize={getRowHeight} // Dynamic row heights based on content
      overscanCount={5} // Number of items to render outside of the visible area
      itemData={{
        lyrics,
        currentIndex,
        currentTime,
        allowEditing,
        isDragging,
        onLyricClick,
        onMouseDown,
        onTouchStart,
        getLastDragEnd,
        onDelete,
        onTextEdit,
        onInsert,
        onMerge,
        timeFormat
      }}
    >
      {VirtualizedLyricRow}
    </List>
  );
};

export default LyricsVirtualizedList;
