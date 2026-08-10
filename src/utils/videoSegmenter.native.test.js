import { runMediaPipeline } from '../platform/mediaPipelineService';
import { extractVideoSegmentLocally } from './videoSegmenter';

vi.mock('../platform/desktopRuntime', () => ({ isDesktopRuntime: () => true }));
vi.mock('../platform/mediaPipelineService', () => ({ runMediaPipeline: vi.fn() }));
vi.mock('../platform/mediaService', () => ({
  createNativeMediaDescriptor: (value) => ({ ...value, native: true }),
  isNativeMediaDescriptor: (value) => value?.native === true,
}));

it('extracts desktop segments through the native media pipeline by opaque asset ID', async () => {
  const fetchSpy = vi.spyOn(global, 'fetch');
  runMediaPipeline.mockResolvedValue({
    kind: 'media',
    media: { asset: { id: 'clip' }, playback: { playbackUrl: 'native' } },
  });
  const source = { native: true, assetId: 'source' };

  await expect(extractVideoSegmentLocally(source, 1.25, 4.5)).resolves.toEqual({
    asset: { id: 'clip' },
    playback: { playbackUrl: 'native' },
    native: true,
  });
  expect(runMediaPipeline).toHaveBeenCalledWith({
    operation: 'analysisClip',
    assetId: 'source',
    range: { start: 1.25, end: 4.5 },
  });
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});
