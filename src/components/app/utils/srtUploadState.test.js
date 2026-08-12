import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { useSrtUploadState } from './srtUploadState';

beforeEach(() => localStorage.clear());

it('keeps explicit one-cue SRT provenance while native tools and media download', () => {
  let props = {
    subtitlesData: null,
    setSubtitlesData: vi.fn(),
    status: null,
    isSrtOnlyMode: false,
    isGenerating: false,
    handleSrtUpload: vi.fn(),
    handleUserSubtitlesAdd: vi.fn(),
  };
  const hook = renderHook(() => useSrtUploadState(props));

  act(() => hook.result.current.handleSrtUploadWithState(
    '1\n00:00:00,000 --> 00:00:02,000\nOSG installed media smoke\n',
    'osg-installed-media-smoke.srt',
  ));
  props = {
    ...props,
    subtitlesData: [{ id: 1, start: 0, end: 2, text: 'OSG installed media smoke' }],
    status: { type: 'loading', message: 'Downloading video...' },
  };
  hook.rerender();

  expect(hook.result.current.uploadedSrtInfo).toEqual({
    hasUploaded: true,
    fileName: 'osg-installed-media-smoke.srt',
    source: 'srt',
  });
  expect(JSON.parse(localStorage.getItem('uploaded_srt_info'))).toEqual({
    hasUploaded: true,
    fileName: 'osg-installed-media-smoke.srt',
    source: 'srt',
  });
});
