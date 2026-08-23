import { act, renderHook } from '@testing-library/react';

import { importAudioBlob, releaseAudioBlob } from '../../../platform/mediaService';
import { nativeNarrationAdapter } from '../../../platform/nativeNarrationAdapter';
import { getActiveProjectSnapshot } from '../../../platform/projectService';
import { transcribeAudio } from '../../../services/transcriptionService';
import useAudioIO from './useAudioIO';

vi.mock('../../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../../platform/mediaService', () => ({
  importAudioBlob: vi.fn(),
  releaseAudioBlob: vi.fn(),
}));
vi.mock('../../../platform/projectService', () => ({
  getActiveProjectSnapshot: vi.fn(),
}));
vi.mock('../../../platform/nativeNarrationAdapter', () => ({
  nativeNarrationAdapter: {
    getReference: vi.fn(),
    importReference: vi.fn(),
    extractReference: vi.fn(),
    selectReference: vi.fn(),
    commitReference: vi.fn(),
    clearReference: vi.fn(),
    releasePlayback: vi.fn(),
  },
}));
vi.mock('../../../services/transcriptionService', () => ({
  transcribeAudio: vi.fn(),
}));

const ASSET_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a1';
const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const PROJECT_A = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a3';
const PROJECT_B = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';
const JOB_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a5';
const DELIVERY_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a6';
const PLAYBACK_ONE = '550e8400-e29b-41d4-a716-446655440001';
const PLAYBACK_TWO = '550e8400-e29b-41d4-a716-446655440002';

let activeSnapshot;

const snapshot = (projectId = PROJECT_A, stateVersion = 7) => ({
  metadata: { id: projectId },
  stateVersion,
});

const playable = ({
  referenceVersion = 1,
  playbackId = PLAYBACK_ONE,
  text = '',
  language = 'Unknown',
  pendingDelivery = null,
} = {}) => ({
  nativeArtifactId: ARTIFACT_ID,
  nativePlaybackId: playbackId,
  audioUrl: `http://127.0.0.1:43210/asset/${playbackId}`,
  mimeType: 'audio/wav',
  bytes: 4_096,
  format: 'wav',
  durationMicros: 1_000_000,
  projectId: PROJECT_A,
  projectStateVersion: 7,
  referenceVersion,
  text,
  language,
  pendingDelivery,
});

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
  onReferenceAudioChange: vi.fn(),
  t: (_key, fallback) => fallback,
  narrationMethod: 'f5tts',
});

const upload = async (hook) => {
  const file = new File(['audio'], 'reference.wav', { type: 'audio/wav' });
  const event = { target: { files: [file], value: 'reference.wav' } };
  await act(async () => hook.current.handleFileUpload(event));
  return { file, event };
};

describe('native project-owned reference audio I/O', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    activeSnapshot = snapshot();
    getActiveProjectSnapshot.mockImplementation(() => activeSnapshot);
    importAudioBlob.mockResolvedValue({ assetId: ASSET_ID });
    releaseAudioBlob.mockResolvedValue(true);
    nativeNarrationAdapter.releasePlayback.mockResolvedValue(true);
    nativeNarrationAdapter.getReference.mockResolvedValueOnce(null);
    nativeNarrationAdapter.importReference.mockResolvedValue(playable());
  });

  test('commits and re-reads the exact provider delivery before acknowledging or publishing', async () => {
    const acknowledge = vi.fn(async () => undefined);
    const pending = { jobId: JOB_ID, deliveryId: DELIVERY_ID };
    transcribeAudio.mockResolvedValue({
      text: 'spoken words',
      language: 'English',
      delivery: { ...pending, acknowledge },
    });
    nativeNarrationAdapter.commitReference
      .mockResolvedValueOnce({
        referenceVersion: 2,
        transcript: 'spoken words',
        language: 'English',
        pendingDelivery: pending,
      })
      .mockResolvedValueOnce({
        referenceVersion: 3,
        transcript: 'spoken words',
        language: 'English',
        pendingDelivery: null,
      });
    nativeNarrationAdapter.getReference.mockResolvedValueOnce(playable({
      referenceVersion: 2,
      playbackId: PLAYBACK_TWO,
      text: 'spoken words',
      language: 'English',
      pendingDelivery: pending,
    }));
    const state = props();
    const { result } = renderHook(() => useAudioIO(state));

    const { file, event } = await upload(result);

    expect(importAudioBlob).toHaveBeenCalledWith(file);
    expect(nativeNarrationAdapter.importReference).toHaveBeenCalledWith({
      method: 'f5tts',
      assetId: ASSET_ID,
      projectId: PROJECT_A,
      expectedProjectStateVersion: 7,
      expectedReferenceVersion: 0,
    });
    expect(transcribeAudio).toHaveBeenCalledWith(file, {
      projectId: PROJECT_A,
      expectedProjectStateVersion: 7,
    });
    expect(nativeNarrationAdapter.commitReference).toHaveBeenNthCalledWith(1, {
      projectId: PROJECT_A,
      expectedProjectStateVersion: 7,
      expectedReferenceVersion: 1,
      artifactId: ARTIFACT_ID,
      transcript: 'spoken words',
      language: 'English',
      deliveryJobId: JOB_ID,
      deliveryId: DELIVERY_ID,
    });
    expect(nativeNarrationAdapter.getReference).toHaveBeenNthCalledWith(2, PROJECT_A);
    expect(nativeNarrationAdapter.getReference.mock.invocationCallOrder[1])
      .toBeLessThan(acknowledge.mock.invocationCallOrder[0]);
    expect(state.setReferenceAudio).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_A,
      projectStateVersion: 7,
      referenceVersion: 3,
      nativeArtifactId: ARTIFACT_ID,
      nativePlaybackId: PLAYBACK_TWO,
      pendingDelivery: null,
      text: 'spoken words',
    }));
    expect(localStorage.getItem('reference_audio_cache')).toBeNull();
    expect(releaseAudioBlob).toHaveBeenCalledWith(ASSET_ID);
    expect(event.target.value).toBe('');
  });

  test('does not commit, acknowledge, or publish when project A switches to B during transcription', async () => {
    const acknowledge = vi.fn(async () => undefined);
    transcribeAudio.mockImplementation(async () => {
      activeSnapshot = snapshot(PROJECT_B, 2);
      return {
        text: 'late words',
        language: 'English',
        delivery: { jobId: JOB_ID, deliveryId: DELIVERY_ID, acknowledge },
      };
    });
    const state = props();
    const { result } = renderHook(() => useAudioIO(state));

    await upload(result);

    expect(nativeNarrationAdapter.commitReference).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(state.setReferenceAudio).not.toHaveBeenCalled();
    expect(nativeNarrationAdapter.releasePlayback).toHaveBeenCalledWith(
      expect.objectContaining({ nativeArtifactId: ARTIFACT_ID }),
    );
  });

  test('keeps a committed provider delivery retryable when acknowledgement is lost', async () => {
    const acknowledge = vi.fn(async () => { throw new Error('transport lost'); });
    const pending = { jobId: JOB_ID, deliveryId: DELIVERY_ID };
    transcribeAudio.mockResolvedValue({
      text: 'durable words',
      language: 'English',
      delivery: { ...pending, acknowledge },
    });
    nativeNarrationAdapter.commitReference.mockResolvedValueOnce({
      referenceVersion: 2,
      transcript: 'durable words',
      language: 'English',
      pendingDelivery: pending,
    });
    nativeNarrationAdapter.getReference.mockResolvedValueOnce(playable({
      referenceVersion: 2,
      playbackId: PLAYBACK_TWO,
      text: 'durable words',
      language: 'English',
      pendingDelivery: pending,
    }));
    const state = props();
    const { result } = renderHook(() => useAudioIO(state));

    await upload(result);

    expect(nativeNarrationAdapter.commitReference).toHaveBeenCalledTimes(1);
    expect(state.setReferenceAudio).toHaveBeenCalledWith(expect.objectContaining({
      referenceVersion: 2,
      pendingDelivery: pending,
      text: 'durable words',
    }));
    expect(state.setError).not.toHaveBeenCalledWith('transport lost');
  });

  test('never acknowledges or publishes when the project-owned record write fails', async () => {
    const acknowledge = vi.fn(async () => undefined);
    transcribeAudio.mockResolvedValue({
      text: 'uncommitted words',
      language: 'English',
      delivery: { jobId: JOB_ID, deliveryId: DELIVERY_ID, acknowledge },
    });
    nativeNarrationAdapter.commitReference.mockRejectedValue(new Error('sqlite write failed'));
    const state = props();
    const { result } = renderHook(() => useAudioIO(state));

    await upload(result);

    expect(acknowledge).not.toHaveBeenCalled();
    expect(state.setReferenceAudio).not.toHaveBeenCalled();
    expect(state.setError).toHaveBeenCalledWith('sqlite write failed');
    expect(nativeNarrationAdapter.releasePlayback).toHaveBeenCalled();
  });
});
