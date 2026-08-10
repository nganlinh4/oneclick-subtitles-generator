import { useCallback, useEffect, useRef, useState } from 'react';

import { downloadNativeVideo } from '../../platform/nativeUrlDownloadAdapter';

const isYoutubeUrl = (value) => value.includes('youtube.com') || value.includes('youtu.be');

const useVideoSourceLoading = ({ videoSource, t, useCookiesForDownload }) => {
  const [videoUrl, setVideoUrl] = useState('');
  const [optimizedVideoUrl] = useState('');
  const [optimizedVideoInfo] = useState(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [error, setError] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const loadGenerationRef = useRef(0);
  const [useOptimizedPreview, setUseOptimizedPreview] = useState(
    () => localStorage.getItem('use_optimized_preview') === 'true'
  );

  useEffect(() => {
    const handleStorageChange = (event) => {
      if (event.key === 'use_optimized_preview') {
        setUseOptimizedPreview(event.newValue === 'true');
      }
    };
    const handleCustomEvent = (event) => setUseOptimizedPreview(Boolean(event.detail.value));
    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('optimizedPreviewChanged', handleCustomEvent);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('optimizedPreviewChanged', handleCustomEvent);
    };
  }, []);

  const processVideoUrl = useCallback(async (url, generation) => {
    setDownloadProgress(0);
    localStorage.setItem('current_video_url', url);
    setIsDownloading(true);
    try {
      const media = await downloadNativeVideo({
        url,
        useCookies: useCookiesForDownload,
        onProgress: (progress) => {
          if (loadGenerationRef.current === generation) setDownloadProgress(progress);
        },
      });
      if (loadGenerationRef.current !== generation) return;
      if (media === null) {
        setDownloadProgress(0);
        return;
      }
      setVideoUrl(media.playbackUrl);
      setDownloadProgress(100);
    } catch (downloadError) {
      if (loadGenerationRef.current === generation) {
        setError(t('preview.videoError', `Error loading video: ${downloadError.message}`));
      }
    } finally {
      if (loadGenerationRef.current === generation) setIsDownloading(false);
    }
  }, [t, useCookiesForDownload]);

  useEffect(() => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoaded(false);
    setVideoUrl('');
    setError('');
    setIsDownloading(false);
    setDownloadProgress(0);

    window.originalNarrations = [];
    window.translatedNarrations = [];
    localStorage.removeItem('originalNarrations');
    localStorage.removeItem('translatedNarrations');
    window.dispatchEvent(new CustomEvent('narrations-updated', {
      detail: { source: 'original', narrations: [] },
    }));
    window.dispatchEvent(new CustomEvent('narrations-updated', {
      detail: { source: 'translated', narrations: [] },
    }));

    if (!videoSource) return undefined;
    if (isYoutubeUrl(videoSource)) {
      processVideoUrl(videoSource, generation);
    } else {
      setVideoUrl(videoSource);
    }
    return () => {
      if (loadGenerationRef.current === generation) loadGenerationRef.current += 1;
    };
  }, [processVideoUrl, videoSource]);

  return {
    videoUrl,
    optimizedVideoUrl,
    optimizedVideoInfo,
    isLoaded,
    setIsLoaded,
    error,
    setError,
    isDownloading,
    downloadProgress,
    useOptimizedPreview,
  };
};

export default useVideoSourceLoading;
