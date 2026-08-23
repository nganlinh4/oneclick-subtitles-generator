import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ cacheId: null, listeners: new Set() }));

vi.mock('../../../utils/userSubtitlesStore', () => ({
  getCurrentCacheId: () => store.cacheId,
  subscribeCurrentCacheId: (listener) => {
    store.listeners.add(listener);
    return () => store.listeners.delete(listener);
  },
}));

import { useSrtUploadState } from './srtUploadState';

const publishCache = (cacheId) => {
  store.cacheId = cacheId;
  store.listeners.forEach((listener) => listener(cacheId));
};

beforeEach(() => {
  localStorage.clear();
  store.cacheId = null;
  store.listeners.clear();
});

it('publishes explicit provenance only after the durable import acknowledges it', async () => {
  store.cacheId = 'asset-a';
  let acknowledge;
  const handleSrtUpload = vi.fn(() => new Promise((resolve) => { acknowledge = resolve; }));
  const hook = renderHook(() => useSrtUploadState({
    subtitlesData: null,
    handleSrtUpload,
    handleSrtClear: vi.fn(),
  }));

  let upload;
  act(() => {
    upload = hook.result.current.handleSrtUploadWithState(
      '1\n00:00:00,000 --> 00:00:02,000\nOSG installed media smoke\n',
      'osg-installed-media-smoke.srt',
    );
  });
  expect(hook.result.current.uploadedSrtInfo.hasUploaded).toBe(false);
  expect(localStorage.getItem('uploaded_srt_info')).toBeNull();

  await act(async () => {
    acknowledge({ status: 'accepted', persistence: { cacheId: 'asset-a' } });
    await upload;
  });
  expect(hook.result.current.uploadedSrtInfo).toEqual({
    hasUploaded: true,
    fileName: 'osg-installed-media-smoke.srt',
    source: 'srt',
  });
  expect(JSON.parse(localStorage.getItem('uploaded_srt_info'))).toEqual({
    v: 2,
    cacheId: 'asset-a',
    fileName: 'osg-installed-media-smoke.srt',
  });
});

it('does not publish provenance when parsing or persistence refuses the import', async () => {
  const hook = renderHook(() => useSrtUploadState({
    subtitlesData: null,
    handleSrtUpload: async () => ({ status: 'refused' }),
    handleSrtClear: vi.fn(),
  }));

  await act(async () => {
    await hook.result.current.handleSrtUploadWithState('invalid', 'broken.srt');
  });
  expect(hook.result.current.uploadedSrtInfo.hasUploaded).toBe(false);
  expect(localStorage.getItem('uploaded_srt_info')).toBeNull();
});

it('scopes the upload badge to its exact project alias', async () => {
  store.cacheId = 'asset-a';
  const hook = renderHook(() => useSrtUploadState({
    subtitlesData: [{ id: 1, start: 0, end: 1, text: 'A' }],
    handleSrtUpload: async () => ({ status: 'accepted', persistence: { cacheId: 'asset-a' } }),
    handleSrtClear: vi.fn(),
  }));
  await act(async () => {
    await hook.result.current.handleSrtUploadWithState('content', 'a.srt');
  });
  expect(hook.result.current.uploadedSrtInfo.hasUploaded).toBe(true);

  act(() => publishCache('asset-b'));
  expect(hook.result.current.uploadedSrtInfo.hasUploaded).toBe(false);
  act(() => publishCache('asset-a'));
  expect(hook.result.current.uploadedSrtInfo.fileName).toBe('a.srt');
});

it('waits for the exact durable clear before withdrawing provenance', async () => {
  store.cacheId = 'asset-a';
  let clear;
  const hook = renderHook(() => useSrtUploadState({
    subtitlesData: [{ id: 1, start: 0, end: 1, text: 'A' }],
    handleSrtUpload: async () => ({ status: 'accepted', persistence: { cacheId: 'asset-a' } }),
    handleSrtClear: () => new Promise((resolve) => { clear = resolve; }),
  }));
  await act(async () => {
    await hook.result.current.handleSrtUploadWithState('content', 'a.srt');
  });

  let pending;
  act(() => { pending = hook.result.current.handleSrtClear(); });
  expect(hook.result.current.uploadedSrtInfo.hasUploaded).toBe(true);
  await act(async () => {
    clear({ status: 'cleared', persistence: { cacheId: 'asset-a' } });
    await pending;
  });
  expect(hook.result.current.uploadedSrtInfo.hasUploaded).toBe(false);
  expect(localStorage.getItem('uploaded_srt_info')).toBeNull();
});
