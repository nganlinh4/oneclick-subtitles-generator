import {
  exportSubtitleArchive,
  exportSubtitleDocument,
} from '../../../platform/subtitleDocumentExportService';
import { isDesktopRuntime } from '../../../platform/runtimeEnvironment';
import {
  handleBulkDownloadAll,
  handleBulkDownloadZip,
  runOwnedBulkExport,
} from './downloadUtils';

vi.mock('../../../platform/runtimeEnvironment', () => ({
  isDesktopRuntime: vi.fn(() => true),
}));
vi.mock('../../../platform/subtitleDocumentExportService', async () => {
  const actual = await vi.importActual('../../../platform/subtitleDocumentExportService');
  return {
    ...actual,
    exportSubtitleArchive: vi.fn(),
    exportSubtitleDocument: vi.fn(),
  };
});

const translated = [{ start: 1.25, end: 2.5, text: 'Hello' }];

const createTrackedPendingRef = () => {
  let current = false;
  const writes = [];
  return {
    ref: {
      get current() {
        return current;
      },
      set current(next) {
        writes.push(next);
        current = next;
      },
    },
    writes,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  isDesktopRuntime.mockReturnValue(true);
  exportSubtitleArchive.mockResolvedValue({ status: 'saved' });
  exportSubtitleDocument.mockResolvedValue({ status: 'saved' });
  localStorage.clear();
});

test('builds desktop ZIP entries as structured canonical documents without JS ZIP bytes', async () => {
  await expect(handleBulkDownloadZip({
    translatedSubtitles: translated,
    bulkTranslations: [{
      success: true,
      originalFile: { name: 'episode.srt' },
      translatedSubtitles: [{ start: 3, end: 4, text: 'World' }],
    }],
    videoTitle: 'episode',
    targetLanguages: [{ value: 'Korean' }],
  })).resolves.toEqual({ status: 'saved' });

  expect(exportSubtitleArchive).toHaveBeenCalledOnce();
  const [entries, archiveName] = exportSubtitleArchive.mock.calls[0];
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ format: 'srt' });
  expect(entries[0].content).toContain('00:00:01,250 --> 00:00:02,500');
  expect(entries[1].content).toContain('00:00:03,000 --> 00:00:04,000');
  expect(archiveName).toMatch(/^translated_subtitles_korean_.*\.zip$/);
});

test('opens individual desktop save dialogs sequentially and stops after cancellation', async () => {
  exportSubtitleDocument
    .mockResolvedValueOnce({ status: 'saved' })
    .mockResolvedValueOnce({ status: 'cancelled' });

  await expect(handleBulkDownloadAll({
    translatedSubtitles: translated,
    bulkTranslations: [
      {
        success: true,
        originalFile: { name: 'one.srt' },
        translatedSubtitles: translated,
      },
      {
        success: true,
        originalFile: { name: 'two.srt' },
        translatedSubtitles: translated,
      },
    ],
    videoTitle: 'episode',
    targetLanguages: [{ value: 'Korean' }],
  })).resolves.toEqual({ status: 'cancelled', savedCount: 1, totalCount: 3 });

  expect(exportSubtitleDocument).toHaveBeenCalledTimes(2);
});

test('owns one bulk export synchronously before React can rerender', async () => {
  let resolveFirst;
  const operation = vi.fn(() => new Promise(resolve => {
    resolveFirst = resolve;
  }));
  const { ref: pendingRef, writes } = createTrackedPendingRef();
  const setPending = vi.fn();

  const first = runOwnedBulkExport({ pendingRef, setPending, operation });
  const duplicate = runOwnedBulkExport({ pendingRef, setPending, operation });

  await expect(duplicate).resolves.toEqual({ status: 'busy' });
  expect(operation).toHaveBeenCalledOnce();
  expect(pendingRef.current).toBe(true);
  resolveFirst({ status: 'cancelled' });
  await expect(first).resolves.toEqual({ status: 'cancelled' });
  expect(pendingRef.current).toBe(false);
  expect(writes).toEqual([true, false]);
  expect(setPending.mock.calls).toEqual([[true], [false]]);
});

test.each([
  { label: 'success', terminal: Object.freeze({ status: 'saved' }) },
  { label: 'cancellation', terminal: Object.freeze({ status: 'cancelled' }) },
])('preserves $label when publishing the released React state throws', async ({ terminal }) => {
  const { ref: pendingRef, writes } = createTrackedPendingRef();
  const releaseError = new Error('release render failed');
  const setPending = vi.fn((pending) => {
    if (!pending) throw releaseError;
  });
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
    throw new Error('console unavailable');
  });
  try {
    await expect(runOwnedBulkExport({
      pendingRef,
      setPending,
      operation: () => Promise.resolve(terminal),
    })).resolves.toBe(terminal);
  } finally {
    consoleError.mockRestore();
  }
  expect(pendingRef.current).toBe(false);
  expect(writes).toEqual([true, false]);
  expect(setPending.mock.calls).toEqual([[true], [false]]);
});

test('releases exactly once when both pending-state setter calls throw', async () => {
  const { ref: pendingRef, writes } = createTrackedPendingRef();
  const acquisitionError = new Error('acquisition render failed');
  const releaseError = new Error('release render failed');
  const setPending = vi.fn((pending) => {
    throw pending ? acquisitionError : releaseError;
  });
  const operation = vi.fn();
  const onError = vi.fn();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(runOwnedBulkExport({
      pendingRef,
      setPending,
      operation,
      onError,
    })).resolves.toEqual({ status: 'failed' });
  } finally {
    consoleError.mockRestore();
  }
  expect(operation).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(acquisitionError);
  expect(pendingRef.current).toBe(false);
  expect(writes).toEqual([true, false]);
  expect(setPending.mock.calls).toEqual([[true], [false]]);
});

test.each([
  {
    label: 'synchronous operation failure',
    operation: (error) => () => { throw error; },
  },
  {
    label: 'asynchronous operation failure',
    operation: (error) => () => Promise.reject(error),
  },
])('settles $label even when failure notification throws', async ({ operation }) => {
  const primaryError = new Error('native write failed');
  const { ref: pendingRef, writes } = createTrackedPendingRef();
  const setPending = vi.fn();
  const onError = vi.fn(() => {
    throw new Error('toast unavailable');
  });
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
    throw new Error('console unavailable');
  });
  try {
    await expect(runOwnedBulkExport({
      pendingRef,
      setPending,
      operation: operation(primaryError),
      onError,
    })).resolves.toEqual({ status: 'failed' });
  } finally {
    consoleError.mockRestore();
  }
  expect(onError).toHaveBeenCalledWith(primaryError);
  expect(pendingRef.current).toBe(false);
  expect(writes).toEqual([true, false]);
  expect(setPending.mock.calls).toEqual([[true], [false]]);
});
