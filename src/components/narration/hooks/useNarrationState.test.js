import { act, renderHook } from '@testing-library/react';
import useNarrationState, { normalizeNarrationMethod } from './useNarrationState';

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it('normalizes unknown persisted narration methods to Gemini', async () => {
  localStorage.setItem('narration_method', 'future-provider');

  const { result } = renderHook(() => useNarrationState());

  expect(result.current.narrationMethod).toBe('gemini');
  // Reading a fallback is not a user choice, so nothing is written back.
  expect(localStorage.getItem('narration_method')).toBe('future-provider');
});

it('persists explicit engine choices through the preference store', () => {
  const { result } = renderHook(() => useNarrationState());

  act(() => {
    result.current.setNarrationMethod('edge-tts');
    result.current.setConcurrentClients(7);
    result.current.setSelectedNarrationModel(null);
  });

  expect(result.current.narrationMethod).toBe('edge-tts');
  expect(localStorage.getItem('narration_method')).toBe('edge-tts');
  expect(localStorage.getItem('gemini_concurrent_clients')).toBe('7');
  expect(result.current.selectedNarrationModel).toBeNull();
});

it('rejects unknown narration methods passed to the state setter', () => {
  const { result } = renderHook(() => useNarrationState());

  act(() => result.current.setNarrationMethod('removed-provider'));

  expect(result.current.narrationMethod).toBe('gemini');
  expect(normalizeNarrationMethod('edge-tts')).toBe('edge-tts');
});

it('does not carry a project-dependent subtitle source through browser-global storage', () => {
  localStorage.setItem('subtitle_source', 'translated');

  const { result } = renderHook(() => useNarrationState());

  expect(result.current.subtitleSource).toBe('original');
});
