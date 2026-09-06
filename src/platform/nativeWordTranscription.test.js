import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import {
  startWordNativeTranscription,
  cancelWordNativeTranscription,
  isNativeWordTranscriptionSupported,
} from './nativeWordTranscription';
import { invokeDesktop } from './desktopRuntime';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  isDesktopRuntime: vi.fn(() => false),
}));

vi.mock('@tauri-apps/api/core', () => {
  return {
    Channel: class MockChannel {
      constructor() {
        this.onmessage = null;
      }
    },
  };
});

describe('nativeWordTranscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects desktop runtime capability correctly', () => {
    expect(isNativeWordTranscriptionSupported()).toBe(false);
  });

  it('invokes start_word_native_transcription with normalized request and wires event channel', async () => {
    const projectId = uuidv7();
    const mediaAssetId = uuidv7();
    const snapshot = {
      id: uuidv7(),
      kind: 'transcribe',
      state: 'running',
    };

    invokeDesktop.mockResolvedValue(snapshot);

    const onStageChanged = vi.fn();
    const onWindowPromoted = vi.fn();
    const onCompleted = vi.fn();

    const request = {
      projectId,
      expectedProjectStateVersion: 3,
      mediaAssetId,
      rangeStartMs: 0,
      rangeEndMs: 60000,
      windowDurationMs: 60000,
      languageHints: ['en'],
      diarization: true,
    };

    const result = await startWordNativeTranscription(request, {
      onStageChanged,
      onWindowPromoted,
      onCompleted,
    });

    expect(result).toBe(snapshot);
    expect(invokeDesktop).toHaveBeenCalledTimes(1);
    expect(invokeDesktop).toHaveBeenCalledWith('start_word_native_transcription', {
      request: expect.objectContaining({
        projectId,
        expectedProjectStateVersion: 3,
        mediaAssetId,
        rangeStartMs: 0,
        rangeEndMs: 60000,
        windowDurationMs: 60000,
        languageHints: ['en'],
        diarization: true,
      }),
      onEvent: expect.any(Object),
    });

    // Simulate events on the channel
    const channel = invokeDesktop.mock.calls[0][1].onEvent;
    channel.onmessage({
      event: 'stageChanged',
      stage: 'transcribing_window_1',
      message: 'Transcribing',
    });
    expect(onStageChanged).toHaveBeenCalledWith(expect.objectContaining({
      event: 'stageChanged',
      stage: 'transcribing_window_1',
    }));

    channel.onmessage({
      event: 'windowPromoted',
      windowIndex: 0,
      totalWindows: 1,
      projectedCues: [{ id: 'cue-1', startMs: 100, endMs: 500, text: 'Hi' }],
    });
    expect(onWindowPromoted).toHaveBeenCalledWith(expect.objectContaining({
      event: 'windowPromoted',
      windowIndex: 0,
    }));

    channel.onmessage({
      event: 'completed',
      totalWindows: 1,
    });
    expect(onCompleted).toHaveBeenCalledWith(expect.objectContaining({
      event: 'completed',
      totalWindows: 1,
    }));
  });

  it('invokes cancel_transcription with taskId', async () => {
    const taskId = uuidv7();
    const snapshot = {
      id: taskId,
      kind: 'transcribe',
      state: 'cancelling',
    };

    invokeDesktop.mockResolvedValue(snapshot);

    const result = await cancelWordNativeTranscription(taskId);
    expect(result).toBe(snapshot);
    expect(invokeDesktop).toHaveBeenCalledTimes(1);
    expect(invokeDesktop).toHaveBeenCalledWith('cancel_transcription', {
      taskId,
      jobId: taskId,
    });
  });

  it('rejects immediately when projectId is missing without invoking desktop', async () => {
    await expect(startWordNativeTranscription({ mediaAssetId: 'media-1' }))
      .rejects.toThrow(/established active project ID/i);
    expect(invokeDesktop).not.toHaveBeenCalled();
  });
});
