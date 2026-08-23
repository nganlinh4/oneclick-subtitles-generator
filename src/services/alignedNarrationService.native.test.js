import { nativeNarrationAlignmentService as mockAlignment } from '../platform/narrationAlignmentService';
import {
  discardRecoveredNativeJob,
  ensureNativeJobRecoveryReady,
  forgetNativeJobId,
  listRecoveredNativeJobs,
  rememberNativeJobId,
  startNativeJobRecovery,
} from '../platform/jobRecoveryCoordinator';
import {
  generateAlignedNarration,
  getAlignedNarrationArtifactIdForPlan,
  getAlignedNarrationUrlForPlan,
  resetAlignedNarration,
} from './alignedNarrationService';
import { buildStrictNativeNarrationPlan } from '../utils/narrationAlignmentUtils';

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
    projectId: request.projectId,
    expectedProjectStateVersion: request.expectedProjectStateVersion,
    clips: Object.freeze(request.clips.map((clip) => Object.freeze({ ...clip }))),
  }),
}));

vi.mock('../platform/durableLyricsCheckpoint', () => ({
  flushDurableLyricsHistory: vi.fn(async () => undefined),
}));

vi.mock('../platform/projectService', () => ({
  getActiveProjectSnapshot: vi.fn(() => ({
    metadata: { id: '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4' },
    stateVersion: 7,
  })),
}));

vi.mock('../platform/jobRecoveryCoordinator', () => ({
  discardRecoveredNativeJob: vi.fn(),
  ensureNativeJobRecoveryReady: vi.fn(),
  forgetNativeJobId: vi.fn(),
  listRecoveredNativeJobs: vi.fn(),
  rememberNativeJobId: vi.fn(),
  startNativeJobRecovery: vi.fn(),
}));

const JOB_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a1';
const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';
const PLAYBACK_ID = '550e8400-e29b-41d4-a716-446655440000';
const PROJECT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';

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
  projectId: PROJECT_ID,
  projectStateVersion: 6,
  start: 0,
  end: 1,
}];

const currentCues = () => [{
  id: 7,
  text: 'private words never cross alignment IPC',
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
    ensureNativeJobRecoveryReady.mockReset();
    ensureNativeJobRecoveryReady.mockResolvedValue({ unavailable: false });
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

    await expect(generateAlignedNarration(generationResults(), currentCues())).resolves.toBe(
      'aligned-preview://timeline',
    );
    const request = mockAlignment.startAlignmentJob.mock.calls[0][0];
    expect(request).toEqual({
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
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
    const plan = buildStrictNativeNarrationPlan(generationResults(), currentCues());
    expect(getAlignedNarrationArtifactIdForPlan(plan)).toBe(ARTIFACT_ID);
    expect(getAlignedNarrationUrlForPlan(plan)).toContain(`/asset/${PLAYBACK_ID}`);
    const retimed = buildStrictNativeNarrationPlan(generationResults(), [{
      ...currentCues()[0],
      end: 1.5,
    }]);
    expect(getAlignedNarrationArtifactIdForPlan(retimed)).toBeNull();
    expect(getAlignedNarrationUrlForPlan(retimed)).toBeNull();
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
    await generateAlignedNarration(generationResults(), currentCues());
    mockAlignment.startAlignmentJob.mockClear();
    mockAlignment.getAlignmentResult.mockResolvedValue({
      job: job('succeeded'),
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      result: nativeResult(),
    });
    window.alignedNarrationCache = {
      url: null,
      previewPlan: null,
      subtitleTimestamps: {},
    };

    await generateAlignedNarration(generationResults(), currentCues());
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

    await expect(generateAlignedNarration(generationResults(), currentCues())).resolves.toBe(
      'aligned-preview://timeline',
    );

    expect(getItem).not.toHaveBeenCalled();
    getItem.mockRestore();
  });

  test('propagates an incomplete current plan before a native job can start', async () => {
    await expect(generateAlignedNarration(generationResults(), [
      ...currentCues(),
      { id: 8, text: 'missing audio', start: 1, end: 2 },
    ])).rejects.toMatchObject({ code: 'narrationPlanIncomplete' });
    expect(mockAlignment.startAlignmentJob).not.toHaveBeenCalled();
  });

  test('fails closed before admission when recovery is unavailable', async () => {
    ensureNativeJobRecoveryReady.mockRejectedValue(Object.assign(
      new Error('recovery unavailable'),
      { code: 'nativeJobRecoveryUnavailable', retryable: true },
    ));

    await expect(generateAlignedNarration(generationResults(), currentCues())).rejects
      .toMatchObject({ code: 'nativeJobRecoveryUnavailable', retryable: true });
    expect(mockAlignment.startAlignmentJob).not.toHaveBeenCalled();
  });

  test('retains an unmatched active recovery when cancellation transport is unavailable', async () => {
    listRecoveredNativeJobs.mockReturnValue([{ job: job('running') }]);
    mockAlignment.cancelAlignmentJob.mockRejectedValue(new Error('transport closed'));

    await expect(generateAlignedNarration(generationResults(), currentCues())).rejects
      .toMatchObject({ code: 'alignmentRecoveryUnavailable', retryable: true });
    expect(discardRecoveredNativeJob).not.toHaveBeenCalled();
    expect(mockAlignment.startAlignmentJob).not.toHaveBeenCalled();
  });

  test('retains a matching alignment across a transport failure and retries it', async () => {
    mockAlignment.startAlignmentJob.mockImplementation(async (_request, handlers) => {
      queueMicrotask(() => handlers.onCompleted({
        event: 'completed',
        job: job('succeeded'),
        result: nativeResult(),
      }));
      return job();
    });
    await generateAlignedNarration(generationResults(), currentCues());
    mockAlignment.startAlignmentJob.mockClear();
    mockAlignment.getAlignmentResult
      .mockRejectedValueOnce(new Error('transport closed'))
      .mockResolvedValueOnce({
        job: job('succeeded'),
        projectId: PROJECT_ID,
        expectedProjectStateVersion: 7,
        result: nativeResult(),
      });

    await expect(generateAlignedNarration(generationResults(), currentCues())).rejects
      .toMatchObject({ code: 'alignmentRecoveryUnavailable', retryable: true });
    await expect(generateAlignedNarration(generationResults(), currentCues())).resolves
      .toBe('aligned-preview://timeline');
    expect(mockAlignment.startAlignmentJob).not.toHaveBeenCalled();
    expect(mockAlignment.getAlignmentResult).toHaveBeenCalledTimes(2);
  });

  test('forgets a definitively terminal alignment and admits one replacement', async () => {
    mockAlignment.startAlignmentJob.mockImplementation(async (_request, handlers) => {
      queueMicrotask(() => handlers.onCompleted({
        event: 'completed',
        job: job('succeeded'),
        result: nativeResult(),
      }));
      return job();
    });
    await generateAlignedNarration(generationResults(), currentCues());
    mockAlignment.getAlignmentResult.mockResolvedValue({
      job: job('running'),
      projectId: PROJECT_ID,
      expectedProjectStateVersion: 7,
      result: null,
    });
    mockAlignment.waitForAlignmentResult.mockRejectedValue(Object.assign(
      new Error('terminal without artifact'),
      { code: 'alignmentUnavailable' },
    ));

    await expect(generateAlignedNarration(generationResults(), currentCues())).resolves
      .toBe('aligned-preview://timeline');
    expect(mockAlignment.startAlignmentJob).toHaveBeenCalledTimes(2);
  });
});
