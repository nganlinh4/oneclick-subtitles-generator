import { cleanupAudioElement, getAudioUrl } from '../../utils/AudioUtils';
import { findSubtitleData, getLatestNarration, calculateAudioStartTime } from './narrationUtils';

/**
 * Hook to handle narration playback
 *
 * @param {Object} videoRef - Reference to the video element
 * @param {number} narrationVolume - Volume level for narration
 * @param {string} narrationSource - Source of narration (original/translated)
 * @param {Object} currentNarration - Current narration being played
 * @param {Function} setCurrentNarration - Setter for current narration
 * @param {Object} audioRefs - References to audio elements
 * @param {Object} audioDurationsRef - References to audio durations
 * @param {string} serverUrl - Server URL for audio files
 * @returns {Object} - Playback functions
 */
const useNarrationPlayback = (
  videoRef,
  narrationVolume,
  narrationSource,
  currentNarration,
  setCurrentNarration,
  audioRefs,
  audioDurationsRef,
  serverUrl
) => {
  /**
   * Play a specific narration
   * @param {Object} narration - Narration to play
   */
  const playNarration = async (narration) => {


    // If we're already playing this narration, don't restart it
    if (currentNarration && currentNarration.subtitle_id === narration.subtitle_id) {

      return;
    }

    // Validate narration object
    if (!narration || !narration.subtitle_id) {
      console.error('Invalid narration object:', narration);
      return;
    }

    // Check if the narration has a filename
    if (!narration.filename) {
      console.error('Narration has no filename:', narration);

      // Try to find the narration in the global arrays and get the filename
      let updatedNarration = null;

      if (narrationSource === 'original' && window.originalNarrations) {
        updatedNarration = window.originalNarrations.find(n => n.subtitle_id === narration.subtitle_id);
      } else if (narrationSource === 'translated' && window.translatedNarrations) {
        updatedNarration = window.translatedNarrations.find(n => n.subtitle_id === narration.subtitle_id);
      }

      if (updatedNarration && updatedNarration.filename) {

        narration = updatedNarration;
      } else {
        console.error('Could not find updated narration with filename in global arrays');


        return;
      }
    }

    // Store the subtitle data with the narration for reference
    if (!narration.subtitleData) {
      const subtitleData = findSubtitleData(narration);

      if (subtitleData) {
        narration.subtitleData = subtitleData;

      } else {
        console.warn('Could not find subtitle data for narration:', narration);
      }
    }

    // Stop any currently playing narration
    if (currentNarration && audioRefs.current[currentNarration.subtitle_id]) {

      audioRefs.current[currentNarration.subtitle_id].pause();
    }

    // Set the current narration
    setCurrentNarration(narration);

    // Get the latest version of the narration
    const latestNarration = getLatestNarration(narration, narrationSource);

    // Always recreate the audio element for retried narrations to ensure we're using the latest version
    // Check if this is a retried narration by comparing the filename with what we might have in audioRefs
    const existingAudio = audioRefs.current[latestNarration.subtitle_id];

    // Consider an audio element for recreation if:
    // 1. It's a retried narration (different filename)
    // 2. It has an error
    // 3. It's in a non-playable state (readyState < 1)
    const isRetried = existingAudio && (
      // Different filename indicates a retry
      (existingAudio.src && !existingAudio.src.includes(latestNarration.filename)) ||
      // Error state indicates we should recreate
      existingAudio.error ||
      // Low readyState indicates potential playback issues
      (existingAudio.readyState < 1)
    );

    if (isRetried) {


      // Clean up the old audio element
      if (existingAudio) {
        cleanupAudioElement(existingAudio);

        // Remove the reference
        delete audioRefs.current[latestNarration.subtitle_id];
      }
    }

    // Get or create audio element for this narration
    if (!audioRefs.current[latestNarration.subtitle_id]) {
      // Get the properly formatted audio URL
      const audioUrl = getAudioUrl(latestNarration, serverUrl);


      // Create a new audio element with event handlers
      const audio = new Audio();

      // Set preload attribute to auto to start loading as soon as possible
      audio.preload = 'auto';

      // Set the source after configuring preload
      audio.src = audioUrl;

      // Set volume immediately
      audio.volume = narrationVolume;


      // Add enhanced error handling
      audio.addEventListener('error', async (e) => {
        console.error('Audio error:', e);
        console.error('Audio error code:', audio.error?.code);
        console.error('Audio error message:', audio.error?.message);

        // Clear current narration if there's an error
        if (currentNarration && currentNarration.subtitle_id === latestNarration.subtitle_id) {

          setCurrentNarration(null);
        }

        // Log detailed error information
        console.error('Audio playback failed for narration:', {
          subtitle_id: latestNarration.subtitle_id,
          filename: latestNarration.filename,
          audioUrl: audio.src,
          error: audio.error
        });
      });

      // Store the audio duration once it's loaded
      audio.addEventListener('loadedmetadata', () => {

        audioDurationsRef.current[latestNarration.subtitle_id] = audio.duration;

        // Set volume again after metadata is loaded
        audio.volume = narrationVolume;

      });

      // Add play event listener
      audio.addEventListener('play', () => {

      });

      // Add ended event listener
      audio.addEventListener('ended', () => {

        if (currentNarration && currentNarration.subtitle_id === latestNarration.subtitle_id) {

          setCurrentNarration(null);
        }
      });

      // Add a safety timeout to ensure the narration state is cleared
      // even if the ended event doesn't fire for some reason
      audio.addEventListener('play', () => {
        const duration = audio.duration || 10; // Default to 10 seconds if duration is unknown
        const safetyTimeout = setTimeout(() => {
          if (currentNarration && currentNarration.subtitle_id === latestNarration.subtitle_id) {

            setCurrentNarration(null);
          }
        }, (duration * 1000) + 1000); // Add 1 second buffer

        // Store the timeout ID on the audio element so we can clear it if needed
        audio._safetyTimeoutId = safetyTimeout;
      });

      // Clear the safety timeout if the audio is paused or ended
      audio.addEventListener('pause', () => {
        if (audio._safetyTimeoutId) {
          clearTimeout(audio._safetyTimeoutId);
          audio._safetyTimeoutId = null;
        }
      });

      audioRefs.current[latestNarration.subtitle_id] = audio;
    } else {
      // Reuse the existing audio element for this narration.
    }

    // Play the narration
    const audioElement = audioRefs.current[latestNarration.subtitle_id];

    // Set volume again before playing
    audioElement.volume = narrationVolume;


    // If we have the subtitle midpoint and audio duration, calculate the start time
    const audioDuration = audioDurationsRef.current[latestNarration.subtitle_id];


    // Calculate the start time for audio playback
    const audioStartTime = calculateAudioStartTime(videoRef, latestNarration, audioDuration);

    // Set the audio start time
    if (audioStartTime > 0) {
      audioElement.currentTime = audioStartTime;

    } else {
      audioElement.currentTime = 0;

    }

    // Try to play the audio
    try {

      // Check if the audio is in a playable state
      if (audioElement.readyState < 2) { // HAVE_CURRENT_DATA = 2


        // Set up a one-time event listener for when the audio is ready
        const loadHandler = () => {

          audioElement.play()

            .catch(error => {
              console.error('Error playing audio:', error);

              // Log detailed error information
              console.error('Failed to play audio:', {
                subtitle_id: latestNarration.subtitle_id,
                filename: latestNarration.filename,
                audioUrl: audioElement.src,
                error: error
              });

              // If the error is about no supported sources, try to reload with a corrected URL
              if (error.name === 'NotSupportedError' && error.message.includes('no supported sources')) {


                // Get the properly formatted audio URL
                const correctedUrl = getAudioUrl(latestNarration, serverUrl);

                if (audioElement.src !== correctedUrl) {

                  audioElement.src = correctedUrl;

                  // Try loading again
                  audioElement.load();
                }
              }
            });
          audioElement.removeEventListener('loadeddata', loadHandler);
        };

        audioElement.addEventListener('loadeddata', loadHandler);

        // Also listen for canplaythrough event which is more reliable
        const canPlayHandler = () => {


          // Clear the timeout since we're ready to play
          if (audioElement._loadTimeoutId) {
            clearTimeout(audioElement._loadTimeoutId);
            audioElement._loadTimeoutId = null;
          }

          audioElement.play()

            .catch(error => {
              console.error('Error playing audio from canplaythrough event:', error);
            });
          audioElement.removeEventListener('canplaythrough', canPlayHandler);
        };

        audioElement.addEventListener('canplaythrough', canPlayHandler);

        // Set a longer timeout in case the loadeddata event never fires
        // Increased from 3 seconds to 8 seconds for better buffering
        audioElement._loadTimeoutId = setTimeout(() => {
          // Clear the timeout ID since it's now executing
          audioElement._loadTimeoutId = null;
          if (audioElement.readyState < 2) {

            audioElement.removeEventListener('loadeddata', loadHandler);
            audioElement.removeEventListener('canplaythrough', canPlayHandler);

            // Force a reload before trying to play
            audioElement.load();

            // Wait a bit more after reload
            setTimeout(() => {
              audioElement.play()

                .catch(error => {
                  console.error('Error playing audio after timeout:', error);

                  // Log detailed error information
                  console.error('Failed to play audio after timeout:', {
                    subtitle_id: latestNarration.subtitle_id,
                    filename: latestNarration.filename,
                    audioUrl: audioElement.src,
                    error: error
                  });

                  // If still failing, try one more time with a corrected URL
                  if (error.name === 'NotSupportedError' && error.message.includes('no supported sources')) {
                    // Get the properly formatted audio URL with explicit http protocol if needed
                    let correctedUrl = getAudioUrl(latestNarration, serverUrl);

                    // If URL doesn't start with http, add it
                    if (!correctedUrl.startsWith('http')) {
                      correctedUrl = `http://${correctedUrl.startsWith('//') ? correctedUrl.slice(2) : correctedUrl}`;
                    }


                    audioElement.src = correctedUrl;
                    audioElement.load();

                    // Final attempt after a short delay
                    setTimeout(() => {
                      audioElement.play()

                        .catch(finalError => {
                          console.error('Final error playing audio:', finalError);
                        });
                    }, 1000);
                  }
                });
            }, 1000);
          }
        }, 8000);
      } else {
        // Audio is ready, play it now
        audioElement.play()

          .catch(error => {
            console.error('Error playing audio:', error);

            // Log detailed error information
            console.error('Failed to play audio:', {
              subtitle_id: latestNarration.subtitle_id,
              filename: latestNarration.filename,
              audioUrl: audioElement.src,
              error: error
            });
          });
      }
    } catch (error) {
      console.error('Exception trying to play audio:', error);

      // Log detailed error information
      console.error('Exception trying to play audio:', {
        subtitle_id: latestNarration.subtitle_id,
        filename: latestNarration.filename,
        error: error
      });
    }
  };

  return { playNarration };
};

export default useNarrationPlayback;
