import { getProjectNarration, putProjectNarration } from './speechService';
import { loadProjectNarration, saveProjectNarration } from './projectNarrationStore';

vi.mock('./speechService', () => ({
  getProjectNarration: vi.fn(),
  putProjectNarration: vi.fn(),
}));

const PROJECT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a4';
const ARTIFACT_ID = '018f4c22-f0f1-7c09-a4d5-120d7b6f84a2';

const storedResult = Object.freeze({
  subtitleId: 7,
  text: 'durable narration',
  artifact: Object.freeze({
    artifactId: ARTIFACT_ID,
    format: 'wav',
    bytes: 4_096,
    durationMicros: 1_250_000,
    sampleRateHz: 24_000,
    channels: 1,
  }),
  method: 'gtts',
  outputIndex: 0,
  originalIds: Object.freeze([7]),
  startMicros: 250_000,
  endMicros: 1_500_000,
});

beforeEach(() => {
  vi.clearAllMocks();
  putProjectNarration.mockImplementation(async (request) => ({
    schemaVersion: 1,
    projectId: request.projectId,
    projectStateVersion: request.expectedProjectStateVersion,
    source: request.source,
    results: request.results.map((result) => ({
      ...result,
      artifact: storedResult.artifact,
    })),
  }));
});

test('persists only native successful results with fixed-point project authority', async () => {
  const saved = await saveProjectNarration({
    projectId: PROJECT_ID,
    expectedProjectStateVersion: 9,
    source: 'translated',
    method: 'gtts',
    results: [{
      subtitle_id: 7,
      text: 'durable narration',
      success: true,
      nativeArtifactId: ARTIFACT_ID,
      method: 'gtts',
      outputIndex: 0,
      original_ids: [7],
      start: 0.25,
      end: 1.5,
      audioData: 'must-not-persist',
      audioUrl: 'http://127.0.0.1/private-token',
    }, {
      subtitle_id: 8,
      text: 'failed row',
      success: false,
      start: 2,
      end: 3,
    }],
  });

  expect(putProjectNarration).toHaveBeenCalledWith({
    projectId: PROJECT_ID,
    expectedProjectStateVersion: 9,
    source: 'translated',
    results: [{
      subtitleId: 7,
      text: 'durable narration',
      artifactId: ARTIFACT_ID,
      method: 'gtts',
      outputIndex: 0,
      originalIds: [7],
      startMicros: 250_000,
      endMicros: 1_500_000,
    }],
  });
  expect(JSON.stringify(putProjectNarration.mock.calls)).not.toMatch(
    /(?:audioData|audioUrl|127\.0\.0\.1|private-token)/u
  );
  expect(saved).toMatchObject({
    projectId: PROJECT_ID,
    projectStateVersion: 9,
    source: 'translated',
    results: [{
      subtitle_id: 7,
      nativeArtifactId: ARTIFACT_ID,
      filename: `osg-speech-artifact:${ARTIFACT_ID}`,
      projectId: PROJECT_ID,
      projectStateVersion: 9,
      start: 0.25,
      end: 1.5,
    }],
  });
});

test('restores a native record and never invents browser audio state', async () => {
  getProjectNarration.mockResolvedValue({
    schemaVersion: 1,
    projectId: PROJECT_ID,
    projectStateVersion: 11,
    source: 'grouped',
    results: [storedResult],
  });

  const loaded = await loadProjectNarration(PROJECT_ID);

  expect(getProjectNarration).toHaveBeenCalledWith(PROJECT_ID);
  expect(loaded).toMatchObject({
    projectId: PROJECT_ID,
    projectStateVersion: 11,
    source: 'grouped',
    results: [{
      subtitle_id: 7,
      nativeArtifactId: ARTIFACT_ID,
      audioData: null,
      method: 'gtts',
      original_ids: [7],
    }],
  });
  expect(loaded.results[0]).not.toHaveProperty('audioUrl');
});

test('fails closed for results that cannot be restored exactly', async () => {
  const base = {
    subtitle_id: 7,
    text: 'durable narration',
    success: true,
    nativeArtifactId: ARTIFACT_ID,
    method: 'gtts',
    original_ids: [7],
    start: 0,
    end: 1,
  };
  await expect(saveProjectNarration({
    projectId: PROJECT_ID,
    expectedProjectStateVersion: 1,
    source: 'original',
    method: 'gtts',
    results: [{ ...base, nativeArtifactId: null }],
  })).rejects.toThrow('durably restorable');
  await expect(saveProjectNarration({
    projectId: PROJECT_ID,
    expectedProjectStateVersion: 1,
    source: 'original',
    method: 'gtts',
    results: [{ ...base, end: 0 }],
  })).rejects.toThrow('durably restorable');
  expect(putProjectNarration).not.toHaveBeenCalled();
});

test('stores an empty native record to clear obsolete successful narration', async () => {
  await saveProjectNarration({
    projectId: PROJECT_ID,
    expectedProjectStateVersion: 12,
    source: 'original',
    method: 'gtts',
    results: [{ subtitle_id: 1, text: 'failed', success: false }],
  });
  expect(putProjectNarration).toHaveBeenCalledWith(expect.objectContaining({ results: [] }));

  getProjectNarration.mockResolvedValue(null);
  await expect(loadProjectNarration(PROJECT_ID)).resolves.toBeNull();
});
