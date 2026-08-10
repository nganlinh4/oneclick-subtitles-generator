import { useEffect } from 'react';
import { isLoopbackServiceUrl } from '../../platform/browserOnlyService';
import { isNativeMediaPlaybackUrl } from '../../platform/mediaService';
import { fetchBrowserResource } from '../../platform/browserFetch';
import { dbg } from './videoPreviewDebug';

/**
 * Owns the two effects that react to the resolved source URLs after loading:
 *   - notifying the parent (onVideoUrlReady) of the active player URL and, for
 *     local URLs, mirroring the video into a blob/object URL so downstream
 *     consumers (waveform, processors) can treat it like an upload;
 *   - hot-swapping the <video> element's src when the optimized/original choice
 *     changes while preserving the current time + play state.
 *
 * Depends on hook-owned playback state (isPlaying/setIsPlaying), so it runs
 * after useVideoControls in the parent. videoRef + lastBlobUrlRef stay in the
 * parent and are passed in.
 */
const useVideoSourceSwitching = ({
  videoRef,
  lastBlobUrlRef,
  videoUrl,
  optimizedVideoUrl,
  useOptimizedPreview,
  onVideoUrlReady,
  isPlaying,
  setIsPlaying,
}) => {
  // Notify parent component when videoUrl changes AND mirror as blob to act like uploaded
  useEffect(() => {
    const urlToUse = useOptimizedPreview && optimizedVideoUrl ? optimizedVideoUrl : videoUrl;
    if (!urlToUse) return;

    // Early notify with the actual player URL
    if (onVideoUrlReady) {
      onVideoUrlReady(urlToUse);
    }

    // Also create a blob/object URL so downstream (waveform, processors) can treat it like an upload
    (async () => {
      try {
        // If already a blob/object URL, persist and notify
        if (urlToUse.startsWith('blob:')) {
          localStorage.setItem('current_file_url', urlToUse);
          if (onVideoUrlReady) onVideoUrlReady(urlToUse);
          return;
        }

        // The native media server is already range-capable and guarded by an opaque per-process
        // capability. Fetching it into a Blob would duplicate the entire file in WebView memory,
        // disable seeking until the download completes, and persist an immediately stale URL.
        if (isNativeMediaPlaybackUrl(urlToUse)) {
          localStorage.setItem('current_file_url', urlToUse);
          if (onVideoUrlReady) onVideoUrlReady(urlToUse);
          return;
        }

        // Check if this is an external URL that will cause CORS issues
        const isExternalUrl = (urlToUse.startsWith('http://') || urlToUse.startsWith('https://'))
          && !isLoopbackServiceUrl(urlToUse);

        if (isExternalUrl) {
          // For external URLs, skip blob conversion to avoid CORS errors
          dbg('[VideoPreview] Skipping blob conversion for external URL to avoid CORS');
          // Still notify with the original URL for components that can handle it
          localStorage.setItem('current_file_url', urlToUse);
          if (onVideoUrlReady) onVideoUrlReady(urlToUse);
          return;
        }

        // Convert server URL to blob to avoid CORS/decoding issues (only for local URLs)
        const resp = await fetchBrowserResource(urlToUse, { cache: 'no-cache', mode: 'cors' });
        if (!resp.ok) throw new Error(`Failed to fetch video for blob: ${resp.status}`);
        const blob = await resp.blob();
        const objectUrl = URL.createObjectURL(blob);
        localStorage.setItem('current_file_url', objectUrl);
        // Expose blob in a global map keyed by its object URL for downstream reuse
        if (!window.__videoBlobMap) window.__videoBlobMap = {};
        window.__videoBlobMap[objectUrl] = blob;
        // Keep track of last blob to revoke later when replaced
        if (lastBlobUrlRef.current && lastBlobUrlRef.current.startsWith('blob:')) {
          try { URL.revokeObjectURL(lastBlobUrlRef.current); } catch { /* URL may already be revoked. */ }
          try { if (window.__videoBlobMap) delete window.__videoBlobMap[lastBlobUrlRef.current]; } catch { /* Cleanup is best-effort. */ }
        }
        lastBlobUrlRef.current = objectUrl;
        // Notify consumers to switch to blob (acts like uploaded)
        if (onVideoUrlReady) onVideoUrlReady(objectUrl);
        window.dispatchEvent(new CustomEvent('currentFileUrlChanged', { detail: { url: objectUrl } }));
      } catch (e) {
        // Non-fatal: keep using direct URL; waveform may still work if server sends proper CORS
        dbg('[VideoPreview] Failed to convert to blob, using direct URL:', e.message);
      }
    })();

    return () => {
      // Keep blob alive for the session; it will be replaced on next change
    };
  }, [videoUrl, optimizedVideoUrl, useOptimizedPreview, onVideoUrlReady, lastBlobUrlRef]);

  // Handle video source switching while preserving playback state
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    // Store current state before source change
    const wasPlaying = !videoElement.paused;
    const currentVideoTime = videoElement.currentTime;

    // Determine the new source
    const newSrc = useOptimizedPreview && optimizedVideoUrl ? optimizedVideoUrl : videoUrl;

    // Only update if the source actually changed
    if (newSrc && videoElement.src !== newSrc) {
      dbg('[VideoPreview] Switching video source, preserving state:', {
        wasPlaying,
        currentVideoTime,
        useOptimizedPreview,
        optimizedVideoUrl: !!optimizedVideoUrl,
        videoUrl: !!videoUrl,
        newSrc: newSrc.substring(0, 50) + '...'
      });

      // Pause the video first to prevent UI state issues
      if (wasPlaying) {
        videoElement.pause();
      }

      // Immediately update UI to reflect paused state during transition
      setIsPlaying(false);

      // Set new source
      videoElement.src = newSrc;

      // Handle the load event to restore state
      const handleLoadedData = () => {
        // Restore time position (with safety checks)
        if (currentVideoTime > 0 && videoElement.duration && currentVideoTime < videoElement.duration) {
          videoElement.currentTime = currentVideoTime;
        }

        // Restore play state
        if (wasPlaying) {
          videoElement.play().then(() => {
            dbg('[VideoPreview] Successfully resumed playback after source switch');
            setIsPlaying(true);

            // Double-check UI state after a short delay to ensure synchronization
            setTimeout(() => {
              const actuallyPlaying = !videoElement.paused;
              if (actuallyPlaying !== isPlaying) {
                dbg('[VideoPreview] Correcting UI state mismatch:', { actuallyPlaying, uiState: isPlaying });
                setIsPlaying(actuallyPlaying);
              }
            }, 100);
          }).catch(error => {
            console.warn('[VideoPreview] Could not auto-resume playback:', error);
            // Ensure UI reflects the actual state
            setIsPlaying(false);
          });
        } else {
          // Ensure UI reflects paused state and controls are clickable
          setIsPlaying(false);
        }

        // Clean up event listener
        videoElement.removeEventListener('loadeddata', handleLoadedData);
      };

      // Handle loading errors
      const handleLoadError = () => {
        console.error('[VideoPreview] Error loading new video source');
        setIsPlaying(false);
        videoElement.removeEventListener('loadeddata', handleLoadedData);
        videoElement.removeEventListener('error', handleLoadError);
      };

      // Add event listeners
      videoElement.addEventListener('loadeddata', handleLoadedData);
      videoElement.addEventListener('error', handleLoadError);

      // Load the new source
      videoElement.load();

      // Additional safety: sync UI state after source change is complete
      const syncTimeout = setTimeout(() => {
        const actuallyPlaying = !videoElement.paused;
        if (actuallyPlaying !== isPlaying) {
          dbg('[VideoPreview] Final UI state sync after source switch:', { actuallyPlaying, uiState: isPlaying });
          setIsPlaying(actuallyPlaying);
        }
      }, 500); // Give enough time for the video to load and play if needed

      // Clean up timeout if component unmounts
      return () => {
        clearTimeout(syncTimeout);
        videoElement.removeEventListener('loadeddata', handleLoadedData);
        videoElement.removeEventListener('error', handleLoadError);
      };
    }
  }, [useOptimizedPreview, optimizedVideoUrl, videoUrl, isPlaying, videoRef, setIsPlaying]);
};

export default useVideoSourceSwitching;
