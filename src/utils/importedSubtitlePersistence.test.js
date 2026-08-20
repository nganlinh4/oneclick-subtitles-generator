import { describe, expect, it, vi } from 'vitest';

import { createImportedSubtitlePersistence } from './importedSubtitlePersistence';

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
});
