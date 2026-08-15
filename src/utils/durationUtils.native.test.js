import { getVideoDuration } from './durationUtils';
import { inspectMediaPipelineAsset } from '../platform/mediaPipelineService';

vi.mock('../platform/mediaPipelineService', () => ({
  inspectMediaPipelineAsset: vi.fn(),
}));

const media = Object.freeze({
  __nativeMedia: true,
  assetId: '01890f39-7b62-7c4e-8c9a-000000000101',
  playbackId: '550e8400-e29b-41d4-a716-446655440000',
  name: 'source.mp4',
  type: 'video/mp4',
  size: 4096,
  lastModified: 0,
  playbackUrl: `http://127.0.0.1:49152/asset/550e8400-e29b-41d4-a716-446655440000?token=${'a'.repeat(64)}`,
});

beforeEach(() => {
  vi.clearAllMocks();
});

test('reads native duration from the inspected opaque asset', async () => {
  inspectMediaPipelineAsset.mockResolvedValue({ durationUs: 12_345_678 });

  await expect(getVideoDuration(media)).resolves.toBe(12.345678);
  expect(inspectMediaPipelineAsset).toHaveBeenCalledWith(media.assetId);
});

test.each([0, null, 1.5])('rejects an invalid native duration instead of inventing ten minutes', async (durationUs) => {
  inspectMediaPipelineAsset.mockResolvedValue({ durationUs });
  await expect(getVideoDuration(media)).rejects.toThrow('native media duration is unavailable');
});
