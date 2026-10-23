import { fireEvent, render, within } from '@testing-library/react';
import LyricsVirtualizedList from './LyricsVirtualizedList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('./common/Tooltip.jsx', () => ({
  default: ({ children }) => children,
}));

const rows = [
  { id: 'a', text: 'first', start: 1.13, end: 2.3 },
  { id: 'b', text: 'second', start: 2.3, end: 3.5 },
];

const baseProps = (overrides = {}) => ({
  listRef: { current: null },
  lyrics: rows,
  currentIndex: -1,
  currentTime: 0,
  allowEditing: true,
  isDragging: () => false,
  getRowHeight: () => 60,
  onLyricClick: vi.fn(),
  onMouseDown: vi.fn(),
  onTouchStart: vi.fn(),
  getLastDragEnd: () => 0,
  onDelete: vi.fn(),
  onTextEdit: vi.fn(),
  onInsert: vi.fn(),
  onMerge: vi.fn(),
  timeFormat: 'hms_ms',
  ...overrides,
});

const row = (container, index) => container.querySelector(`[data-lyric-index="${index}"]`);
const startTimeText = (container, index) => row(container, index)
  .querySelector('.start-time').textContent;

test('a timeFormat change re-renders the rows', () => {
  const view = render(<LyricsVirtualizedList {...baseProps()} />);
  expect(startTimeText(view.container, 0)).toBe('0:01.13');

  view.rerender(<LyricsVirtualizedList {...baseProps({ timeFormat: 'seconds' })} />);
  expect(startTimeText(view.container, 0)).toBe('1.13s');
  expect(startTimeText(view.container, 1)).toBe('2.30s');
});

test('appending a row re-renders the previous last row with a next neighbour', () => {
  const view = render(<LyricsVirtualizedList {...baseProps()} />);
  const mergeDownOn = (index) => {
    fireEvent.mouseEnter(row(view.container, index).querySelector('.merge-lyrics-button-container'));
    return within(row(view.container, index)).getByTitle('Merge with below');
  };
  expect(mergeDownOn(1).disabled).toBe(true);

  view.rerender(<LyricsVirtualizedList {...baseProps({
    lyrics: [...rows, { id: 'c', text: 'third', start: 3.5, end: 4 }],
  })} />);
  expect(mergeDownOn(1).disabled).toBe(false);
});

test('rows call the newest handler after the parent passes a new one', () => {
  const view = render(<LyricsVirtualizedList {...baseProps()} />);
  const newestDelete = vi.fn();
  view.rerender(<LyricsVirtualizedList {...baseProps({ onDelete: newestDelete })} />);

  fireEvent.click(row(view.container, 1).querySelector('.delete-lyric-btn'));
  expect(newestDelete).toHaveBeenCalledExactlyOnceWith(1);
});
