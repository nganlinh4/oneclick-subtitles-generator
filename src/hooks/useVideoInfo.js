import { useCallback, useEffect, useMemo, useState } from 'react';

import { inspectMediaPipelineAsset } from '../platform/mediaPipelineService';
import { isNativeMediaDescriptor } from '../platform/mediaService';
import {
  resolveActiveNativeMedia,
  revalidateActiveNativeMedia,
} from '../platform/activeNativeMedia';
import { readPreference } from '../platform/preferences/store';

const mapNativeInspectionToVideoDimensions = (assetId, inspection) => {
  const dimensions = inspection.width !== null && inspection.height !== null
    ? `${inspection.width}x${inspection.height}`
    : null;
  return Object.freeze({
    success: true,
    videoId: assetId,
    width: inspection.width,
    height: inspection.height,
    quality: inspection.height === null ? 'Original' : `${inspection.height}p`,
    resolution: dimensions,
    dimensions,
    fps: inspection.frameRate,
    codec: inspection.videoCodec,
    bit_rate: null,
    audio_codec: inspection.audioCodec,
    audio_channels: null,
    audio_sample_rate: null,
    audio_channel_layout: null,
    audio_bit_rate: null,
  });
};

const nativeInputRequired = () => {
  const error = new Error('Select the media again before choosing a render source.');
  error.name = 'NativeVideoInfoError';
  error.code = 'nativeMediaRequired';
  return error;
};

export const useVideoInfo = (selectedVideo, uploadedFile) => {
  const [actualDimensions, setActualDimensions] = useState(null);

  useEffect(() => {
    let active = true;
    if (!isNativeMediaDescriptor(uploadedFile)) {
      setActualDimensions(null);
      return () => { active = false; };
    }

    resolveActiveNativeMedia({ candidate: uploadedFile })
      .then(async (capability) => {
        const inspection = await inspectMediaPipelineAsset(capability.assetId);
        await revalidateActiveNativeMedia(capability);
        if (active) {
          setActualDimensions(mapNativeInspectionToVideoDimensions(capability.assetId, inspection));
        }
      })
      .catch(() => {
        if (active) setActualDimensions(null);
      });
    return () => { active = false; };
  }, [uploadedFile]);

  const videoInfo = useMemo(() => {
    const optimized = readPreference('optimize_videos');
    const quality = actualDimensions?.quality
      ?? (optimized ? readPreference('optimized_resolution') : 'Original');

    // A URL selection is only an acquisition intent. Until its candidate is claimed, an existing
    // native descriptor remains the sole render authority; preferring selectedVideo here labelled
    // and configured exports of active video A as pending/failed video B.
    if (isNativeMediaDescriptor(uploadedFile)) {
      return {
        source: 'upload',
        title: uploadedFile.name,
        quality: actualDimensions?.quality ?? 'original',
        isOptimized: false,
        url: null,
      };
    }

    if (selectedVideo) {
      return {
        source: selectedVideo.source,
        title: selectedVideo.title,
        quality,
        isOptimized: optimized,
        url: selectedVideo.url,
        id: selectedVideo.id,
      };
    }

    if (uploadedFile) {
      return {
        source: 'upload',
        title: uploadedFile.name,
        quality: actualDimensions?.quality ?? 'original',
        isOptimized: false,
        url: null,
      };
    }

    // A playback or remembered source URL is never promoted into render identity.
    return null;
  }, [actualDimensions, selectedVideo, uploadedFile]);

  const availableVersions = useMemo(() => [], []);

  const fetchActualDimensions = useCallback(async () => actualDimensions, [actualDimensions]);

  const getVideoInfoForModal = useCallback(() => ({
    videoInfo,
    availableVersions,
    hasMultipleVersions: false,
    canRedownload: Boolean(videoInfo?.url && ['youtube', 'douyin', 'all-sites'].includes(videoInfo.source)),
    actualDimensions,
  }), [actualDimensions, availableVersions, videoInfo]);

  const redownloadWithQuality = useCallback(async () => {
    throw nativeInputRequired();
  }, []);

  const getVideoFileForRendering = useCallback(async (option, data = {}) => {
    if (option === 'current') {
      if (isNativeMediaDescriptor(uploadedFile)) return uploadedFile;
      if (uploadedFile instanceof File) return uploadedFile;
      throw nativeInputRequired();
    }
    if (option === 'redownload' && isNativeMediaDescriptor(data.nativeMedia)) {
      return data.nativeMedia;
    }
    throw nativeInputRequired();
  }, [uploadedFile]);

  return {
    videoInfo,
    availableVersions,
    actualDimensions,
    getVideoInfoForModal,
    redownloadWithQuality,
    getVideoFileForRendering,
    fetchActualDimensions,
  };
};
