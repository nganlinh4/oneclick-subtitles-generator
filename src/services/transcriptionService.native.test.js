import { toBase64 } from '../utils/fileUtils';
import { importAudioBlob, releaseAudioBlob } from '../platform/mediaService';
import { runNativeGeminiTranscription } from '../platform/nativeGeminiTranscription';
import { transcribeAudio } from './transcriptionService';

vi.mock('../utils/fileUtils', () => ({ toBase64: vi.fn() }));
vi.mock('../platform/mediaService', () => ({
  importAudioBlob: vi.fn(),
  releaseAudioBlob: vi.fn(),
}));
vi.mock('../platform/nativeGeminiTranscription', () => ({
  runNativeGeminiTranscription: vi.fn(),
}));

const ASSET_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const PROJECT_ID = '01890f39-7b62-7c4e-8c9a-000000000102';
const JOB_ID = '01890f39-7b62-7c4e-8c9a-000000000103';
const DELIVERY_ID = '01890f39-7b62-7c4e-8c9a-000000000104';
const PROJECT_AUTHORITY = Object.freeze({
  projectId: PROJECT_ID,
  expectedProjectStateVersion: 7,
});

beforeEach(() => {
  vi.clearAllMocks();
  importAudioBlob.mockResolvedValue(Object.freeze({
    __nativeAudioBlob: true,
    assetId: ASSET_ID,
    name: 'recording.wav',
    type: 'audio/wav',
    size: 5,
  }));
  releaseAudioBlob.mockResolvedValue(true);
  runNativeGeminiTranscription.mockResolvedValue({
    text: '  Hello there.  ',
    usage: null,
    job: { id: JOB_ID },
    deliveryId: DELIVERY_ID,
    acknowledge: vi.fn(async () => undefined),
  });
});

it('imports ephemeral audio and transcribes only its opaque native asset', async () => {
  const blob = new Blob(['audio'], { type: 'audio/wav' });

  await expect(transcribeAudio(blob, PROJECT_AUTHORITY)).resolves.toEqual({
    text: 'Hello there.',
    is_english: true,
    language: 'English',
    delivery: {
      jobId: JOB_ID,
      deliveryId: DELIVERY_ID,
      acknowledge: expect.any(Function),
    },
  });
  expect(importAudioBlob).toHaveBeenCalledWith(blob);
  expect(runNativeGeminiTranscription).toHaveBeenCalledWith({
    assetId: ASSET_ID,
    model: 'gemini-3.1-flash-lite',
    prompt: 'Transcribe this audio. Return ONLY the transcription, no other text.',
    projectId: PROJECT_ID,
    expectedProjectStateVersion: 7,
  });
  expect(releaseAudioBlob).toHaveBeenCalledWith(ASSET_ID);
  expect(toBase64).not.toHaveBeenCalled();
});

it('returns the legacy no-result shape and still releases the native lease', async () => {
  runNativeGeminiTranscription.mockResolvedValue({
    text: '   ',
    usage: null,
    job: { id: JOB_ID },
    deliveryId: DELIVERY_ID,
    acknowledge: vi.fn(async () => undefined),
  });

  await expect(transcribeAudio(
    new Blob(['audio'], { type: 'audio/wav' }),
    PROJECT_AUTHORITY,
  )).resolves.toEqual({
    text: '',
    is_english: false,
    language: 'Unknown',
    no_result: true,
    delivery: {
      jobId: JOB_ID,
      deliveryId: DELIVERY_ID,
      acknowledge: expect.any(Function),
    },
  });
  expect(releaseAudioBlob).toHaveBeenCalledWith(ASSET_ID);
});

it('releases the native lease after provider failure without exposing a browser fallback', async () => {
  const failure = new Error('native provider failure');
  runNativeGeminiTranscription.mockRejectedValue(failure);

  await expect(transcribeAudio(
    new Blob(['audio'], { type: 'audio/wav' }),
    PROJECT_AUTHORITY,
  )).rejects.toBe(failure);
  expect(releaseAudioBlob).toHaveBeenCalledWith(ASSET_ID);
  expect(toBase64).not.toHaveBeenCalled();
});

it('does not call native Gemini or release when the bounded import fails', async () => {
  const failure = new Error('invalid recording');
  importAudioBlob.mockRejectedValue(failure);

  await expect(transcribeAudio(
    new Blob(['audio'], { type: 'audio/wav' }),
    PROJECT_AUTHORITY,
  )).rejects.toBe(failure);
  expect(runNativeGeminiTranscription).not.toHaveBeenCalled();
  expect(releaseAudioBlob).not.toHaveBeenCalled();
});

it('refuses missing project authority before importing any browser bytes', async () => {
  await expect(transcribeAudio(new Blob(['audio'], { type: 'audio/wav' })))
    .rejects.toMatchObject({ code: 'referenceProjectUnavailable' });
  expect(importAudioBlob).not.toHaveBeenCalled();
  expect(runNativeGeminiTranscription).not.toHaveBeenCalled();
});

it('refuses a provider response whose durable delivery capability is missing', async () => {
  runNativeGeminiTranscription.mockResolvedValue({ text: 'unsafe', usage: null });

  await expect(transcribeAudio(
    new Blob(['audio'], { type: 'audio/wav' }),
    PROJECT_AUTHORITY,
  )).rejects.toMatchObject({ code: 'invalidReferenceTranscription' });
  expect(releaseAudioBlob).toHaveBeenCalledWith(ASSET_ID);
});
