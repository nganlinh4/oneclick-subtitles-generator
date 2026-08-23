import { toBase64, fileToBase64 } from './fileUtils';
import {
  resolveActiveNativeMedia,
  revalidateActiveNativeMedia,
} from '../platform/activeNativeMedia';
import { exportMediaAsset } from '../platform/mediaExportService';
import { runMediaPipeline } from '../platform/mediaPipelineService';
import { isDesktopRuntime } from '../platform/runtimeEnvironment';
import { exportSubtitleDocument } from '../platform/subtitleDocumentExportService';

vi.mock('../platform/activeNativeMedia', () => ({
  resolveActiveNativeMedia: vi.fn(),
  revalidateActiveNativeMedia: vi.fn(),
}));
vi.mock('../platform/mediaPipelineService', () => ({
  runMediaPipeline: vi.fn(),
}));
vi.mock('../platform/mediaExportService', () => ({
  exportMediaAsset: vi.fn(),
}));
vi.mock('../platform/runtimeEnvironment', () => ({
  isDesktopRuntime: vi.fn(() => false),
}));
vi.mock('../platform/subtitleDocumentExportService', () => ({
  exportSubtitleDocument: vi.fn(),
}));
vi.mock('./toastUtils', () => ({ showErrorToast: vi.fn() }));

describe('toBase64', () => {
  test('encodes a Blob to base64 without the data: prefix (round-trip)', async () => {
    const blob = new Blob(['hello world'], { type: 'text/plain' });
    const b64 = await toBase64(blob);
    expect(b64).toBe(Buffer.from('hello world').toString('base64'));
    expect(Buffer.from(b64, 'base64').toString()).toBe('hello world');
  });

  test('encodes a File the same way (File extends Blob)', async () => {
    const file = new File(['abc'], 'a.txt', { type: 'text/plain' });
    expect(await toBase64(file)).toBe(Buffer.from('abc').toString('base64'));
  });

  test('rejects empty or invalid input', async () => {
    await expect(toBase64(null)).rejects.toThrow();
    await expect(toBase64(new Blob([]))).rejects.toThrow();
  });

  test('fileToBase64 is an alias of toBase64', () => {
    expect(fileToBase64).toBe(toBase64);
  });
});

describe('subtitle document downloads', () => {
  beforeEach(() => {
    isDesktopRuntime.mockReset();
    isDesktopRuntime.mockReturnValue(true);
    exportSubtitleDocument.mockReset();
    exportSubtitleDocument.mockResolvedValue({ status: 'saved' });
  });

  test('routes SRT, JSON, and TXT through the native save dialog', async () => {
    const { downloadSRT, downloadJSON, downloadTXT } = await import('./fileUtils');
    const subtitles = [{ start: 0, end: 1, text: 'Hello' }];
    const objectUrl = vi.spyOn(URL, 'createObjectURL');

    await expect(downloadSRT(subtitles, 'captions.srt')).resolves.toEqual({ status: 'saved' });
    await expect(downloadJSON(subtitles, 'captions.json')).resolves.toEqual({ status: 'saved' });
    await expect(downloadTXT(subtitles, 'captions.txt')).resolves.toEqual({
      status: 'saved',
      content: 'Hello',
    });

    expect(exportSubtitleDocument).toHaveBeenNthCalledWith(1, expect.objectContaining({
      suggestedName: 'captions.srt', format: 'srt',
    }));
    expect(exportSubtitleDocument).toHaveBeenNthCalledWith(2, expect.objectContaining({
      suggestedName: 'captions.json', format: 'json',
    }));
    expect(exportSubtitleDocument).toHaveBeenNthCalledWith(3, expect.objectContaining({
      suggestedName: 'captions.txt', format: 'txt', content: 'Hello',
    }));
    expect(objectUrl).not.toHaveBeenCalled();
    objectUrl.mockRestore();
  });

  test('does not invent success when the native dialog is cancelled or fails', async () => {
    const { downloadSRT } = await import('./fileUtils');
    const subtitles = [{ start: 0, end: 1, text: 'Hello' }];
    exportSubtitleDocument.mockResolvedValueOnce({ status: 'cancelled' });
    await expect(downloadSRT(subtitles, 'captions.srt')).resolves.toEqual({
      status: 'cancelled',
    });
    exportSubtitleDocument.mockRejectedValueOnce(new Error('disk full'));
    await expect(downloadSRT(subtitles, 'captions.srt')).rejects.toThrow('disk full');
  });
});

describe('extractAndDownloadAudio native path', () => {
  beforeEach(() => {
    resolveActiveNativeMedia.mockReset();
    revalidateActiveNativeMedia.mockReset();
    revalidateActiveNativeMedia.mockImplementation(async (capability) => capability);
    runMediaPipeline.mockReset();
    exportMediaAsset.mockReset();
  });

  test('extracts through an opaque asset and exports through the native save dialog', async () => {
    const { extractAndDownloadAudio } = await import('./fileUtils');
    const assetId = '01890f39-7b62-7c4e-8c9a-000000000101';
    const playbackUrl = `http://127.0.0.1:49152/asset/550e8400-e29b-41d4-a716-446655440000?token=${'a'.repeat(64)}`;
    const capability = Object.freeze({ assetId });
    resolveActiveNativeMedia.mockResolvedValue(capability);
    runMediaPipeline.mockResolvedValue({
      kind: 'media',
      media: { asset: { id: '01890f39-7b62-7c4e-8c9a-000000000102' }, playback: { playbackUrl } },
    });
    exportMediaAsset.mockResolvedValue({ status: 'completed' });
    const fetchSpy = vi.spyOn(global, 'fetch');

    await expect(extractAndDownloadAudio(playbackUrl, 'soundtrack')).resolves.toBe(true);

    expect(runMediaPipeline).toHaveBeenCalledWith({
      operation: 'extractAudio',
      assetId,
      format: 'mp3',
      range: null,
    });
    expect(resolveActiveNativeMedia).toHaveBeenCalledWith({ candidate: playbackUrl });
    expect(revalidateActiveNativeMedia).toHaveBeenCalledTimes(2);
    expect(exportMediaAsset).toHaveBeenCalledWith('01890f39-7b62-7c4e-8c9a-000000000102');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
