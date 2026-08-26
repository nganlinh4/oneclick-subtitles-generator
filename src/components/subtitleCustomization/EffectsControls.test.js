import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import EffectsControls from './EffectsControls';
import { defaultCustomization } from './defaultCustomization';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key, fallback) => fallback }),
}));

const restoredCustomization = Object.freeze({
  ...defaultCustomization,
  textShadowEnabled: true,
  textShadowColor: '#1234',
  glowEnabled: true,
  glowColor: '#3456789a',
  strokeEnabled: true,
  strokeColor: '#abcdef80',
});

describe('subtitle effect color controls', () => {
  it('preserves restored alpha-bearing colors while projecting only RGB into native pickers', () => {
    const onChange = vi.fn();
    const { container } = render(
      <EffectsControls customization={restoredCustomization} onChange={onChange} />,
    );

    expect(container.querySelector('#subtitle-text-shadow-color')).toHaveValue('#1234');
    expect(container.querySelector('#subtitle-glow-color')).toHaveValue('#3456789a');
    expect(container.querySelector('#subtitle-stroke-color')).toHaveValue('#abcdef80');
    expect(container.querySelector('#subtitle-text-shadow-color-picker')).toHaveValue('#112233');
    expect(container.querySelector('#subtitle-glow-color-picker')).toHaveValue('#345678');
    expect(container.querySelector('#subtitle-stroke-color-picker')).toHaveValue('#abcdef');
    expect(container.querySelector('label[for="subtitle-text-shadow-color"]')).toHaveTextContent(
      'Text Shadow',
    );
    expect(container.querySelector('label[for="subtitle-glow-color"]')).toHaveTextContent(
      'Glow Effect',
    );
    expect(container.querySelector('label[for="subtitle-stroke-color"]')).toHaveTextContent(
      'Text Stroke',
    );
    expect(container.querySelector('#subtitle-text-shadow-color-picker')).toHaveAttribute(
      'aria-label',
      'Text Shadow',
    );
    expect(container.querySelector('#subtitle-glow-color-picker')).toHaveAttribute(
      'aria-label',
      'Glow Effect',
    );
    expect(container.querySelector('#subtitle-stroke-color-picker')).toHaveAttribute(
      'aria-label',
      'Text Stroke',
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([
    ['text shadow', 'subtitle-text-shadow-color', 'textShadowColor'],
    ['glow', 'subtitle-glow-color', 'glowColor'],
    ['stroke', 'subtitle-stroke-color', 'strokeColor'],
  ])('keeps an incomplete %s draft local and commits one exact complete color', (
    _name,
    controlId,
    property,
  ) => {
    const onChange = vi.fn();
    const { container } = render(
      <EffectsControls customization={restoredCustomization} onChange={onChange} />,
    );
    const input = container.querySelector(`#${controlId}`);

    fireEvent.change(input, { target: { value: '#a' } });
    expect(input).toHaveValue('#a');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '#a1b2c380' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledOnce();
    const update = onChange.mock.calls[0][0];
    expect(update).toBeTypeOf('function');
    expect(update(restoredCustomization)).toEqual({
      ...restoredCustomization,
      [property]: '#a1b2c380',
      preset: 'custom',
    });
  });
});

describe('gradient direction labels', () => {
  it.each([
    ['0deg', 'Vertical ↑'],
    ['90deg', 'Horizontal →'],
    ['45deg', 'Diagonal ↗'],
    ['135deg', 'Diagonal ↘'],
    ['180deg', 'Vertical ↓'],
    ['270deg', 'Horizontal ←'],
  ])('describes the persisted CSS angle %s truthfully as %s', (value, label) => {
    const { container } = render(
      <EffectsControls
        customization={{
          ...restoredCustomization,
          gradientEnabled: true,
          gradientDirection: value,
        }}
        onChange={vi.fn()}
      />,
    );

    const dropdown = container.querySelector('#subtitle-gradient-direction');
    expect(dropdown).toHaveAttribute('data-value', value);
    expect(dropdown).toHaveTextContent(label);
  });
});
