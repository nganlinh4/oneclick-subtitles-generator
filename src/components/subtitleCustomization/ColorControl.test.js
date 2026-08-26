import {
  act, fireEvent, render, screen,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import ColorControl, { isSubtitleColor } from './ColorControl';

describe('subtitle color control', () => {
  it('keeps incomplete typing local and commits one complete color on blur', () => {
    const onChange = vi.fn();
    render(<ColorControl value="#000000" onChange={onChange} placeholder="#000000" />);
    const input = screen.getByPlaceholderText('#000000');

    for (const draft of ['#', '#7', '#7a', '#7a0', '#7a00', '#7a003', '#7a003c']) {
      fireEvent.change(input, { target: { value: draft } });
      expect(input).toHaveValue(draft);
      expect(onChange).not.toHaveBeenCalled();
    }
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('#7a003c');
  });

  it('reverts an invalid draft and lets Escape cancel a valid draft', () => {
    const onChange = vi.fn();
    render(<ColorControl value="#123456" onChange={onChange} placeholder="#ffffff" />);
    const input = screen.getByPlaceholderText('#ffffff');

    fireEvent.change(input, { target: { value: '#nope' } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.blur(input);
    expect(input).toHaveValue('#123456');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '#abcdef' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('#123456');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commits a complete typed color when Enter moves focus away', () => {
    const onChange = vi.fn();
    render(<ColorControl value="#123456" onChange={onChange} placeholder="#ffffff" />);
    const input = screen.getByPlaceholderText('#ffffff');

    input.focus();
    fireEvent.change(input, { target: { value: '#7a003c' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(input).not.toHaveFocus();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('#7a003c');
  });

  it('commits the input value when the final change and Enter share one browser task', () => {
    const onChange = vi.fn();
    render(<ColorControl value="#123456" onChange={onChange} placeholder="#ffffff" />);
    const input = screen.getByPlaceholderText('#ffffff');

    input.focus();
    act(() => {
      fireEvent.change(input, { target: { value: '#7a003c' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(input).not.toHaveFocus();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('#7a003c');
  });

  it('treats Enter as the commit even when blur emits no React event', () => {
    const onChange = vi.fn();
    render(<ColorControl value="#123456" onChange={onChange} placeholder="#ffffff" />);
    const input = screen.getByPlaceholderText('#ffffff');
    const blur = vi.spyOn(input, 'blur').mockImplementation(() => undefined);

    input.focus();
    fireEvent.change(input, { target: { value: '#7a003c' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(blur).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('#7a003c');
  });

  it('commits complete native-picker values immediately and accepts contract color forms', () => {
    const onChange = vi.fn();
    const { container } = render(
      <ColorControl value="#abcd" onChange={onChange} placeholder="#ffffff" />,
    );
    expect(container.querySelector('input[type="color"]')).toHaveValue('#aabbcc');
    fireEvent.change(container.querySelector('input[type="color"]'), {
      target: { value: '#112233' },
    });
    expect(onChange).toHaveBeenCalledWith('#112233');
    expect(['#fff', '#ffff', '#ffffff', '#ffffffff'].every(isSubtitleColor)).toBe(true);
    expect(isSubtitleColor('#gggggg')).toBe(false);
  });
});
