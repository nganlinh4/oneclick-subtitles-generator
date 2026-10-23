import { fireEvent, render, screen } from '@testing-library/react';

import LiquidGlass from './LiquidGlass';
import PlayPauseMorphType4 from './PlayPauseMorphType4';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

describe('LiquidGlass', () => {
  test('a clickable surface is a keyboard-operable button', () => {
    const onClick = vi.fn();
    render(<LiquidGlass aria-label="Fullscreen" onClick={onClick}>x</LiquidGlass>);
    const button = screen.getByRole('button', { name: 'Fullscreen' });
    expect(button).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test('a decorative surface stays out of the tab order', () => {
    const { container } = render(<LiquidGlass aria-label="Drag to zoom">x</LiquidGlass>);
    const surface = container.querySelector('.liquid-glass');
    expect(surface).not.toHaveAttribute('role');
    expect(surface).not.toHaveAttribute('tabindex');
  });
});

describe('PlayPauseMorphType4', () => {
  // jsdom has no SVG geometry; the morph only needs some sampled points.
  beforeAll(() => {
    SVGElement.prototype.getTotalLength ??= () => 100;
    SVGElement.prototype.getPointAtLength ??= (length) => ({ x: length % 24, y: length % 24 });
  });

  test('with onToggle it is a named button that toggles from the keyboard', () => {
    const onToggle = vi.fn();
    render(<PlayPauseMorphType4 playing={false} onToggle={onToggle} />);
    const button = screen.getByRole('button', { name: 'Play' });
    fireEvent.keyDown(button, { key: ' ' });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test('without onToggle it is hidden decoration inside the parent control', () => {
    render(
      <button type="button" aria-label="Play voice sample">
        <PlayPauseMorphType4 playing />
      </button>,
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Play voice sample' })).toBeInTheDocument();
  });
});
