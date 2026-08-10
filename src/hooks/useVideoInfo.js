import { useCallback, useEffect, useMemo, useState } from 'react';

import { inspectMediaPipelineAsset } from '../platform/mediaPipelineService';
import { isNativeMediaDescriptor } from '../platform/mediaService';

export const mapNativeInspectionToVideoDimensions = (assetId, inspection) => {
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

const describeSource = (url) => {
  if (url?.includes('youtube.com') || url?.includes('youtu.be')) {
    return { source: 'youtube', title: 'YouTube Video' };
  }
  if (url?.includes('douyin.com')) return { source: 'douyin', title: 'Douyin Video' };
  if (url) {
    try {
      return {
        source: 'all-sites',
        title: `Video from ${new URL(url).hostname.replace(/^www\./, '')}`,
      };
    } catch {
      return { source: 'unknown', title: 'Web Video' };
    }
  }
  return { source: 'upload', title: null };
};

const nativeInputRequired = () => {
  const error = new Error('Select the media again before choosing a render source.');
  error.name = 'NativeVideoInfoError';
  error.code = 'nativeMediaRequired';
  return error;
};

export const useVideoInfo = (selectedVideo, uploadedFile, actualVideoUrl) => {
  const [actualDimensions, setActualDimensions] = useState(null);

  useEffect(() => {
    let active = true;
    if (!isNativeMediaDescriptor(uploadedFile)) {
      setActualDimensions(null);
      return () => { active = false; };
    }

    inspectMediaPipelineAsset(uploadedFile.assetId)
      .then((inspection) => {
        if (active) {
          setActualDimensions(mapNativeInspectionToVideoDimensions(uploadedFile.assetId, inspection));
        }
      })
      .catch(() => {
        if (active) setActualDimensions(null);
      });
    return () => { active = false; };
  }, [uploadedFile]);

  const videoInfo = useMemo(() => {
    const optimized = localStorage.getItem('optimize_videos') === 'true';
    const quality = actualDimensions?.quality
      ?? (optimized ? localStorage.getItem('optimized_resolution') || '360p' : 'Original');

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

    const originalUrl = localStorage.getItem('current_video_url');
    if (uploadedFile) {
      const source = describeSource(originalUrl);
      return {
        source: originalUrl ? source.source : 'upload',
        title: originalUrl ? source.title : uploadedFile.name,
        quality: originalUrl ? quality : actualDimensions?.quality ?? 'original',
        isOptimized: originalUrl ? optimized : false,
        url: originalUrl,
      };
    }

    if (originalUrl) {
      const source = describeSource(originalUrl);
      return {
        ...source,
        quality,
        isOptimized: optimized,
        url: originalUrl,
      };
    }

    if (actualVideoUrl) {
      const source = describeSource(actualVideoUrl);
      return {
        ...source,
        title: source.title ?? 'Unknown Video',
        quality: 'unknown',
        isOptimized: false,
        url: actualVideoUrl,
      };
    }
    return null;
  }, [actualDimensions, actualVideoUrl, selectedVideo, uploadedFile]);

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
