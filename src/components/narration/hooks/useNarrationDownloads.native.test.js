import { act, renderHook } from '@testing-library/react';

import {
  downloadNativeNarrations,
  resolveNativeNarrationPlayback,
} from '../../../platform/nativeNarrationArtifacts';
import useNarrationDownloads from './useNarrationDownloads';

vi.mock('../../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../../platform/nativeNarrationArtifacts', () => ({
  downloadNativeNarrations: vi.fn(),
  resolveNativeNarrationPlayback: vi.fn(),
}));
vi.mock('../utils/loadingOverlayFactory', () => ({
  createLoadingOverlay: () => ({ destroy: vi.fn() }),
}));

const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const narration = {
  subtitle_id: 1,
  success: true,
  nativeArtifactId: ARTIFACT_ID,
  filename: `osg-speech-artifact:${ARTIFACT_ID}`,
};

test('shared narration playback and bulk download use native capabilities only', async () => {
  const originalFetch = global.fetch;
  global.fetch = vi.fn();
  resolveNativeNarrationPlayback.mockResolvedValue({
    nativePlaybackId: PLAYBACK_ID,
    audioUrl: `http://127.0.0.1:43210/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`,
  });
  downloadNativeNarrations.mockResolvedValue(undefined);
  const setCurrentAudio = vi.fn();
  const setIsPlaying = vi.fn();
  const { result } = renderHook(() => useNarrationDownloads({
    generationResults: [narration],
    currentAudio: null,
    setCurrentAudio,
    isPlaying: false,
    setIsPlaying,
    t: (_key, fallback) => fallback,
  }));

  await act(async () => result.current.playAudio(narration));
  expect(resolveNativeNarrationPlayback).toHaveBeenCalledWith(narration);
  expect(setCurrentAudio).toHaveBeenLastCalledWith(expect.objectContaining({
    id: 1,
    nativePlaybackId: PLAYBACK_ID,
  }));
  await act(async () => result.current.downloadAllAudio());
  expect(downloadNativeNarrations).toHaveBeenCalledWith([narration]);
  expect(global.fetch).not.toHaveBeenCalled();
  global.fetch = originalFetch;
});
