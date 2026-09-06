import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTranscriptData,
  getActiveTranscript,
  setActiveTranscript,
  clearActiveTranscript,
  subscribeActiveTranscript,
  loadProjectTranscript,
} from './transcriptStore';
import { invokeDesktop, isDesktopRuntime } from './desktopRuntime';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  isDesktopRuntime: vi.fn(() => true),
}));

describe('transcriptStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveTranscript();
  });

  it('creates immutable structured transcript data', () => {
    const data = createTranscriptData({
      projectId: 'proj-1',
      revisionId: 'rev-1',
      words: [{ id: 'w1', text: 'hi', startMs: 0, endMs: 500 }],
      turns: [{ id: 't1', speakerId: 's1', text: 'hi', startMs: 0, endMs: 500 }],
    });

    expect(data.projectId).toBe('proj-1');
    expect(data.revisionId).toBe('rev-1');
    expect(data.words).toHaveLength(1);
    expect(data.turns).toHaveLength(1);
    expect(Object.isFrozen(data)).toBe(true);
    expect(Object.isFrozen(data.words)).toBe(true);
  });

  it('sets and retrieves active transcript, notifying subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeActiveTranscript(listener);

    const transcript = {
      projectId: 'proj-1',
      revisionId: 'rev-1',
      words: [{ id: 'w1', text: 'test', startMs: 100, endMs: 400 }],
      turns: [],
    };

    setActiveTranscript(transcript);

    expect(getActiveTranscript()).toMatchObject({
      projectId: 'proj-1',
      revisionId: 'rev-1',
    });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setActiveTranscript(null);
    expect(getActiveTranscript()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1); // not called again after unsubscribe
  });

  it('loads project transcript from SQLite via desktop command', async () => {
    invokeDesktop.mockResolvedValue({
      projectId: 'proj-1',
      revisionId: 'rev-100',
      words: [{ id: 'w1', text: 'hello', startMs: 0, endMs: 300 }],
      turns: [{ id: 't1', speakerId: 'spk0', text: 'hello', startMs: 0, endMs: 300 }],
    });

    const result = await loadProjectTranscript('proj-1');

    expect(invokeDesktop).toHaveBeenCalledWith('project_load_transcript', { id: 'proj-1' });
    expect(result).toMatchObject({
      projectId: 'proj-1',
      revisionId: 'rev-100',
    });
    expect(getActiveTranscript()).toBe(result);
  });

  it('returns null when not in desktop runtime or missing projectId', async () => {
    expect(await loadProjectTranscript('')).toBeNull();

    isDesktopRuntime.mockReturnValueOnce(false);
    expect(await loadProjectTranscript('proj-1')).toBeNull();
    expect(invokeDesktop).not.toHaveBeenCalled();
  });
});
