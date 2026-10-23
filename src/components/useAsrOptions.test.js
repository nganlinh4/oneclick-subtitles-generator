import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import useAsrOptions from './useAsrOptions';

describe('useAsrOptions language ownership', () => {
  beforeEach(() => localStorage.clear());

  it('uses Auto for a persisted unsupported Qwen language without rewriting the stored choice', () => {
    localStorage.setItem('asr_qwen3-asr-0.6b_language', 'vi');
    const { result } = renderHook(() => useAsrOptions('qwen3-asr-0.6b'));

    expect(result.current.language).toBe('auto');
    expect(localStorage.getItem('asr_qwen3-asr-0.6b_language')).toBe('vi');
  });

  it('stores user changes per engine and seeds Parakeet from its legacy keys', () => {
    localStorage.setItem('parakeet_max_chars', '42');
    const { result } = renderHook(() => useAsrOptions('nvidia-parakeet'));
    expect(result.current.maxChars).toBe(42);
    expect(localStorage.getItem('asr_nvidia-parakeet_max_chars')).toBeNull();

    act(() => result.current.setMaxWords(9));
    expect(result.current.maxWords).toBe(9);
    expect(localStorage.getItem('asr_nvidia-parakeet_max_words')).toBe('9');
  });

  it('normalizes setter values against the active engine rather than the previous engine', () => {
    const { result, rerender } = renderHook(
      ({ engine }) => useAsrOptions(engine),
      { initialProps: { engine: 'faster-whisper-turbo' } }
    );
    act(() => result.current.setLanguage('vi'));
    expect(result.current.language).toBe('vi');

    rerender({ engine: 'qwen3-asr-1.7b' });
    expect(result.current.language).toBe('auto');
    act(() => result.current.setLanguage('KO'));
    expect(result.current.language).toBe('ko');
    act(() => result.current.setLanguage('vi'));
    expect(result.current.language).toBe('auto');
  });

  it('never forwards a forced language for Parakeet', () => {
    localStorage.setItem('asr_nvidia-parakeet_language', 'en');
    const { result } = renderHook(() => useAsrOptions('nvidia-parakeet'));
    expect(result.current.language).toBe('auto');
  });
});
