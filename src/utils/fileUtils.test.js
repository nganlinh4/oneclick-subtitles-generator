import { toBase64, fileToBase64 } from './fileUtils';
import { resolveActiveNativeMediaAssetId } from '../platform/activeNativeMedia';
import { exportMediaAsset } from '../platform/mediaExportService';
import { runMediaPipeline } from '../platform/mediaPipelineService';

vi.mock('../platform/activeNativeMedia', () => ({
  resolveActiveNativeMediaAssetId: vi.fn(() => null),
}));
vi.mock('../platform/mediaPipelineService', () => ({
  runMediaPipeline: vi.fn(),
}));
vi.mock('../platform/mediaExportService', () => ({
  exportMediaAsset: vi.fn(),
}));

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

describe('extractAndDownloadAudio native path', () => {
  beforeEach(() => {
    resolveActiveNativeMediaAssetId.mockReset();
    resolveActiveNativeMediaAssetId.mockReturnValue(null);
    runMediaPipeline.mockReset();
    exportMediaAsset.mockReset();
  });

  test('extracts through an opaque asset and exports through the native save dialog', async () => {
    const { extractAndDownloadAudio } = await import('./fileUtils');
    const assetId = '01890f39-7b62-7c4e-8c9a-000000000101';
    const playbackUrl = `http://127.0.0.1:49152/asset/550e8400-e29b-41d4-a716-446655440000?token=${'a'.repeat(64)}`;
    resolveActiveNativeMediaAssetId.mockReturnValue(assetId);
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
    expect(exportMediaAsset).toHaveBeenCalledWith('01890f39-7b62-7c4e-8c9a-000000000102');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
