import { act, renderHook } from '@testing-library/react';
import useBackgroundMusicRecording from './useBackgroundMusicRecording';

const mocks = vi.hoisted(() => ({ trim: vi.fn() }));

vi.mock('../../utils/audioTrim', () => ({ trimSilenceFromBlob: mocks.trim }));

let urlCount = 0;
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  urlCount = 0;
  mocks.trim.mockReset();
  URL.createObjectURL = vi.fn(() => {
    urlCount += 1;
    return `blob:recording-${urlCount}`;
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

const renderRecording = () => {
  const postToPromptDj = vi.fn();
  const view = renderHook(() => useBackgroundMusicRecording({
    getPromptDjWindow: () => window,
    postToPromptDj,
  }));
  return { ...view, postToPromptDj };
};

const wav = (text = 'pcm') => new Blob([text], { type: 'audio/wav' });

test('a stopped recording publishes the trimmed blob and revokes the URL it replaces', async () => {
  const trimmed = wav('trimmed');
  mocks.trim.mockResolvedValue(trimmed);
  const { result } = renderRecording();

  act(() => result.current.onRecordingStarted());
  expect(result.current.isRecording).toBe(true);
  await act(async () => { await result.current.onRecordingStopped(wav()); });
  expect(result.current.isRecording).toBe(false);
  expect(result.current.recordingUrl).toBe('blob:recording-1');
  expect(result.current.recordingBlob).toBe(trimmed);

  await act(async () => { await result.current.onRecordingStopped(wav()); });
  expect(result.current.recordingUrl).toBe('blob:recording-2');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recording-1');
});

test('a failed trim falls back to the raw blob; an unsupported blob is ignored', async () => {
  mocks.trim.mockRejectedValue(new Error('decode failed'));
  const { result } = renderRecording();
  const raw = wav();

  await act(async () => { await result.current.onRecordingStopped(raw); });
  expect(result.current.recordingBlob).toBe(raw);

  await act(async () => {
    await result.current.onRecordingStopped(new Blob(['x'], { type: 'text/plain' }));
  });
  expect(result.current.recordingBlob).toBe(raw);
  expect(mocks.trim).toHaveBeenCalledTimes(1);
});

test('start clears the previous recording and asks PromptDJ to record', async () => {
  mocks.trim.mockResolvedValue(null);
  const { result, postToPromptDj } = renderRecording();
  await act(async () => { await result.current.onRecordingStopped(wav()); });

  act(() => result.current.startRecording());
  expect(result.current.recordingUrl).toBe('');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:recording-1');
  expect(postToPromptDj).toHaveBeenCalledWith({ type: 'pm-dj-start-recording' });

  act(() => result.current.stopRecording());
  expect(postToPromptDj).toHaveBeenCalledWith({ type: 'pm-dj-stop-recording' });
});
