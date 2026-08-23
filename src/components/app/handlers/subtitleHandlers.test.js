import { describe, expect, it, vi } from 'vitest';

import { createSubtitleHandlers } from './subtitleHandlers';

const SRT = '1\n00:00:00,000 --> 00:00:01,000\nHello\n';

const setup = (persistUploadedSubtitles, clearUploadedSubtitles = vi.fn(async () => ({
  success: true, cacheId: 'asset-a', projectId: 'project-a', subtitleCount: 0,
}))) => {
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
    clearUploadedSubtitles,
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
    await expect(pending).resolves.toMatchObject({ status: 'accepted' });

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

  it('waits for exact-project clearing before withdrawing visible rows', async () => {
    let acknowledge;
    const clear = vi.fn(() => new Promise((resolve) => { acknowledge = resolve; }));
    const { handlers, state } = setup(vi.fn(), clear);

    const pending = handlers.handleSrtClear();
    await Promise.resolve();
    expect(state.setSubtitlesData).not.toHaveBeenCalled();
    acknowledge({ success: true, cacheId: 'asset-a', projectId: 'project-a', subtitleCount: 0 });
    await expect(pending).resolves.toMatchObject({ status: 'cleared' });

    expect(clear).toHaveBeenCalledTimes(1);
    expect(state.setSubtitlesData).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('keeps visible rows when exact-project clearing refuses', async () => {
    const failure = Object.assign(new Error('wrong project'), { code: 'projectScopeMismatch' });
    const { handlers, state } = setup(vi.fn(), vi.fn(async () => { throw failure; }));

    await expect(handlers.handleSrtClear()).resolves.toMatchObject({
      status: 'refused', error: failure,
    });
    expect(state.setSubtitlesData).not.toHaveBeenCalled();
    expect(state.setStatus).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
