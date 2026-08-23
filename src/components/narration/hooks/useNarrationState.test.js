import { act, renderHook, waitFor } from '@testing-library/react';
import useNarrationState, { normalizeNarrationMethod } from './useNarrationState';

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

it('normalizes unknown persisted narration methods to Gemini', async () => {
  localStorage.setItem('narration_method', 'future-provider');

  const { result } = renderHook(() => useNarrationState());

  expect(result.current.narrationMethod).toBe('gemini');
  await waitFor(() => expect(localStorage.getItem('narration_method')).toBe('gemini'));
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
