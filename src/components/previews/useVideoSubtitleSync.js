import { useEffect } from 'react';
import { convertTimeStringToSeconds } from '../../utils/vttUtils';
import { dbg } from './videoPreviewDebug';

/**
 * Wires the native <video> element's lifecycle events for the preview:
 *   - loadedmetadata -> mark loaded + report duration;
 *   - error -> surface a translated, code-specific error message;
 *   - timeupdate -> throttled currentTime push, resolve the active subtitle for
 *     the custom overlay, and mirror it into the fullscreen overlay DOM;
 *   - play/pause -> track play state in lastPlayStateRef (no re-render);
 *   - seeking/seeked -> manage the seek lock and notify the parent via onSeek.
 *
 * Shared refs (videoRef, seekLockRef, lastTimeUpdateRef, lastPlayStateRef) and
 * all state setters stay in the parent and are passed in.
 */
const useVideoSubtitleSync = ({
  videoRef,
  videoUrl,
  t,
  setError,
  setIsLoaded,
  setDuration,
  setCurrentTime,
  setCurrentSubtitleText,
  seekLockRef,
  lastTimeUpdateRef,
  lastPlayStateRef,
  isDragging,
  onSeek,
  subtitlesArray,
  translatedSubtitles,
  subtitleSettings,
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
      // Only log in development mode
      if (process.env.NODE_ENV === 'development') {
        // Development logging is intentionally disabled.
      }
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
          const currentVideoTime = videoElement.currentTime;
          setCurrentTime(currentVideoTime);
          lastTimeUpdateRef.current = now;

          // Determine which subtitle array to use based on settings
          const useTranslated = subtitleSettings.showTranslatedSubtitles && translatedSubtitles && translatedSubtitles.length > 0;
          const subtitlesToUse = useTranslated ? translatedSubtitles : subtitlesArray;

          // Find the current subtitle based on the video's current time
          if (subtitlesToUse && subtitlesToUse.length > 0) {
            const currentSub = subtitlesToUse.find(sub => {
              // Handle both numeric and string time formats
              const startTime = typeof sub.start === 'number' ? sub.start :
                               (typeof sub.startTime === 'string' ? convertTimeStringToSeconds(sub.startTime) :
                               convertTimeStringToSeconds(sub.start));
              const endTime = typeof sub.end === 'number' ? sub.end :
                             (typeof sub.endTime === 'string' ? convertTimeStringToSeconds(sub.endTime) :
                             convertTimeStringToSeconds(sub.end));
              return currentVideoTime >= startTime && currentVideoTime <= endTime;
            });

            // Update the current subtitle text
            if (currentSub) {
              setCurrentSubtitleText(currentSub.text);
              // Only log in development mode and throttle to avoid excessive logging
              if (process.env.NODE_ENV === 'development') {
                // Store the last logged subtitle to avoid logging the same one repeatedly
                if (!window._lastLoggedSubtitle || window._lastLoggedSubtitle !== currentSub.text) {

                  window._lastLoggedSubtitle = currentSub.text;
                }
              }

              // Update fullscreen subtitle if in fullscreen mode
              const container = document.getElementById('fullscreen-subtitle-overlay');

              if (container) {
                // Clear existing content
                container.innerHTML = '';

                // Create subtitle element
                const subtitle = document.createElement('div');
                subtitle.id = 'fullscreen-subtitle';
                dbg('ðŸŽ¬ SUBTITLE - Created subtitle element');

                // Handle newlines by splitting the text and adding <br> tags
                const lines = currentSub.text.split('\n');
                lines.forEach((line, index) => {
                  if (index > 0) {
                    subtitle.appendChild(document.createElement('br'));
                  }
                  subtitle.appendChild(document.createTextNode(line));
                });

                // Apply styles
                subtitle.style.display = 'inline-block';
                subtitle.style.backgroundColor = `rgba(${parseInt(subtitleSettings.backgroundColor.slice(1, 3), 16)},
                                               ${parseInt(subtitleSettings.backgroundColor.slice(3, 5), 16)},
                                               ${parseInt(subtitleSettings.backgroundColor.slice(5, 7), 16)},
                                               ${subtitleSettings.opacity || '0.7'})`;
                subtitle.style.color = subtitleSettings.textColor || '#ffffff';
                subtitle.style.padding = `${subtitleSettings.backgroundPadding || '10'}px`;
                subtitle.style.borderRadius = `${subtitleSettings.backgroundRadius || '4'}px`;
                subtitle.style.fontFamily = subtitleSettings.fontFamily || 'Arial, sans-serif';
                subtitle.style.fontVariationSettings = subtitleSettings.fontVariationSettings || 'normal';
                subtitle.style.fontSize = `${subtitleSettings.fontSize || '24'}px`;
                subtitle.style.fontWeight = subtitleSettings.fontWeight || '400';
                subtitle.style.lineHeight = subtitleSettings.lineSpacing || '1.4';
                subtitle.style.letterSpacing = `${subtitleSettings.letterSpacing || '0'}px`;
                subtitle.style.textTransform = subtitleSettings.textTransform || 'none';
                subtitle.style.textShadow = subtitleSettings.textShadow === true || subtitleSettings.textShadow === 'true' ?
                                          '1px 1px 2px rgba(0, 0, 0, 0.8)' : 'none';
                subtitle.style.maxWidth = '100%';
                subtitle.style.overflowWrap = 'break-word';

                // Add to container
                container.appendChild(subtitle);
                dbg('ðŸŽ¬ SUBTITLE - Subtitle added to container');
              }
            } else {
              setCurrentSubtitleText('');

              // Clear fullscreen subtitle if in fullscreen mode
              const container = document.getElementById('fullscreen-subtitle-overlay');
              if (container) {
                container.innerHTML = '';
              }
            }
          }
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
  }, [videoUrl, setCurrentTime, setDuration, t, onSeek, subtitlesArray, translatedSubtitles, subtitleSettings, isDragging, videoRef, setError, setIsLoaded, setCurrentSubtitleText, seekLockRef, lastTimeUpdateRef, lastPlayStateRef]);
};

export default useVideoSubtitleSync;
