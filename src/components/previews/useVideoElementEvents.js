import { useEffect } from 'react';

/**
 * Wires the native `<video>` element's lifecycle events for the preview:
 *   - loadedmetadata -> mark loaded + report duration;
 *   - error -> surface a translated, code-specific error message;
 *   - timeupdate -> throttled currentTime push (the playhead every other surface reads);
 *   - play/pause -> track play state in lastPlayStateRef (no re-render);
 *   - seeking/seeked -> manage the seek lock and notify the parent via onSeek.
 *
 * This hook used to be `useVideoSubtitleSync` and used to resolve the active cue and then draw it
 * TWICE — into React state for the CSS overlay, and imperatively into a `#fullscreen-subtitle` div
 * it styled from `subtitleSettings`. Both are gone: subtitles on this surface are drawn only by the
 * native compositor, so the element's job here is the playhead and nothing else. The name changed
 * with the job, because a hook still called "subtitle sync" is an invitation to put subtitle drawing
 * back into it.
 *
 * Shared refs (videoRef, seekLockRef, lastTimeUpdateRef, lastPlayStateRef) and all state setters
 * stay in the parent and are passed in.
 */
const useVideoElementEvents = ({
  videoRef,
  videoUrl,
  t,
  setError,
  setIsLoaded,
  setDuration,
  setCurrentTime,
  seekLockRef,
  lastTimeUpdateRef,
  lastPlayStateRef,
  isDragging,
  onSeek,
}) => {
  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) return;

    // Validate the video URL
    if (!videoUrl) {

      setError(t('preview.videoError', 'No video URL provided.'));
      return;
    }

    // Event handlers
    const handleMetadataLoaded = () => {
      setIsLoaded(true);
      setDuration(videoElement.duration);
      setError(''); // Clear any previous errors
    };

    const handleError = (e) => {
      // Get more detailed information about the error
      let errorDetails = '';
      if (videoElement.error) {
        const errorCode = videoElement.error.code;
        switch (errorCode) {
          case MediaError.MEDIA_ERR_ABORTED:
            errorDetails = 'Video playback was aborted.';
            break;
          case MediaError.MEDIA_ERR_NETWORK:
            errorDetails = 'Network error. Check your internet connection.';
            break;
          case MediaError.MEDIA_ERR_DECODE:
            errorDetails = 'Video decoding error. The file might be corrupted.';
            break;
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorDetails = 'Video format or MIME type is not supported by your browser.';
            break;
          default:
            errorDetails = `Unknown error (code: ${errorCode}).`;
        }
      }

      console.error('Video element error:', e, errorDetails);
      setError(t('preview.videoError', `Error loading video: ${errorDetails}`));
      setIsLoaded(false);
    };

    const handleTimeUpdate = () => {
      // Only update currentTime if we're not in a seek operation or dragging
      if (!seekLockRef.current && !isDragging) {
        // Throttle time updates to reduce unnecessary re-renders
        // Only update if more than 100ms has passed since the last update
        const now = performance.now();
        if (now - lastTimeUpdateRef.current > 100) {
          setCurrentTime(videoElement.currentTime);
          lastTimeUpdateRef.current = now;
        }
      }

      // Update play state in ref to avoid unnecessary re-renders
      const currentlyPlaying = !videoElement.paused;
      if (currentlyPlaying !== lastPlayStateRef.current) {
        lastPlayStateRef.current = currentlyPlaying;
      }
    };

    const handlePlayPauseEvent = () => {
      // Update play state in ref to avoid unnecessary re-renders
      const currentlyPlaying = !videoElement.paused;
      if (currentlyPlaying !== lastPlayStateRef.current) {
        lastPlayStateRef.current = currentlyPlaying;
      }
    };

    const handleSeeking = () => {
      seekLockRef.current = true;
    };

    const handleSeeked = () => {
      // Update the current time immediately when seeking is complete
      setCurrentTime(videoElement.currentTime);
      lastTimeUpdateRef.current = performance.now();

      // Notify parent component about the seek operation
      if (onSeek) {
        onSeek(videoElement.currentTime);
      }

      // Release the seek lock immediately
      seekLockRef.current = false;
    };

    // Add event listeners
    videoElement.addEventListener('loadedmetadata', handleMetadataLoaded);
    videoElement.addEventListener('error', handleError);
    videoElement.addEventListener('timeupdate', handleTimeUpdate);
    videoElement.addEventListener('play', handlePlayPauseEvent);
    videoElement.addEventListener('pause', handlePlayPauseEvent);
    videoElement.addEventListener('seeking', handleSeeking);
    videoElement.addEventListener('seeked', handleSeeked);

    // Clean up
    return () => {
      videoElement.removeEventListener('loadedmetadata', handleMetadataLoaded);
      videoElement.removeEventListener('error', handleError);
      videoElement.removeEventListener('timeupdate', handleTimeUpdate);
      videoElement.removeEventListener('play', handlePlayPauseEvent);
      videoElement.removeEventListener('pause', handlePlayPauseEvent);
      videoElement.removeEventListener('seeking', handleSeeking);
      videoElement.removeEventListener('seeked', handleSeeked);
    };
  }, [
    videoUrl, setCurrentTime, setDuration, t, onSeek, isDragging, videoRef, setError, setIsLoaded,
    seekLockRef, lastTimeUpdateRef, lastPlayStateRef,
  ]);
};

export default useVideoElementEvents;
