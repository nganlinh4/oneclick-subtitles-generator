import { fireEvent, render } from '@testing-library/react';
import LyricItem from './LyricItem';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

vi.mock('../common/Tooltip.jsx', () => ({
  default: ({ children }) => children,
}));

const baseProps = {
  lyric: { id: 'row', text: 'row', start: 1, end: 2 },
  isCurrentLyric: false,
  currentTime: 0,
  allowEditing: true,
  isDragging: () => false,
  onLyricClick: vi.fn(),
  onMouseDown: vi.fn(),
  onTouchStart: vi.fn(),
  getLastDragEnd: () => 0,
  onDelete: vi.fn(),
  onTextEdit: vi.fn(),
  onMerge: vi.fn(),
  timeFormat: 'hms_ms',
};

const cases = [
  ['above the first row', 0, 'up', 0, true],
  ['below the first row', 0, 'down', 1, true],
  ['above a middle row', 1, 'up', 1, true],
  ['below a middle row', 1, 'down', 2, true],
  ['above the last row', 2, 'up', 2, false],
  ['below the last row', 2, 'down', 3, false],
];

it.each(cases)('maps Add %s to the correct insertion gap', (
  _description,
  index,
  direction,
  expectedInsertionIndex,
  hasNextLyric
) => {
  const onInsert = vi.fn();
  const { container } = render(
    <LyricItem
      {...baseProps}
      index={index}
      hasNextLyric={hasNextLyric}
      onInsert={onInsert}
    />
  );

  fireEvent.mouseEnter(container.querySelector('.insert-lyric-button-container'));
  fireEvent.click(container.querySelector(`.arrow-button.${direction}`));

  expect(onInsert).toHaveBeenCalledOnce();
  expect(onInsert).toHaveBeenCalledWith(expectedInsertionIndex);
});
