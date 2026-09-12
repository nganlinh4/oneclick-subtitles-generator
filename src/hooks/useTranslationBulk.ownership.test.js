import { act, renderHook } from '@testing-library/react';
import { translateSubtitles } from '../services/geminiService';
import { useTranslationBulk } from './useTranslationBulk';

vi.mock('../services/geminiService', () => ({
  translateSubtitles: vi.fn(),
}));

beforeEach(() => {
  translateSubtitles.mockReset();
});

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

it('keeps native deliveries pending until a durable bulk-file export receipt exists', async () => {
  const acknowledge = vi.fn(async () => {});
  translateSubtitles.mockResolvedValueOnce(Object.freeze({
    status: 'complete',
    rows: Object.freeze([{
      id: 1,
      originalId: 'number:1',
      sourceOrder: 0,
      start: 0,
      end: 1,
      text: 'Bản dịch',
    }]),
    deliveries: Object.freeze([Object.freeze({
      jobId: 'job-1',
      deliveryId: 'delivery-1',
      acknowledge,
    })]),
  }));
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
  }));
  act(() => result.current.setBulkFiles([file]));

  await act(async () => {
    await result.current.handleBulkTranslate(['Vietnamese']);
  });

  expect(result.current.bulkTranslations).toEqual([
    expect.objectContaining({
      success: true,
      delivery: expect.objectContaining({
        state: 'pendingDurableExport',
        pending: [expect.objectContaining({ acknowledge })],
      }),
    }),
  ]);
  expect(result.current.pendingBulkDeliveryCount).toBe(1);
  expect(acknowledge).not.toHaveBeenCalled();
});

it('starts every bulk file concurrently and publishes results in source order', async () => {
  const pending = [];
  translateSubtitles.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const files = ['first.srt', 'second.srt', 'third.srt'].map((name, index) => ({
    id: index + 1,
    name,
    subtitles: [{ id: index + 1, start: index, end: index + 1, text: name }],
  }));
  const { result } = renderHook(() => useTranslationBulk({
    selectedModel: 'gemini-test',
    splitDuration: 0,
    setError: vi.fn(),
    setTranslationStatus: vi.fn(),
    t: (_key, fallback, params) => (
      params ? fallback.replace(/\{\{(\w+)\}\}/g, (_match, key) => params[key]) : fallback
    ),
  }));
  act(() => result.current.setBulkFiles(files));

  let run;
  await act(async () => {
    run = result.current.handleBulkTranslate(['Vietnamese']);
    await vi.waitFor(() => expect(translateSubtitles).toHaveBeenCalledTimes(3));
  });
  const completed = (text) => Object.freeze({
    status: 'complete',
    rows: Object.freeze([{ id: 1, start: 0, end: 1, text }]),
    deliveries: Object.freeze([]),
  });
  await act(async () => {
    pending[2](completed('third'));
    pending[0](completed('first'));
    pending[1](completed('second'));
    await expect(run).resolves.toMatchObject({ status: 'complete' });
  });

  expect(result.current.bulkTranslations.map(({ originalFile }) => originalFile.name))
    .toEqual(['first.srt', 'second.srt', 'third.srt']);
});
