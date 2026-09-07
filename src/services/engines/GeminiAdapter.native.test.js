import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processGeminiSegment } from './GeminiAdapter';
import {
  startWordNativeTranscription,
  cancelWordNativeTranscription,
  isNativeWordTranscriptionSupported,
} from '../../platform/nativeWordTranscription';
import { getActiveTranscript } from '../../platform/transcriptStore';

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

  it('routes speech transcription directly to native word-native transcription engine and populates transcriptStore', async () => {
    const mockWords = [
      { id: 'w-1', text: 'Hello', startMs: 1000, endMs: 1600 },
      { id: 'w-2', text: 'world', startMs: 1700, endMs: 2500 },
    ];
    const mockTurns = [
      { id: 't-1', speakerId: 'w0:1', text: 'Hello world', startMs: 1000, endMs: 2500 },
    ];

    startWordNativeTranscription.mockImplementation(async (request, handlers) => {
      // Simulate asynchronous events
      setTimeout(() => {
        handlers.onStageChanged?.({ stage: 'transcribing', message: 'Transcribing...' });
        handlers.onWindowPromoted?.({
          windowIndex: 0,
          totalWindows: 1,
          revisionId: 'rev-xyz',
          words: mockWords,
          turns: mockTurns,
          projectedCues: [
            { id: 'cue-1', startMs: 1000, endMs: 2500, text: 'Hello world', speakerId: 'w0:1', wordIds: ['w-1', 'w-2'] },
          ],
        });
        handlers.onCompleted?.({
          revisionId: 'rev-xyz',
          totalWindows: 1,
          totalWords: 2,
          projectedCues: [
            { id: 'cue-1', startMs: 1000, endMs: 2500, text: 'Hello world', speakerId: 'w0:1', wordIds: ['w-1', 'w-2'] },
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
      { model: 'gemini-3.5-transcribe', projectId: 'proj-abc', maxDurationPerRequest: 60 },
      { onStatus, onStreamingUpdate },
    );

    expect(startWordNativeTranscription).toHaveBeenCalledTimes(1);
    expect(startWordNativeTranscription).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'proj-abc',
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
    expect(result.words).toEqual(mockWords);
    expect(result.turns).toEqual(mockTurns);

    const active = getActiveTranscript();
    expect(active).not.toBeNull();
    expect(active.projectId).toBe('proj-abc');
    expect(active.revisionId).toBe('rev-xyz');
    expect(active.words).toHaveLength(2);
  });

  it('handles cancellation and calls cancelWordNativeTranscription', async () => {
    const abortController = new AbortController();

    startWordNativeTranscription.mockImplementation(async (_request, _handlers) => {
      return { id: 'job-cancel-test' };
    });

    const pending = processGeminiSegment(
      media,
      { start: 0, end: 120 },
      { model: 'gemini-3.5-transcribe', signal: abortController.signal },
      {},
    );

    // Abort shortly after
    setTimeout(() => {
      abortController.abort();
    }, 15);

    await expect(pending).rejects.toThrow();
    expect(cancelWordNativeTranscription).toHaveBeenCalledWith('job-cancel-test');
  });

  it('does not emit streaming updates or set active transcript if project is no longer active', async () => {
    const { activateProjectSnapshot } = await import('../../platform/projectService');
    // Active project is proj-diff
    activateProjectSnapshot({
      metadata: {
        id: '01890f39-7b62-7c4e-8c9a-000000000202',
        name: 'proj-diff',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      stateVersion: 1,
      media: [],
      tracks: [],
    });

    startWordNativeTranscription.mockImplementation(async (_request, handlers) => {
      setTimeout(() => {
        handlers.onWindowPromoted?.({
          windowIndex: 0,
          totalWindows: 2,
          words: [{ id: 'w-1', text: 'Leaked' }],
          projectedCues: [{ id: 'c-1', text: 'Leaked', startMs: 0, endMs: 1000 }],
        });
        handlers.onCompleted?.({
          revisionId: 'rev-leaked',
          totalWindows: 2,
          totalWords: 1,
          words: [{ id: 'w-1', text: 'Leaked' }],
          projectedCues: [{ id: 'c-1', text: 'Leaked', startMs: 0, endMs: 1000 }],
        });
      }, 10);
      return { id: 'job-mismatch' };
    });

    const onStreamingUpdate = vi.fn();
    await processGeminiSegment(
      media,
      { start: 0, end: 60 },
      { model: 'gemini-3.5-transcribe', projectId: 'proj-original' },
      { onStreamingUpdate },
    );

    // Because proj-diff is active, onStreamingUpdate must NOT be called with cues from proj-original
    expect(onStreamingUpdate).not.toHaveBeenCalled();
    const active = getActiveTranscript();
    expect(active?.revisionId).not.toBe('rev-leaked');

    // Clean up
    const { deactivateProject } = await import('../../platform/projectService');
    deactivateProject();
  });
});
