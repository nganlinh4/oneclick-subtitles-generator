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
  runNativeGeminiTranscription.mockResolvedValue({ text: '  Hello there.  ', usage: null });
});

it('imports ephemeral audio and transcribes only its opaque native asset', async () => {
  const blob = new Blob(['audio'], { type: 'audio/wav' });

  await expect(transcribeAudio(blob)).resolves.toEqual({
    text: 'Hello there.',
    is_english: true,
    language: 'English',
  });
  expect(importAudioBlob).toHaveBeenCalledWith(blob);
  expect(runNativeGeminiTranscription).toHaveBeenCalledWith({
    assetId: ASSET_ID,
    model: 'gemini-3.5-flash-lite',
    prompt: 'Transcribe this audio. Return ONLY the transcription, no other text.',
  });
  expect(releaseAudioBlob).toHaveBeenCalledWith(ASSET_ID);
  expect(toBase64).not.toHaveBeenCalled();
});

it('returns the legacy no-result shape and still releases the native lease', async () => {
  runNativeGeminiTranscription.mockResolvedValue({ text: '   ', usage: null });

  await expect(transcribeAudio(new Blob(['audio'], { type: 'audio/wav' }))).resolves.toEqual({
    text: '',
    is_english: false,
    language: 'Unknown',
    no_result: true,
  });
  expect(releaseAudioBlob).toHaveBeenCalledWith(ASSET_ID);
});

it('releases the native lease after provider failure without exposing a browser fallback', async () => {
  const failure = new Error('native provider failure');
  runNativeGeminiTranscription.mockRejectedValue(failure);

  await expect(transcribeAudio(new Blob(['audio'], { type: 'audio/wav' }))).rejects.toBe(failure);
  expect(releaseAudioBlob).toHaveBeenCalledWith(ASSET_ID);
  expect(toBase64).not.toHaveBeenCalled();
});

it('does not call native Gemini or release when the bounded import fails', async () => {
  const failure = new Error('invalid recording');
  importAudioBlob.mockRejectedValue(failure);

  await expect(transcribeAudio(new Blob(['audio'], { type: 'audio/wav' }))).rejects.toBe(failure);
  expect(runNativeGeminiTranscription).not.toHaveBeenCalled();
  expect(releaseAudioBlob).not.toHaveBeenCalled();
});
