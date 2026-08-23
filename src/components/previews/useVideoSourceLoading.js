import { useEffect, useRef, useState } from 'react';
import { clearCurrentProjectNarrationState } from '../../platform/projectNarrationState';
import { requestAlignedNarrationReset } from '../../platform/alignedNarrationSession';

const isYoutubeUrl = (value) => value.includes('youtube.com') || value.includes('youtu.be');

const useVideoSourceLoading = ({ videoSource, t }) => {
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

  useEffect(() => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoaded(false);
    setVideoUrl('');
    setError('');
    setIsDownloading(false);
    setDownloadProgress(0);

    clearCurrentProjectNarrationState();
    requestAlignedNarrationReset();

    if (!videoSource) return undefined;
    if (isYoutubeUrl(videoSource)) {
      // A preview is a consumer, never a media-activation owner. URL acquisition happens in the
      // generation/download transaction, which publishes an opaque native playback capability
      // only after project and store ownership are bound. Starting a second download here used to
      // let an old preview replace the Rust-selected media behind the editor.
      setError(t(
        'preview.mediaNotPrepared',
        'Prepare this video before opening its preview.'
      ));
    } else {
      setVideoUrl(videoSource);
    }
    return () => {
      if (loadGenerationRef.current === generation) loadGenerationRef.current += 1;
    };
  }, [t, videoSource]);

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
