import { act, renderHook } from '@testing-library/react';

import useTranscriptionRulesAvailability from './useTranscriptionRulesAvailability';

const store = vi.hoisted(() => ({
  cacheId: 'cache-a',
  rules: null,
}));

vi.mock('../utils/transcriptionRulesStore', () => ({
  getCurrentCacheId: () => store.cacheId,
  getTranscriptionRulesSync: () => store.rules,
}));

beforeEach(() => {
  localStorage.clear();
  store.cacheId = 'cache-a';
  store.rules = null;
});

test('uses the active project store instead of a stale localStorage rules copy', () => {
  localStorage.setItem('transcription_rules', JSON.stringify({ atmosphere: 'stale' }));
  const disable = vi.fn();

  const { result } = renderHook(() => useTranscriptionRulesAvailability(true, disable));

  expect(result.current).toBe(false);
  expect(disable).toHaveBeenCalledWith(false);
});

test('ignores a late rules event from another cache and accepts the active cache snapshot', () => {
  store.rules = { atmosphere: 'active' };
  const disable = vi.fn();
  const { result } = renderHook(() => useTranscriptionRulesAvailability(true, disable));
  expect(result.current).toBe(true);

  act(() => {
    window.dispatchEvent(new CustomEvent('transcriptionRulesUpdated', {
      detail: { cacheId: 'cache-b', projectId: 'project-b', rules: null },
    }));
  });
  expect(result.current).toBe(true);

  act(() => {
    window.dispatchEvent(new CustomEvent('transcriptionRulesUpdated', {
      detail: { cacheId: 'cache-a', projectId: 'project-a', rules: null },
    }));
  });
  expect(result.current).toBe(false);
  expect(disable).toHaveBeenCalledWith(false);
});
