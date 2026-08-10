import { runMediaPipeline } from '../platform/mediaPipelineService';
import {
  createNativeMediaDescriptor,
  isNativeMediaDescriptor,
} from '../platform/mediaService';

const invalidSegment = () => {
  const error = new Error('Select the media again before extracting a video segment.');
  error.name = 'NativeVideoSegmentError';
  error.code = 'invalidSegmentRequest';
  return error;
};

export const extractVideoSegmentLocally = async (media, start, end) => {
  if (!isNativeMediaDescriptor(media)
      || !Number.isFinite(start)
      || !Number.isFinite(end)
      || start < 0
      || end <= start) {
    throw invalidSegment();
  }

  const result = await runMediaPipeline({
    operation: 'analysisClip',
    assetId: media.assetId,
    range: { start, end },
  });
  if (result?.kind !== 'media') throw invalidSegment();
  return createNativeMediaDescriptor(result.media);
};
