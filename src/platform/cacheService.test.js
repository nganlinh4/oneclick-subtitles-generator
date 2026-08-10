import {
  CACHE_CATEGORY_KEYS,
  CacheServiceError,
  createCacheService,
  formatCacheBytes,
} from './cacheService';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
}));

const nativeInfo = (categories = [], overrides = {}) => ({
  categories,
  totalCount: categories.reduce((sum, category) => sum + category.count, 0),
  totalSizeBytes: categories.reduce((sum, category) => sum + category.sizeBytes, 0),
  ...overrides,
});

it('normalizes native aggregates into the exact path-free legacy CacheTab shape', async () => {
  const invokeCommand = vi.fn().mockResolvedValue(nativeInfo([
    { category: 'videos', count: 2, sizeBytes: 1536 },
    { category: 'subtitles', count: 1, sizeBytes: 10 },
  ]));
  const service = createCacheService({ invokeCommand });

  await expect(service.getCacheInfo()).resolves.toEqual({
    success: true,
    details: expect.objectContaining({
      videos: { count: 2, size: 1536, files: [], formattedSize: '1.5 KB' },
      subtitles: { count: 1, size: 10, files: [], formattedSize: '10 Bytes' },
      narrationOutput: { count: 0, size: 0, files: [], formattedSize: '0 Bytes' },
      totalCount: 3,
      totalSize: 1546,
      formattedTotalSize: '1.51 KB',
    }),
  });
  expect(invokeCommand).toHaveBeenCalledWith('cache_info', {});
  const result = await service.getCacheInfo();
  expect(Object.keys(result.details).filter((key) => CACHE_CATEGORY_KEYS.includes(key)))
    .toEqual(CACHE_CATEGORY_KEYS);
  expect(JSON.stringify(result)).not.toMatch(/path|filename|private/i);
});

it('uses category sums for legacy totals while accepting distinct native totals', async () => {
  const service = createCacheService({
    invokeCommand: vi.fn().mockResolvedValue(nativeInfo([
      { category: 'videos', count: 1, sizeBytes: 100 },
      { category: 'videoTemp', count: 1, sizeBytes: 100 },
    ], { totalCount: 1, totalSizeBytes: 100 })),
  });

  await expect(service.getCacheInfo()).resolves.toMatchObject({
    details: { totalCount: 2, totalSize: 200 },
  });
});

it('normalizes all-cache clear from before/after deltas', async () => {
  const before = nativeInfo([
    { category: 'videos', count: 3, sizeBytes: 300 },
    { category: 'subtitles', count: 2, sizeBytes: 40 },
  ]);
  const after = nativeInfo([
    { category: 'videos', count: 1, sizeBytes: 100 },
  ]);
  const invokeCommand = vi.fn().mockResolvedValue({
    category: null,
    removedCount: 4,
    removedSizeBytes: 240,
    retainedSharedCount: 0,
    leasedCount: 1,
    cleanupFailedCount: 0,
    before,
    after,
  });
  const service = createCacheService({ invokeCommand });

  await expect(service.clearCache()).resolves.toEqual({
    success: true,
    message: 'Cache cleared successfully',
    details: expect.objectContaining({
      videos: { count: 2, size: 200, files: [], formattedSize: '200 Bytes' },
      subtitles: { count: 2, size: 40, files: [], formattedSize: '40 Bytes' },
      totalCount: 4,
      totalSize: 240,
      formattedTotalSize: '240 Bytes',
    }),
  });
  expect(invokeCommand).toHaveBeenCalledWith('cache_clear', { category: null });
});

it('returns the legacy single-category clear envelope', async () => {
  const invokeCommand = vi.fn().mockResolvedValue({
    category: 'narrationOutput',
    removedCount: 1,
    removedSizeBytes: 2048,
    retainedSharedCount: 0,
    leasedCount: 0,
    cleanupFailedCount: 0,
    before: nativeInfo([{ category: 'narrationOutput', count: 2, sizeBytes: 4096 }]),
    after: nativeInfo([{ category: 'narrationOutput', count: 1, sizeBytes: 2048 }]),
  });
  const service = createCacheService({ invokeCommand });

  await expect(service.clearCache('narrationOutput')).resolves.toEqual({
    success: true,
    message: 'narrationOutput cache cleared successfully',
    details: {
      narrationOutput: { count: 1, size: 2048, files: [], formattedSize: '2 KB' },
    },
  });
  expect(invokeCommand).toHaveBeenCalledWith('cache_clear', { category: 'narrationOutput' });
});

it('rejects invalid requests before IPC and malformed or path-shaped native metadata', async () => {
  const invokeCommand = vi.fn();
  const service = createCacheService({ invokeCommand });

  await expect(service.clearCache('../../videos')).rejects.toMatchObject({
    name: 'CacheServiceError',
    code: 'invalidCacheRequest',
  });
  expect(invokeCommand).not.toHaveBeenCalled();

  invokeCommand.mockResolvedValue(nativeInfo([
    { category: 'videos', count: 1, sizeBytes: 1, path: 'C:\\private\\video.mp4' },
  ]));
  await expect(service.getCacheInfo()).rejects.toMatchObject({ code: 'invalidCacheResponse' });

  invokeCommand.mockResolvedValue(nativeInfo([
    { category: 'futureCategory', count: 1, sizeBytes: 1 },
  ]));
  await expect(service.getCacheInfo()).rejects.toBeInstanceOf(CacheServiceError);
});

it('rejects unsafe numeric responses and impossible before/after growth', async () => {
  const invokeCommand = vi.fn()
    .mockResolvedValueOnce(nativeInfo([], { totalCount: Number.MAX_SAFE_INTEGER + 1 }))
    .mockResolvedValueOnce({
      category: 'videos',
      removedCount: 0,
      removedSizeBytes: 0,
      retainedSharedCount: 0,
      leasedCount: 0,
      cleanupFailedCount: 0,
      before: nativeInfo([{ category: 'videos', count: 1, sizeBytes: 1 }]),
      after: nativeInfo([{ category: 'videos', count: 2, sizeBytes: 2 }]),
    });
  const service = createCacheService({ invokeCommand });

  await expect(service.getCacheInfo()).rejects.toMatchObject({ code: 'invalidCacheResponse' });
  await expect(service.clearCache('videos')).rejects.toMatchObject({ code: 'invalidCacheResponse' });
});

it('prunes through the dedicated command and never reflects transport diagnostics', async () => {
  const privatePath = 'C:\\Users\\private\\cache';
  const invokeCommand = vi.fn()
    .mockResolvedValueOnce(nativeInfo([]))
    .mockRejectedValueOnce({ code: 'artifactStorage', message: privatePath, path: privatePath });
  const service = createCacheService({ invokeCommand });

  await expect(service.pruneExpiredCache()).resolves.toMatchObject({
    success: true,
    details: { totalCount: 0, totalSize: 0 },
  });
  expect(invokeCommand).toHaveBeenNthCalledWith(1, 'cache_prune_expired', {});

  let caught;
  try {
    await service.pruneExpiredCache();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    code: 'artifactStorage',
    message: 'The cache operation could not be completed',
  });
  expect(JSON.stringify(caught)).not.toContain(privatePath);
});

it('matches legacy byte formatting', () => {
  expect(formatCacheBytes(0)).toBe('0 Bytes');
  expect(formatCacheBytes(1024)).toBe('1 KB');
  expect(formatCacheBytes(1536)).toBe('1.5 KB');
  expect(formatCacheBytes(1024 ** 3)).toBe('1 GB');
});
