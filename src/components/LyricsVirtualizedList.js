import { useMemo, useRef } from 'react';
import { VariableSizeList as List } from 'react-window';
import LyricItem from './lyrics/LyricItem';

const ROW_HANDLER_KEYS = Object.freeze([
  'onLyricClick',
  'onMouseDown',
  'onTouchStart',
  'getLastDragEnd',
  'onDelete',
  'onTextEdit',
  'onInsert',
  'onMerge',
]);

// Rows receive stable proxies that always call the newest handler. A parent re-render with fresh
// handler identities then neither re-renders every memoized row nor leaves a row holding a stale one.
const useStableRowHandlers = (handlers) => {
  const latestRef = useRef(handlers);
  latestRef.current = handlers;
  return useMemo(() => Object.freeze(Object.fromEntries(ROW_HANDLER_KEYS.map((key) => [
    key,
    (...args) => latestRef.current[key]?.(...args),
  ]))), []);
};

const VirtualizedLyricRow = ({ index, style, data }) => {
  const { lyrics, currentIndex, handlers, ...rowProps } = data;
  return (
    <div style={style}>
      <LyricItem
        {...rowProps}
        {...handlers}
        lyric={lyrics[index]}
        index={index}
        isCurrentLyric={index === currentIndex}
        hasNextLyric={index < lyrics.length - 1}
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
  timeFormat,
  ...handlerProps
}) => {
  const handlers = useStableRowHandlers(handlerProps);
  const itemData = useMemo(() => ({
    lyrics,
    currentIndex,
    currentTime,
    allowEditing,
    isDragging,
    timeFormat,
    handlers,
  }), [lyrics, currentIndex, currentTime, allowEditing, isDragging, timeFormat, handlers]);

  return (
    <List
      ref={listRef}
      className="lyrics-container"
      height={300}
      width="100%"
      itemCount={lyrics.length}
      itemSize={getRowHeight}
      overscanCount={5}
      itemData={itemData}
    >
      {VirtualizedLyricRow}
    </List>
  );
};

export default LyricsVirtualizedList;
