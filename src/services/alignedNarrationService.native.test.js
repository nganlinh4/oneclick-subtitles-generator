import { nativeNarrationAlignmentService as mockAlignment } from '../platform/narrationAlignmentService';
import {
  discardRecoveredNativeJob,
  forgetNativeJobId,
  listRecoveredNativeJobs,
  rememberNativeJobId,
  startNativeJobRecovery,
} from '../platform/jobRecoveryCoordinator';
import {
  generateAlignedNarration,
  resetAlignedNarration,
} from './alignedNarrationService';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockTauriChannel {},
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock('../platform/narrationAlignmentService', () => ({
  nativeNarrationAlignmentService: {
    startAlignmentJob: vi.fn(),
    cancelAlignmentJob: vi.fn(),
    getAlignmentResult: vi.fn(),
    waitForAlignmentResult: vi.fn(),
    resolveAlignmentArtifact: vi.fn(),
    releaseAlignmentPlayback: vi.fn(async () => true),
  },
  normalizeAlignmentRequest: (request) => Object.freeze({
    clips: Object.freeze(request.clips.map((clip) => Object.freeze({ ...clip }))),
  }),
}));

vi.mock('../platform/jobRecoveryCoordinator', () => ({
  discardRecoveredNativeJob: vi.fn(),
  forgetNativeJobId: vi.fn(),
  listRecoveredNativeJobs: vi.fn(),
  rememberNativeJobId: vi.fn(),
  startNativeJobRecovery: vi.fn(),
}));

const JOB_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a1';
const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';

const job = (state = 'running') => ({
  id: JOB_ID,
  kind: 'alignNarration',
  state,
  progress: { basisPoints: state === 'succeeded' ? 10_000 : 0 },
  sequence: state === 'succeeded' ? 2 : 1,
});

const nativeResult = () => ({
  artifact: {
    artifactId: ARTIFACT_ID,
    format: 'm4a',
    bytes: 4_096,
    durationMicros: 1_250_000,
    sampleRateHz: 48_000,
    channels: 2,
  },
  clipCount: 1,
  adjustedCount: 0,
  requestedDurationMicros: 1_000_000,
  naturalDurationMicros: 1_000_000,
  renderedDurationMicros: 1_250_000,
  maximumShiftMicros: 0,
});

const generationResults = () => [{
  subtitle_id: 7,
  success: true,
  text: 'private words never cross alignment IPC',
  nativeArtifactId: ARTIFACT_ID,
  start: 0,
  end: 1,
}];

describe('aligned narration native branch', () => {
  beforeEach(() => {
    window.isTauri = true;
    localStorage.clear();
    mockAlignment.startAlignmentJob.mockReset();
    mockAlignment.cancelAlignmentJob.mockReset();
    mockAlignment.getAlignmentResult.mockReset();
    mockAlignment.waitForAlignmentResult.mockReset();
    mockAlignment.resolveAlignmentArtifact.mockReset();
    mockAlignment.releaseAlignmentPlayback.mockReset();
    mockAlignment.releaseAlignmentPlayback.mockResolvedValue(true);
    startNativeJobRecovery.mockReset();
    startNativeJobRecovery.mockResolvedValue({ recovered: 0 });
    listRecoveredNativeJobs.mockReset();
    listRecoveredNativeJobs.mockReturnValue([]);
    rememberNativeJobId.mockReset();
    forgetNativeJobId.mockReset();
    discardRecoveredNativeJob.mockReset();
    mockAlignment.resolveAlignmentArtifact.mockResolvedValue({
      artifact: nativeResult().artifact,
      playback: {
        id: PLAYBACK_ID,
        playbackUrl: `http://127.0.0.1:43111/asset/${PLAYBACK_ID}?token=${'a'.repeat(64)}`,
        mimeType: 'audio/m4a',
        byteLength: 4_096,
      },
    });
    resetAlignedNarration();
  });

  afterEach(() => {
    resetAlignedNarration();
    delete window.isTauri;
  });

  test('aligns only opaque artifact IDs and caches scoped native playback', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    mockAlignment.getAlignmentResult.mockRejectedValue(new Error('not restored'));
    mockAlignment.startAlignmentJob.mockImplementation(async (request, handlers) => {
      queueMicrotask(() => handlers.onCompleted({
        event: 'completed',
        job: job('succeeded'),
        result: nativeResult(),
      }));
      return job();
    });

    await expect(generateAlignedNarration(generationResults())).resolves.toBe(
      'aligned-preview://timeline',
    );
    const request = mockAlignment.startAlignmentJob.mock.calls[0][0];
    expect(request).toEqual({
      clips: [{
        id: 'segment-1',
        artifactId: ARTIFACT_ID,
        startMicros: 0,
        cueEndMicros: 1_000_000,
      }],
    });
    expect(JSON.stringify(request)).not.toMatch(/path|filename|audioData|private words/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(window.alignedNarrationCache).toMatchObject({
      mode: 'file',
      nativeArtifactId: ARTIFACT_ID,
      nativePlaybackId: PLAYBACK_ID,
      nativeJobId: JOB_ID,
    });
    expect(rememberNativeJobId).toHaveBeenCalledWith(JOB_ID);
    expect(forgetNativeJobId).toHaveBeenCalledWith(JOB_ID);
    expect(localStorage.length).toBe(0);
    fetchSpy.mockRestore();
  });

  test('reconnects to a committed manifest without starting another job', async () => {
    mockAlignment.startAlignmentJob.mockImplementation(async (request, handlers) => {
      queueMicrotask(() => handlers.onCompleted({
        event: 'completed',
        job: job('succeeded'),
        result: nativeResult(),
      }));
      return job();
    });
    await generateAlignedNarration(generationResults());
    mockAlignment.startAlignmentJob.mockClear();
    mockAlignment.getAlignmentResult.mockResolvedValue({
      job: job('succeeded'),
      result: nativeResult(),
    });
    window.alignedNarrationCache = {
      url: null,
      previewPlan: null,
      subtitleTimestamps: {},
    };

    await generateAlignedNarration(generationResults());
    expect(mockAlignment.getAlignmentResult).toHaveBeenCalledWith(JOB_ID);
    expect(mockAlignment.startAlignmentJob).not.toHaveBeenCalled();
    expect(window.alignedNarrationCache.nativeArtifactId).toBe(ARTIFACT_ID);
  });

  test('does not read or resurrect a legacy request-bearing alignment payload', async () => {
    localStorage.setItem('osg.nativeNarrationAlignment.v1', JSON.stringify({
      jobId: JOB_ID,
      request: { clips: [{ path: 'C:\\private\\voice.wav', text: 'private' }] },
    }));
    mockAlignment.startAlignmentJob.mockImplementation(async (_request, handlers) => {
      queueMicrotask(() => handlers.onCompleted({
        event: 'completed',
        job: job('succeeded'),
        result: nativeResult(),
      }));
      return job();
    });
    const getItem = vi.spyOn(Storage.prototype, 'getItem');

    await expect(generateAlignedNarration(generationResults())).resolves.toBe(
      'aligned-preview://timeline',
    );

    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
  });
});
