import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import StandardSlider from './StandardSlider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

describe('StandardSlider public keyboard contract', () => {
  it('exposes the existing visible track as a named, bounded slider', () => {
    render(<StandardSlider id="font-size-slider" ariaLabel="Font size" value={72} min={8} max={240} />);
    const slider = screen.getByRole('slider', { name: 'Font size' });
    expect(slider).toHaveAttribute('data-osg-control', 'range');
    expect(slider).toHaveAttribute('data-osg-range-id', 'font-size-slider');
    expect(slider).toHaveAttribute('aria-valuemin', '8');
    expect(slider).toHaveAttribute('aria-valuemax', '240');
    expect(slider).toHaveAttribute('aria-valuenow', '72');
    fireEvent.mouseDown(slider, { button: 0, clientX: 20 });
    expect(document.activeElement).toBe(slider);
    fireEvent.mouseUp(document);
  });

  it('publishes exact stepped customer changes through Arrow, Home and End', () => {
    const onChange = vi.fn();
    render(
      <StandardSlider
        id="fade-in-duration-slider"
        ariaLabel="Fade in"
        value={0.6}
        min={0}
        max={2}
        step={0.1}
        onChange={onChange}
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Fade in' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    fireEvent.keyDown(slider, { key: 'Home' });
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onChange.mock.calls.map(([value]) => value)).toEqual([0.7, 0.5, 0, 2]);
  });

  it('does not mutate disabled or dual-thumb sliders from one ambiguous surface', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StandardSlider ariaLabel="Disabled" value={5} min={0} max={10} state="Disabled" onChange={onChange} />,
    );
    expect(screen.queryByRole('slider', { name: 'Disabled' })).not.toBeNull();
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Disabled' }), { key: 'ArrowRight' });
    rerender(
      <StandardSlider ariaLabel="Range" value={[2, 8]} range min={0} max={10} onChange={onChange} />,
    );
    expect(screen.queryByRole('slider', { name: 'Range' })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
