import { act, renderHook } from '@testing-library/react';
import { useTranslationBulk } from './useTranslationBulk';

vi.mock('../services/geminiService', () => ({
  translateSubtitles: vi.fn(),
}));

it('updates the batch source ref and revokes ownership synchronously before React rerenders', () => {
  const onBulkSourceMutation = vi.fn();
  const file = {
    id: 1,
    name: 'batch.srt',
    subtitles: [{ id: 1, start: 0, end: 1, text: 'Batch' }],
  };
  const { result } = renderHook(() => useTranslationBulk({
    selectedModel: 'gemini-test',
    splitDuration: 0,
    setError: vi.fn(),
    setTranslationStatus: vi.fn(),
    t: (_key, fallback) => fallback,
    onBulkSourceMutation,
  }));

  act(() => result.current.setBulkFiles([file]));

  expect(onBulkSourceMutation).toHaveBeenCalledTimes(1);
  expect(result.current.bulkFilesRef.current).toEqual([file]);
  expect(result.current.bulkFiles).toEqual([file]);
  expect(result.current.bulkTranslations).toEqual([]);
});
