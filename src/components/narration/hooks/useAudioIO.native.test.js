import { act, renderHook } from '@testing-library/react';

import { importAudioBlob, releaseAudioBlob } from '../../../platform/mediaService';
import { nativeNarrationAdapter } from '../../../platform/nativeNarrationAdapter';
import { transcribeAudio } from '../../../services/transcriptionService';
import useAudioIO from './useAudioIO';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../../platform/mediaService', () => ({
  importAudioBlob: vi.fn(),
  releaseAudioBlob: vi.fn(),
}));
vi.mock('../../../platform/nativeNarrationAdapter', () => ({
  nativeNarrationAdapter: {
    importReference: vi.fn(),
    extractReference: vi.fn(),
    resolvePlayback: vi.fn(),
    releasePlayback: vi.fn(),
  },
}));
vi.mock('../../../services/transcriptionService', () => ({
  transcribeAudio: vi.fn(),
}));

const ASSET_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a1';
const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';

const props = () => ({
  mediaRecorderRef: { current: null },
  audioChunksRef: { current: [] },
  referenceAudio: null,
  referenceText: '',
  setReferenceAudio: vi.fn(),
  setReferenceText: vi.fn(),
  setRecordedAudio: vi.fn(),
  setIsRecording: vi.fn(),
  setIsStartingRecording: vi.fn(),
  setRecordingStartTime: vi.fn(),
  setIsExtractingSegment: vi.fn(),
  setIsRecognizing: vi.fn(),
  setError: vi.fn(),
  autoRecognize: true,
  segmentStartTime: '0',
  segmentEndTime: '1',
  videoPath: 'C:/private/video.mp4',
  onReferenceAudioChange: vi.fn(),
  t: (_key, fallback) => fallback,
  narrationMethod: 'f5tts',
});

describe('native reference audio I/O', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('current_file_url', 'opaque-media');
    localStorage.setItem('current_file_cache_id', 'media-cache');
    importAudioBlob.mockResolvedValue({ assetId: ASSET_ID });
    releaseAudioBlob.mockResolvedValue(true);
    transcribeAudio.mockResolvedValue({ text: 'spoken words', language: 'English' });
    nativeNarrationAdapter.importReference.mockResolvedValue({
      nativeArtifactId: ARTIFACT_ID,
      nativePlaybackId: PLAYBACK_ID,
      audioUrl: `http://127.0.0.1:43210/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`,
      mimeType: 'audio/wav',
      format: 'wav',
      durationMicros: 1_000_000,
    });
  });

  test('imports raw bytes once, stores only artifact metadata, and never calls the legacy server', async () => {
    const state = props();
    const { result } = renderHook(() => useAudioIO(state));
    const file = new File(['audio'], 'reference.wav', { type: 'audio/wav' });
    const event = { target: { files: [file], value: 'reference.wav' } };

    await act(async () => result.current.handleFileUpload(event));

    expect(importAudioBlob).toHaveBeenCalledWith(file);
    expect(nativeNarrationAdapter.importReference).toHaveBeenCalledWith({
      method: 'f5tts',
      assetId: ASSET_ID,
    });
    expect(releaseAudioBlob).toHaveBeenCalledWith(ASSET_ID);
    expect(state.setReferenceAudio).toHaveBeenCalledWith(expect.objectContaining({
      nativeArtifactId: ARTIFACT_ID,
      nativePlaybackId: PLAYBACK_ID,
    }));
    expect(state.setReferenceAudio.mock.calls[0][0]).not.toHaveProperty('filepath');
    expect(state.onReferenceAudioChange).toHaveBeenCalledWith(expect.objectContaining({
      nativeArtifactId: ARTIFACT_ID,
      text: 'spoken words',
    }));
    expect(event.target.value).toBe('');

    const cached = JSON.parse(localStorage.getItem('reference_audio_cache'));
    expect(cached.referenceAudio).toEqual(expect.objectContaining({
      nativeArtifactId: ARTIFACT_ID,
      text: 'spoken words',
    }));
    expect(cached.referenceAudio).not.toHaveProperty('url');
    expect(cached.referenceAudio).not.toHaveProperty('nativePlaybackId');
    expect(cached.referenceAudio).not.toHaveProperty('filepath');
  });
});
