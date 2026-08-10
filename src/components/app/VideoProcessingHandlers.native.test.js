import { runMediaPipeline } from '../../platform/mediaPipelineService';
import { createNativeMediaDescriptor } from '../../platform/mediaService';
import { ensureVideoCompatibility } from './VideoProcessingHandlers';

vi.mock('../../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../../platform/mediaPipelineService', () => ({ runMediaPipeline: vi.fn() }));
vi.mock('../../platform/nativeUrlDownloadAdapter', () => ({ downloadNativeVideo: vi.fn() }));

const SOURCE_ID = '01890f39-7b62-7c4e-8c9a-000000000101';
const source = createNativeMediaDescriptor({
  asset: {
    id: SOURCE_ID,
    displayName: 'source.mkv',
    extension: 'mkv',
    sizeBytes: 4096,
    kind: 'video',
  },
  playback: {
    id: '550e8400-e29b-41d4-a716-446655440000',
    playbackUrl: `http://127.0.0.1:49152/asset/550e8400-e29b-41d4-a716-446655440000?token=${'a'.repeat(64)}`,
    mimeType: 'video/x-matroska',
    byteLength: 4096,
  },
});

it('prepares native playback by asset ID and returns a validated descriptor', async () => {
  runMediaPipeline.mockResolvedValue({
    kind: 'media',
    media: {
      asset: {
        id: '01890f39-7b62-7c4e-8c9a-000000000102',
        displayName: 'source.mp4',
        extension: 'mp4',
        sizeBytes: 8192,
        kind: 'video',
      },
      playback: {
        id: '123e4567-e89b-42d3-a456-426614174000',
        playbackUrl: `http://127.0.0.1:49152/asset/123e4567-e89b-42d3-a456-426614174000?token=${'b'.repeat(64)}`,
        mimeType: 'video/mp4',
        byteLength: 8192,
      },
    },
  });
  const fetchSpy = vi.spyOn(global, 'fetch');

  const prepared = await ensureVideoCompatibility(source);

  expect(runMediaPipeline).toHaveBeenCalledWith({
    operation: 'preparePlayback',
    assetId: SOURCE_ID,
  });
  expect(prepared).toMatchObject({
    __nativeMedia: true,
    name: 'source.mp4',
    type: 'video/mp4',
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
