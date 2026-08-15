import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import useAsrOptions from './useAsrOptions';

describe('useAsrOptions language ownership', () => {
  beforeEach(() => localStorage.clear());

  it('replaces a persisted unsupported Qwen language with Auto before use or persistence', async () => {
    localStorage.setItem('asr_qwen3-asr-0.6b_language', 'vi');
    const { result } = renderHook(() => useAsrOptions('qwen3-asr-0.6b'));

    expect(result.current.language).toBe('auto');
    await waitFor(() => {
      expect(localStorage.getItem('asr_qwen3-asr-0.6b_language')).toBe('auto');
    });
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
