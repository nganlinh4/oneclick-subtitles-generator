import {
  act, fireEvent, render,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import BackgroundControls from './BackgroundControls';
import { defaultCustomization } from './defaultCustomization';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('subtitle customization updates', () => {
  it('applies the real throttled pointer patch to the latest scene without reverting a newer color edit', () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    const onChange = vi.fn();
    const { container } = render(
      <BackgroundControls customization={defaultCustomization} onChange={onChange} />,
    );

    const track = container.querySelector('#background-opacity-slider')
      .closest('.standard-slider-track-container');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      right: 100,
      top: 0,
      bottom: 20,
      width: 100,
      height: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.mouseDown(track, { button: 0, clientX: 50, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 95, clientY: 10 });
    expect(onChange).not.toHaveBeenCalled();

    const color = container.querySelector('#subtitle-background-color');
    fireEvent.change(color, { target: { value: '#7a003c' } });
    fireEvent.blur(color);
    expect(onChange).toHaveBeenCalledOnce();
    const colorUpdate = onChange.mock.calls[0][0];
    expect(colorUpdate).toBeTypeOf('function');

    let scene = { ...defaultCustomization };
    scene = colorUpdate(scene);
    expect(scene.backgroundColor).toBe('#7a003c');

    act(() => vi.advanceTimersByTime(75));
    expect(onChange).toHaveBeenCalledTimes(2);
    const delayedOpacityUpdate = onChange.mock.calls[1][0];
    expect(delayedOpacityUpdate).toBeTypeOf('function');
    scene = delayedOpacityUpdate(scene);
    expect(scene).toMatchObject({
      backgroundColor: '#7a003c',
      backgroundOpacity: 95,
      preset: 'custom',
    });
  });
});
