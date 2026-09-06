import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processGeminiSegment } from './GeminiAdapter';
import {
  startWordNativeTranscription,
  cancelWordNativeTranscription,
  isNativeWordTranscriptionSupported,
} from '../../platform/nativeWordTranscription';

vi.mock('../../platform/nativeWordTranscription', () => ({
  startWordNativeTranscription: vi.fn(),
  cancelWordNativeTranscription: vi.fn().mockResolvedValue({ id: 'cancelled' }),
  isNativeWordTranscriptionSupported: vi.fn(() => true),
}));

vi.mock('../../utils/videoProcessing/processingUtils', () => ({
  processSegmentWithStreaming: vi.fn(),
}));

const media = Object.freeze({
  assetId: '01890f39-7b62-7c4e-8c9a-000000000101',
  name: 'source.mp4',
  type: 'video/mp4',
});

describe('GeminiAdapter on Native Desktop Runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes speech transcription directly to native word-native transcription engine', async () => {
    startWordNativeTranscription.mockImplementation(async (request, handlers) => {
      // Simulate asynchronous events
      setTimeout(() => {
        handlers.onStageChanged?.({ stage: 'transcribing', message: 'Transcribing...' });
        handlers.onWindowPromoted?.({
          windowIndex: 0,
          totalWindows: 1,
          projectedCues: [
            { id: 'cue-1', startMs: 1000, endMs: 2500, text: 'Hello world', speakerId: 'w0:1' },
          ],
        });
        handlers.onCompleted?.({
          totalWindows: 1,
          totalWords: 2,
          projectedCues: [
            { id: 'cue-1', startMs: 1000, endMs: 2500, text: 'Hello world', speakerId: 'w0:1' },
          ],
        });
      }, 10);
      return { id: 'job-123' };
    });

    const onStatus = vi.fn();
    const onStreamingUpdate = vi.fn();

    const result = await processGeminiSegment(
      media,
      { start: 0, end: 60 },
      { maxDurationPerRequest: 60 },
      { onStatus, onStreamingUpdate },
    );

    expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);
    expect(startWordNativeTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaAssetId: media.assetId,
        rangeStartMs: 0,
        rangeEndMs: 60000,
        windowDurationMs: 60000,
      }),
      expect.any(Object),
    );

    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Transcribing...',
    }));
    expect(onStreamingUpdate).toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'cue-1',
      start: 1,
      end: 2.5,
      text: 'Hello world',
      speaker: 'w0:1',
    });
  });

  it('handles cancellation and calls cancelWordNativeTranscription', async () => {
    const abortController = new AbortController();

    startWordNativeTranscription.mockImplementation(async (_request, _handlers) => {
      return { id: 'job-cancel-test' };
    });

    const pending = processGeminiSegment(
      media,
      { start: 0, end: 120 },
      { signal: abortController.signal },
      {},
    );

    // Abort shortly after
    setTimeout(() => {
      abortController.abort();
    }, 15);

    await expect(pending).rejects.toThrow();
    expect(cancelWordNativeTranscription).toHaveBeenCalledWith('job-cancel-test');
  });
});
