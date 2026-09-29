import { beforeEach, expect, it, vi } from 'vitest';
const deps = vi.hoisted(() => ({ read: vi.fn(), resolve: vi.fn(), restore: vi.fn(), activate: vi.fn() }));
vi.mock('../utils/userSubtitlesStore', () => ({ getCurrentCacheId: deps.read }));
vi.mock('./subtitleProjectStore', () => ({ resolveProjectForCache: deps.resolve, restoreActiveSubtitleProject: deps.restore }));
vi.mock('./subtitleProjectBinding', () => ({ activateSubtitleProjectBinding: deps.activate }));
import { resolveProjectForMedia, restoreSubtitleDocument } from './subtitleDocumentProject';

const document = { cacheId: 'subtitle-document:one', projectId: 'project-one', snapshot: { media: [], tracks: [] } };
beforeEach(() => vi.resetAllMocks());
it('attaches the first media to the exact standalone project instead of creating an empty replacement', async () => {
  deps.read.mockReturnValue(document.cacheId);
  deps.resolve.mockResolvedValue(document);
  await expect(resolveProjectForMedia('asset-new', { create: true })).resolves.toBe(document);
  expect(deps.resolve).toHaveBeenCalledExactlyOnceWith(document.cacheId, { create: false });
});
it('does not reuse a document that already owns another video', async () => {
  deps.read.mockReturnValue(document.cacheId);
  deps.resolve.mockResolvedValueOnce({ ...document, snapshot: { media: [{}] } }).mockResolvedValueOnce({ projectId: 'new-project' });
  await expect(resolveProjectForMedia('asset-new', { create: true })).resolves.toEqual({ projectId: 'new-project' });
});
it('rejects a switch during the document lookup', async () => {
  deps.read.mockReturnValueOnce(document.cacheId).mockReturnValueOnce('other-project');
  deps.resolve.mockResolvedValue(document);
  await expect(resolveProjectForMedia('asset-new', { create: true })).rejects.toThrow('changed');
});
it('restores a media-free document through the shared binding authority', async () => {
  deps.restore.mockResolvedValue(document);
  deps.read.mockReturnValueOnce(null).mockReturnValue(document.cacheId);
  await expect(restoreSubtitleDocument()).resolves.toBe(true);
  expect(deps.activate).toHaveBeenCalledExactlyOnceWith(document.cacheId, { create: false, expectedProjectId: document.projectId });
});
it('never overwrites a user selection or a disposed startup during restore', async () => {
  deps.restore.mockResolvedValue(document);
  deps.read.mockReturnValue('another-project');
  await expect(restoreSubtitleDocument()).resolves.toBe(false);
  await expect(restoreSubtitleDocument({ isCurrent: () => false })).resolves.toBe(false);
  expect(deps.activate).not.toHaveBeenCalled();
});
