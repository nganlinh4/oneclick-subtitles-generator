import { useEffect } from 'react';

/**
 * Wires the native `<video>` element's lifecycle events for the preview:
 *   - loadedmetadata -> mark loaded + report duration;
 *   - error -> surface a translated, code-specific error message;
 *
 * `timeupdate`, `seeking`, and `seeked` deliberately belong only to
 * `useVideoSeekCoordinator`; duplicating any of them here can publish stale transport state.
 *
 * This hook used to be `useVideoSubtitleSync` and used to resolve the active cue and then draw it
 * TWICE — into React state for the CSS overlay, and imperatively into a `#fullscreen-subtitle` div
 * it styled from `subtitleSettings`. Both are gone: subtitles on this surface are drawn only by the
 * native compositor, so the element's job here is the playhead and nothing else. The name changed
 * with the job, because a hook still called "subtitle sync" is an invitation to put subtitle drawing
 * back into it.
 *
 * Shared refs and all state setters stay in the parent and are passed in. Play/pause UI state is
 * owned by useVideoControls; keeping a second event mirror here provided no product signal.
 */
const useVideoElementEvents = ({
  videoRef,
  videoUrl,
  t,
  setError,
  setIsLoaded,
  setDuration,
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

    // Add event listeners
    videoElement.addEventListener('loadedmetadata', handleMetadataLoaded);
    videoElement.addEventListener('error', handleError);

    // Clean up
    return () => {
      videoElement.removeEventListener('loadedmetadata', handleMetadataLoaded);
      videoElement.removeEventListener('error', handleError);
    };
  }, [
    videoUrl, setDuration, t, videoRef, setError, setIsLoaded,
  ]);
};

export default useVideoElementEvents;
