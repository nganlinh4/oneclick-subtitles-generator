import { describe, expect, it, vi } from 'vitest';

import { createSubtitleHandlers } from './subtitleHandlers';

const SRT = '1\n00:00:00,000 --> 00:00:01,000\nHello\n';

const setup = (persistUploadedSubtitles) => {
  const state = {
    setStatus: vi.fn(),
    setSubtitlesData: vi.fn(),
    setIsDownloading: vi.fn(),
    setDownloadProgress: vi.fn(),
    setIsSrtOnlyMode: vi.fn(),
  };
  const handlers = createSubtitleHandlers({
    activeTab: 'file-upload',
    selectedVideo: null,
    uploadedFile: { assetId: 'asset-a' },
    isSrtOnlyMode: false,
    persistUploadedSubtitles,
    t: (_key, fallback) => fallback,
    ...state,
  });
  return { handlers, state };
};

describe('subtitle file import durability', () => {
  it('waits for the project checkpoint before publishing rows as saved', async () => {
    let acknowledge;
    const persistence = new Promise((resolve) => { acknowledge = resolve; });
    const persist = vi.fn(() => persistence);
    const { handlers, state } = setup(persist);

    const pending = handlers.handleSrtUpload(SRT, 'captions.srt');
    await Promise.resolve();
    expect(state.setSubtitlesData).not.toHaveBeenCalled();
    acknowledge({ success: true });
    await pending;

    expect(persist).toHaveBeenCalledWith([
      expect.objectContaining({ text: 'Hello', start: 0, end: 1 }),
    ]);
    expect(state.setSubtitlesData).toHaveBeenCalledTimes(1);
  });

  it('does not publish rows or a success status when persistence refuses', async () => {
    const { handlers, state } = setup(vi.fn(async () => {
      throw Object.assign(new Error('wrong project'), { code: 'projectScopeMismatch' });
    }));

    await handlers.handleSrtUpload(SRT, 'captions.srt');

    expect(state.setSubtitlesData).not.toHaveBeenCalled();
    expect(state.setStatus).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
