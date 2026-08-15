import {
  createSubtitleDocumentExportService,
  normalizeSubtitleArchiveEntries,
} from './subtitleDocumentExportService';
import { invokeDesktop } from './desktopRuntime';
import { isDesktopRuntime } from './runtimeEnvironment';

vi.mock('./desktopRuntime', () => ({
  invokeDesktop: vi.fn(),
  invokeDesktopRaw: vi.fn(),
}));
vi.mock('./runtimeEnvironment', () => ({
  isDesktopRuntime: vi.fn(() => true),
}));

describe('subtitle document export service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isDesktopRuntime.mockReturnValue(true);
  });

  test('uses one path-free native request and normalizes an unsafe suggested name', async () => {
    const invokeCommand = vi.fn().mockResolvedValue(true);
    const service = createSubtitleDocumentExportService({
      invokeCommand,
      isNativeRuntime: () => true,
    });

    await expect(service.save({
      suggestedName: 'video: chapter?.SRT',
      format: 'srt',
      content: '1\n00:00:00,000 --> 00:00:01,000\nHello',
    })).resolves.toEqual({ status: 'saved' });

    expect(invokeCommand).toHaveBeenCalledWith('subtitle_document_export', {
      request: {
        suggestedName: 'video_ chapter_.srt',
        format: 'srt',
        content: '1\n00:00:00,000 --> 00:00:01,000\nHello',
      },
    });
    expect(JSON.stringify(invokeCommand.mock.calls)).not.toMatch(/destination|filePath/i);
  });

  test('sends bounded structured entries for native ZIP creation and deduplicates names', async () => {
    const { exportSubtitleArchive } = await import('./subtitleDocumentExportService');
    isDesktopRuntime.mockReturnValue(true);
    invokeDesktop.mockResolvedValue(true);

    await expect(exportSubtitleArchive([
      { suggestedName: 'captions?.srt', format: 'srt', content: 'first' },
      { suggestedName: 'captions*.srt', format: 'srt', content: 'second' },
    ], '../Vietnamese captions.zip')).resolves.toEqual({
      status: 'saved',
    });
    expect(invokeDesktop).toHaveBeenCalledWith('subtitle_archive_export', {
      request: {
        suggestedName: 'Vietnamese_captions.zip',
        entries: [
          { suggestedName: 'captions_.srt', format: 'srt', content: 'first' },
          { suggestedName: 'captions__2.srt', format: 'srt', content: 'second' },
        ],
      },
    });
  });

  test('reserves suffix bytes when deduplicating maximum-length archive names', () => {
    const maximumStem = 'a'.repeat(236);
    const entries = normalizeSubtitleArchiveEntries([
      { suggestedName: `${maximumStem}.srt`, format: 'srt', content: 'first' },
      { suggestedName: `${maximumStem}.srt`, format: 'srt', content: 'second' },
    ]);

    expect(entries[0].suggestedName).toHaveLength(240);
    expect(entries[1].suggestedName).toHaveLength(240);
    expect(entries[1].suggestedName).toMatch(/_2\.srt$/);
    expect(entries[1].suggestedName).not.toBe(entries[0].suggestedName);
    expect(Object.isFrozen(entries)).toBe(true);
  });

  test('rejects accessor entries and oversized archives before IPC', async () => {
    const { exportSubtitleArchive } = await import('./subtitleDocumentExportService');
    isDesktopRuntime.mockReturnValue(true);
    const getter = vi.fn(() => 'secret');
    const entry = { suggestedName: 'captions.srt', format: 'srt' };
    Object.defineProperty(entry, 'content', { enumerable: true, get: getter });
    await expect(exportSubtitleArchive([entry])).rejects.toThrow(/invalid/i);
    expect(getter).not.toHaveBeenCalled();
    expect(invokeDesktop).not.toHaveBeenCalled();
  });

  test('requires dense own data descriptors for archive array indices', () => {
    const sparse = new Array(1);
    const inheritedGetter = vi.fn(() => ({
      suggestedName: 'captions.srt',
      format: 'srt',
      content: 'secret',
    }));
    const inheritedPrototype = Object.create(Array.prototype);
    Object.defineProperty(inheritedPrototype, '0', {
      configurable: true,
      get: inheritedGetter,
    });
    Object.setPrototypeOf(sparse, inheritedPrototype);
    expect(() => normalizeSubtitleArchiveEntries(sparse)).toThrow(/invalid/i);
    expect(inheritedGetter).not.toHaveBeenCalled();

    const accessorEntries = [];
    const ownGetter = vi.fn(() => ({
      suggestedName: 'captions.srt',
      format: 'srt',
      content: 'secret',
    }));
    Object.defineProperty(accessorEntries, '0', {
      configurable: true,
      enumerable: true,
      get: ownGetter,
    });
    expect(() => normalizeSubtitleArchiveEntries(accessorEntries)).toThrow(/invalid/i);
    expect(ownGetter).not.toHaveBeenCalled();

    const denseEntries = [];
    Object.defineProperty(denseEntries, '0', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: { suggestedName: 'captions.srt', format: 'srt', content: 'dense' },
    });
    expect(normalizeSubtitleArchiveEntries(denseEntries)).toEqual([
      { suggestedName: 'captions.srt', format: 'srt', content: 'dense' },
    ]);
  });

  test('fails closed when archive array reflection traps throw', () => {
    const entries = new Proxy([
      { suggestedName: 'captions.srt', format: 'srt', content: 'x' },
    ], {
      ownKeys() {
        throw new Error('observable trap');
      },
    });
    expect(() => normalizeSubtitleArchiveEntries(entries)).toThrow(/invalid/i);
  });

  test('rejects archive length bounds before reflecting over prototypes or indices', () => {
    const prototypeTrap = vi.fn(() => Array.prototype);
    const ownKeysTrap = vi.fn(() => []);
    const oversized = new Proxy(new Array(257), {
      getPrototypeOf: prototypeTrap,
      ownKeys: ownKeysTrap,
    });
    expect(() => normalizeSubtitleArchiveEntries(oversized)).toThrow(/invalid/i);
    expect(prototypeTrap).not.toHaveBeenCalled();
    expect(ownKeysTrap).not.toHaveBeenCalled();
  });

  test('rejects accessor document requests without executing them', async () => {
    const invokeCommand = vi.fn();
    const service = createSubtitleDocumentExportService({
      invokeCommand,
      isNativeRuntime: () => true,
    });
    const getter = vi.fn(() => 'secret');
    const request = { suggestedName: 'captions.srt', format: 'srt' };
    Object.defineProperty(request, 'content', { enumerable: true, get: getter });

    await expect(service.save(request)).rejects.toThrow(/invalid/i);
    expect(getter).not.toHaveBeenCalled();
    expect(invokeCommand).not.toHaveBeenCalled();
  });

  test('reports cancellation without inventing a saved result', async () => {
    const service = createSubtitleDocumentExportService({
      invokeCommand: vi.fn().mockResolvedValue(false),
      isNativeRuntime: () => true,
    });
    await expect(service.save({
      suggestedName: 'captions.json',
      format: 'json',
      content: '[]',
    })).resolves.toEqual({ status: 'cancelled' });
  });

  test('rejects malformed requests and non-boolean host responses', async () => {
    const invokeCommand = vi.fn().mockResolvedValue({ saved: true });
    const service = createSubtitleDocumentExportService({
      invokeCommand,
      isNativeRuntime: () => true,
    });
    await expect(service.save({ format: 'html', content: 'x' })).rejects.toThrow(/invalid/i);
    expect(invokeCommand).not.toHaveBeenCalled();
    await expect(service.save({
      suggestedName: 'captions.txt',
      format: 'txt',
      content: 'hello',
    })).rejects.toThrow(/invalid response/i);
  });

  test('rejects malformed UTF-16 locally instead of mutating it in IPC JSON', async () => {
    const invokeCommand = vi.fn();
    const service = createSubtitleDocumentExportService({
      invokeCommand,
      isNativeRuntime: () => true,
    });
    await expect(service.save({
      suggestedName: 'captions.srt',
      format: 'srt',
      content: '\ud800',
    })).rejects.toThrow(/invalid/i);
    expect(invokeCommand).not.toHaveBeenCalled();
  });
});
