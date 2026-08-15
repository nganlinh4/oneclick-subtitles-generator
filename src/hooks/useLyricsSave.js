import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { EVENTS, publish, subscribe } from '../events/bus';
import { CHECKPOINT_SOURCE } from '../events/constants';
import { generateUrlBasedCacheId, saveSubtitlesToCache } from '../services/subtitleCache';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import { getCurrentCacheId as getSubtitleContextCacheId } from '../utils/userSubtitlesStore';
import { flushDurableLyricsHistory } from '../platform/durableLyricsHistory';

const notifySaved = (message) => {
  try {
    window.addToast?.(message, 'success', 3000);
  } catch {
    // Notification failure cannot reverse an acknowledged subtitle checkpoint.
  }
};

/**
 * Encapsulates saving lyrics to cache plus the save-before-update and
 * save-after-streaming event listeners (with cleanup). Closes over the
 * parent's lyrics state and update/save callbacks via params.
 */
export const useLyricsSave = ({
  lyrics,
  updateSavedLyrics,
  onSaveSubtitles,
  listenForLifecycle = true,
}) => {
  const { t } = useTranslation();

  // Function to save current subtitles to cache
  const handleSave = useCallback(async (options = {}) => {
    try {
      await flushDurableLyricsHistory();

      // A first transcription has no previous subtitle rows to checkpoint. The durable-history
      // flush above must still complete so an intentional edit-to-empty is preserved, but an
      // empty initial state must not be sent to the project store as a new subtitle track.
      if (options?.allowEmptyCheckpoint === true
          && Array.isArray(lyrics) && lyrics.length === 0) {
        return true;
      }

      const desktopRuntime = isDesktopRuntime();
      let cacheId = null;

      if (desktopRuntime) {
        cacheId = getSubtitleContextCacheId();
      } else {
        // Preserve the browser compatibility path until media identity is native as well.
        const currentVideoUrl = localStorage.getItem('current_video_url');
        const currentFileUrl = localStorage.getItem('current_file_url');
        if (currentVideoUrl) {
          cacheId = await generateUrlBasedCacheId(currentVideoUrl);
        } else if (currentFileUrl) {
          cacheId = localStorage.getItem('current_file_cache_id');
        }
      }

      if (!cacheId) {
        console.error('No cache ID found for current media');
        return false;
      }

      // Check if we have latest segment subtitles in localStorage
      let subtitlesToSave = lyrics;
      if (!desktopRuntime) {
        try {
          const latestSubtitles = localStorage.getItem('latest_segment_subtitles');
          if (latestSubtitles) {
            const parsedSubtitles = JSON.parse(latestSubtitles);
            if (Array.isArray(parsedSubtitles) && parsedSubtitles.length > 0) {
              subtitlesToSave = parsedSubtitles;
              // Clear the localStorage entry to avoid using it again
              localStorage.removeItem('latest_segment_subtitles');
            }
          }
        } catch (e) {
          console.error('Error parsing latest subtitles from localStorage:', e);
        }
      }

      if (desktopRuntime) {
        const result = await saveSubtitlesToCache(cacheId, subtitlesToSave);
        if (!result.success) {
          console.error('Failed to save subtitles:', result.error);
          return false;
        }

        notifySaved(t('output.subtitlesSaved', 'Progress saved successfully'));
        updateSavedLyrics();
        if (onSaveSubtitles) {
          onSaveSubtitles(subtitlesToSave);
        }
        window.dispatchEvent(new CustomEvent('subtitles-saved', { detail: { success: true } }));
        window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
          detail: { action: 'save', timestamp: Date.now(), subtitles: subtitlesToSave }
        }));
        return true;
      }

      // Save to cache (server when available; local-only in FE-only)
      const { probeServerAvailability } = await import('../utils/serverEnv');
      let hasServer = false;
      try {
        hasServer = await probeServerAvailability();
      } catch {
        // Browser preview continues with its local-only save behavior.
      }

      if (hasServer) {
        const result = await saveSubtitlesToCache(cacheId, subtitlesToSave);
        if (result.success) {
          // Show success toast using centralized system
          notifySaved(t('output.subtitlesSaved', 'Progress saved successfully'));

          // Update the saved lyrics state in the editor
          updateSavedLyrics();

          // Call the callback if provided to update parent component state
          if (onSaveSubtitles) {
            onSaveSubtitles(subtitlesToSave);
          }

          // Notify listeners
          window.dispatchEvent(new CustomEvent('subtitles-saved', { detail: { success: true } }));
          window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
            detail: { action: 'save', timestamp: Date.now(), subtitles: subtitlesToSave }
          }));
          return true;
        } else {
          console.error('Failed to save subtitles:', result.error);
          return false;
        }
      } else {
        // Frontend-only: simulate success (local state + events only)
        // Show success toast using centralized system
        notifySaved(t('output.subtitlesSaved', 'Progress saved successfully'));

        updateSavedLyrics();
        if (onSaveSubtitles) {
          onSaveSubtitles(subtitlesToSave);
        }
        window.dispatchEvent(new CustomEvent('subtitles-saved', { detail: { success: true } }));
        window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
          detail: { action: 'save', timestamp: Date.now(), subtitles: subtitlesToSave }
        }));
        return true;
      }
    } catch (error) {
      console.error('Error saving subtitles:', error);
      return false;
    }
  }, [lyrics, onSaveSubtitles, t, updateSavedLyrics]);

  // Listen for save-before-update events triggered before new video processing results
  useEffect(() => {
    if (!listenForLifecycle) return undefined;
    const handleSaveBeforeUpdate = (event) => {


      // Handle both segment processing start and video processing complete
      const isSegmentStart = event.detail?.source === CHECKPOINT_SOURCE.SEGMENT_PROCESSING_START;
      const isProcessingComplete = event.detail?.source === CHECKPOINT_SOURCE.VIDEO_PROCESSING_COMPLETE;
      const isAutoGenerationStart = event.detail?.source === CHECKPOINT_SOURCE.AUTO_GENERATION_START;
      const isTranslationStart = event.detail?.source === CHECKPOINT_SOURCE.TRANSLATION_START;

      if (isSegmentStart || isProcessingComplete || isAutoGenerationStart || isTranslationStart) {
        const action = isSegmentStart
          ? 'segment processing'
          : (isAutoGenerationStart
              ? 'automatic generation'
              : (isTranslationStart ? 'translation' : 'video processing completion'));


        // Trigger the save function to checkpoint current edits
        handleSave({ allowEmptyCheckpoint: true }).then((success) => {
          // Dispatch save-complete event to notify that save is done
          publish(EVENTS.SAVE_COMPLETE, {
            source: event.detail?.source,
            checkpointId: event.detail?.checkpointId,
            success
          });
        }).catch((error) => {
          console.error(`[LyricsDisplay] Error during checkpoint save for ${action}:`, error);

          // Dispatch save-complete event even on error to prevent hanging
          publish(EVENTS.SAVE_COMPLETE, {
            source: event.detail?.source,
            checkpointId: event.detail?.checkpointId,
            success: false,
            errorCode: 'checkpointSaveFailed'
          });
        });
      }
    };

  const unsubscribe = subscribe(EVENTS.SAVE_BEFORE_UPDATE, handleSaveBeforeUpdate);

    return () => {
  unsubscribe();
    };
  }, [handleSave, listenForLifecycle, updateSavedLyrics]);

  // Listen for save-after-streaming events triggered after streaming completion
  useEffect(() => {
    if (!listenForLifecycle) return undefined;
    const handleSaveAfterStreaming = (event) => {


      // Only trigger save if the event is from streaming completion and we have lyrics
      if (event.detail?.source === 'streaming-complete' && lyrics && lyrics.length > 0) {


        // Trigger the save function to preserve the new streaming results
        handleSave().then((success) => {
          if (!success) {
            console.error('[LyricsDisplay] Auto-save after streaming did not complete');
          }
        }).catch((error) => {
          console.error('[LyricsDisplay] Error during auto-save after streaming:', error);
        });
      }
    };

  const unsubscribe2 = subscribe(EVENTS.SAVE_AFTER_STREAMING, handleSaveAfterStreaming);

    return () => {
  unsubscribe2();
    };
  }, [handleSave, listenForLifecycle, lyrics, updateSavedLyrics]);

  return { handleSave };
};

export default useLyricsSave;
