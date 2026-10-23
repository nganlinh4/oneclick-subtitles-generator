import { fireEvent, render, screen } from '@testing-library/react';

import { activateOnKey } from './activateOnKey';

function renderPressable(onClick) {
  render(
    <div role="button" tabIndex={0} onClick={onClick} onKeyDown={activateOnKey}>
      <input aria-label="nested field" />
    </div>,
  );
  return screen.getByRole('button');
}

describe('activateOnKey', () => {
  test('Enter clicks the element', () => {
    const onClick = vi.fn();
    const pressable = renderPressable(onClick);
    fireEvent.keyDown(pressable, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('Space clicks the element and prevents the page scroll', () => {
    const onClick = vi.fn();
    const pressable = renderPressable(onClick);
    const notCancelled = fireEvent.keyDown(pressable, { key: ' ' });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(notCancelled).toBe(false);
  });

  test('other keys do nothing', () => {
    const onClick = vi.fn();
    const pressable = renderPressable(onClick);
    const notCancelled = fireEvent.keyDown(pressable, { key: 'a' });
    expect(onClick).not.toHaveBeenCalled();
    expect(notCancelled).toBe(true);
  });

  test('keys from a nested control are left to that control', () => {
    const onClick = vi.fn();
    renderPressable(onClick);
    const field = screen.getByLabelText('nested field');
    const notCancelled = fireEvent.keyDown(field, { key: ' ' });
    expect(onClick).not.toHaveBeenCalled();
    expect(notCancelled).toBe(true);
  });
});
