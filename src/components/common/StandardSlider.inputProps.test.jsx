import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StandardSlider from './StandardSlider';
import SliderWithValue from './SliderWithValue';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

describe('StandardSlider inputProps and invariant preservation', () => {
  it('preserves standard-slider-input class token alongside caller inputProps.className', () => {
    const { container } = render(
      <StandardSlider
        id="speech-window-duration-slider"
        ariaLabel="Max window duration"
        value={120}
        min={30}
        max={300}
        step={10}
        inputProps={{
          'data-osg-action': 'speech-window-duration-slider',
          className: 'speech-window-duration-slider',
        }}
      />
    );

    const input = container.querySelector('input[type="range"]');
    expect(input).not.toBeNull();
    expect(input.classList.contains('standard-slider-input')).toBe(true);
    expect(input.classList.contains('speech-window-duration-slider')).toBe(true);
    expect(input.getAttribute('data-osg-action')).toBe('speech-window-duration-slider');
    expect(input.style.pointerEvents).toBe('none');
    expect(input.tabIndex).toBe(-1);
    expect(input.getAttribute('aria-hidden')).toBe('true');
  });

  it('prevents accidental override of component-owned range invariants by inputProps', () => {
    const onChange = vi.fn();
    const { container } = render(
      <StandardSlider
        id="test-slider"
        value={50}
        min={10}
        max={100}
        step={5}
        onChange={onChange}
        inputProps={{
          type: 'text',
          min: 999,
          max: 0,
          step: 100,
          value: 999,
          disabled: true,
          tabIndex: 0,
        }}
      />
    );

    const input = container.querySelector('input');
    expect(input.type).toBe('range');
    expect(input.min).toBe('10');
    expect(input.max).toBe('100');
    expect(input.step).toBe('5');
    expect(input.value).toBe('50');
    expect(input.disabled).toBe(false);
    expect(input.tabIndex).toBe(-1);
  });

  it('updates controlled value and supports keyboard interaction through accessible slider track', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <SliderWithValue
        id="speech-window-duration-slider"
        value={120}
        min={30}
        max={300}
        step={10}
        defaultValue={120}
        onChange={onChange}
        inputProps={{
          'data-osg-action': 'speech-window-duration-slider',
          className: 'speech-window-duration-slider',
        }}
      />
    );

    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuenow', '120');

    // Test accessible keyboard navigation
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith(130);

    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith(110);

    fireEvent.keyDown(slider, { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith(30);

    fireEvent.keyDown(slider, { key: 'End' });
    expect(onChange).toHaveBeenCalledWith(300);

    // Rerender with updated value and verify hidden input and slider reflect it
    rerender(
      <SliderWithValue
        id="speech-window-duration-slider"
        value={130}
        min={30}
        max={300}
        step={10}
        defaultValue={120}
        onChange={onChange}
        inputProps={{
          'data-osg-action': 'speech-window-duration-slider',
          className: 'speech-window-duration-slider',
        }}
      />
    );

    const input = container.querySelector('input[type="range"]');
    expect(input.value).toBe('130');
    expect(slider).toHaveAttribute('aria-valuenow', '130');
  });
});
