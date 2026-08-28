import { describe, expect, it, vi } from 'vitest';

import {
  createImportedSubtitleClear,
  createImportedSubtitlePersistence,
} from './importedSubtitlePersistence';

const rows = [{ id: 1, start: 0, end: 1, text: 'hello' }];

describe('imported subtitle persistence', () => {
  it('saves against the exact active project before acknowledging the import', async () => {
    const save = vi.fn(async () => ({
      success: true, cacheId: 'asset-a', projectId: 'project-a', subtitleCount: 1,
    }));
    const persist = createImportedSubtitlePersistence({
      desktop: () => true,
      readCacheId: () => 'asset-a',
      resolveProject: async () => ({ projectId: 'project-a' }),
      save,
    });

    await expect(persist(rows)).resolves.toMatchObject({ projectId: 'project-a' });
    expect(save).toHaveBeenCalledWith('asset-a', rows, { expectedProjectId: 'project-a' });
  });

  it('defers when a URL has no active media project yet', async () => {
    const save = vi.fn();
    const persist = createImportedSubtitlePersistence({
      desktop: () => true,
      readCacheId: () => null,
      resolveProject: vi.fn(),
      save,
    });

    await expect(persist(rows)).resolves.toEqual({ status: 'deferred' });
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a project switch before the durable write', async () => {
    const readCacheId = vi.fn()
      .mockReturnValueOnce('asset-a')
      .mockReturnValueOnce('asset-b');
    const save = vi.fn();
    const persist = createImportedSubtitlePersistence({
      desktop: () => true,
      readCacheId,
      resolveProject: async () => ({ projectId: 'project-a' }),
      save,
    });

    await expect(persist(rows)).rejects.toMatchObject({ code: 'projectScopeMismatch' });
    expect(save).not.toHaveBeenCalled();
  });

  it('rejects a project switch after the durable write instead of publishing stale rows', async () => {
    const readCacheId = vi.fn()
      .mockReturnValueOnce('asset-a')
      .mockReturnValueOnce('asset-a')
      .mockReturnValueOnce('asset-b');
    const persist = createImportedSubtitlePersistence({
      desktop: () => true,
      readCacheId,
      resolveProject: async () => ({ projectId: 'project-a' }),
      save: async () => ({
        success: true, cacheId: 'asset-a', projectId: 'project-a', subtitleCount: 1,
      }),
    });

    await expect(persist(rows)).rejects.toMatchObject({ code: 'projectScopeMismatch' });
  });

  it('waits out a still-settling native media binding instead of racing its cache ID', async () => {
    // A drop that lands right after its media is opened can be scheduled while the media's own
    // subtitle-project binding is still in flight. That binding flips the store's cache ID early,
    // long before it is durable -- reading it as ground truth at that moment is exactly the race
    // that used to make this import refuse with nothing published. Without the awaitBinding gate,
    // readCacheId below would already be observed (returning the stale value) by the time this
    // test's first microtask tick runs.
    let settleBinding;
    const awaitBinding = vi.fn(() => new Promise((resolve) => { settleBinding = resolve; }));
    let cacheId = 'asset-stale';
    const readCacheId = vi.fn(() => cacheId);
    const resolveProject = vi.fn(async () => ({ projectId: 'project-new' }));
    const save = vi.fn(async () => ({
      success: true, cacheId: 'asset-new', projectId: 'project-new', subtitleCount: rows.length,
    }));
    const persist = createImportedSubtitlePersistence({
      desktop: () => true, readCacheId, resolveProject, save, awaitBinding,
    });

    const pending = persist(rows);
    await Promise.resolve();
    await Promise.resolve();
    expect(readCacheId).not.toHaveBeenCalled();
    expect(resolveProject).not.toHaveBeenCalled();

    // The binding settles and the store's cache ID becomes durable only now.
    cacheId = 'asset-new';
    settleBinding();

    await expect(pending).resolves.toMatchObject({
      cacheId: 'asset-new', projectId: 'project-new', subtitleCount: rows.length,
    });
    expect(save).toHaveBeenCalledWith('asset-new', rows, { expectedProjectId: 'project-new' });
  });
});

describe('imported subtitle clear', () => {
  it('clears the exact active project before acknowledging the UI action', async () => {
    const save = vi.fn(async () => ({
      success: true, cacheId: 'asset-a', projectId: 'project-a', subtitleCount: 0,
    }));
    const clear = createImportedSubtitleClear({
      desktop: () => true,
      readCacheId: () => 'asset-a',
      resolveProject: async () => ({ projectId: 'project-a' }),
      save,
    });

    await expect(clear()).resolves.toMatchObject({ projectId: 'project-a', subtitleCount: 0 });
    expect(save).toHaveBeenCalledExactlyOnceWith('asset-a', [], {
      expectedProjectId: 'project-a',
    });
  });

  it('defers SRT-only clearing when no native project exists', async () => {
    const save = vi.fn();
    const clear = createImportedSubtitleClear({
      desktop: () => true,
      readCacheId: () => null,
      resolveProject: vi.fn(),
      save,
    });

    await expect(clear()).resolves.toEqual({ status: 'deferred' });
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a stale or malformed clear receipt instead of dropping visible rows', async () => {
    const clear = createImportedSubtitleClear({
      desktop: () => true,
      readCacheId: () => 'asset-a',
      resolveProject: async () => ({ projectId: 'project-a' }),
      save: async () => ({
        success: true, cacheId: 'asset-a', projectId: 'project-a', subtitleCount: 1,
      }),
    });

    await expect(clear()).rejects.toMatchObject({ code: 'projectScopeMismatch' });
  });

  it('waits out a still-settling native media binding instead of racing its cache ID', async () => {
    let settleBinding;
    const awaitBinding = vi.fn(() => new Promise((resolve) => { settleBinding = resolve; }));
    let cacheId = 'asset-stale';
    const readCacheId = vi.fn(() => cacheId);
    const resolveProject = vi.fn(async () => ({ projectId: 'project-new' }));
    const save = vi.fn(async () => ({
      success: true, cacheId: 'asset-new', projectId: 'project-new', subtitleCount: 0,
    }));
    const clear = createImportedSubtitleClear({
      desktop: () => true, readCacheId, resolveProject, save, awaitBinding,
    });

    const pending = clear();
    await Promise.resolve();
    await Promise.resolve();
    expect(readCacheId).not.toHaveBeenCalled();
    expect(resolveProject).not.toHaveBeenCalled();

    cacheId = 'asset-new';
    settleBinding();

    await expect(pending).resolves.toMatchObject({ cacheId: 'asset-new', projectId: 'project-new' });
    expect(save).toHaveBeenCalledWith('asset-new', [], { expectedProjectId: 'project-new' });
  });
});
