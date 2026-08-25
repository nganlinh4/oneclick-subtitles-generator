import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { EVENTS, publish, subscribe } from '../events/bus';
import { CHECKPOINT_SOURCE } from '../events/constants';
import { saveSubtitlesToCache } from '../services/subtitleCache';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import {
  refreshActiveNativeMedia,
  resolveActiveNativeMedia,
} from '../platform/activeNativeMedia';
import { getCurrentCacheId as getSubtitleContextCacheId } from '../utils/userSubtitlesStore';
import { flushDurableLyricsHistory } from '../platform/durableLyricsHistory';

const notifySaved = (message) => {
  try {
    window.addToast?.(message, 'success', 3000);
  } catch {
    // Notification failure cannot reverse an acknowledged subtitle checkpoint.
  }
};

const notifySaveFailed = (message) => {
  try {
    window.addToast?.(message, 'error', 8_000, 'subtitle-save-failed');
  } catch {
    // Notification failure cannot change the failed durable checkpoint.
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
    const refuse = () => {
      if (options?.silentFailure !== true) {
        notifySaveFailed(t(
          'subtitlesInput.saveFailed',
          'The subtitles could not be saved. Please try again.'
        ));
      }
      return false;
    };
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
      let cacheId = getSubtitleContextCacheId();
      let mediaCapability = null;

      if (desktopRuntime) {
        mediaCapability = await resolveActiveNativeMedia();
        if (cacheId !== mediaCapability.cacheId) return refuse();
      }

      if (!cacheId) {
        console.error('No cache ID found for current media');
        return refuse();
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
        const result = await saveSubtitlesToCache(cacheId, subtitlesToSave, {
          expectedProjectId: mediaCapability.projectId,
        });
        if (!result.success
            || result.cacheId !== mediaCapability.cacheId
            || result.projectId !== mediaCapability.projectId) {
          console.error('Failed to save subtitles:', result.error);
          return refuse();
        }
        await refreshActiveNativeMedia(mediaCapability);

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
          return refuse();
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
      return refuse();
    }
  }, [lyrics, onSaveSubtitles, t, updateSavedLyrics]);

  // Listen for save-before-update events triggered before new video processing results
  useEffect(() => {
    // Desktop checkpoints flush the durable editor owner directly in lifecycleOrchestrator.
    // Keeping this listener active there would reintroduce a second writer from stale React state.
    if (!listenForLifecycle || isDesktopRuntime()) return undefined;
    const handleSaveBeforeUpdate = (event) => {


      // Handle both segment processing start and video processing complete
      const isSegmentStart = event.detail?.source === CHECKPOINT_SOURCE.SEGMENT_PROCESSING_START;
      const isGenerationStart = event.detail?.source === CHECKPOINT_SOURCE.GENERATION_START;
      const isProcessingComplete = event.detail?.source === CHECKPOINT_SOURCE.VIDEO_PROCESSING_COMPLETE;
      const isAutoGenerationStart = event.detail?.source === CHECKPOINT_SOURCE.AUTO_GENERATION_START;
      const isTranslationStart = event.detail?.source === CHECKPOINT_SOURCE.TRANSLATION_START;

      if (isSegmentStart || isGenerationStart || isProcessingComplete || isAutoGenerationStart || isTranslationStart) {
        const action = isSegmentStart
          ? 'segment processing'
          : (isGenerationStart
              ? 'generation'
              : (isAutoGenerationStart
              ? 'automatic generation'
              : (isTranslationStart ? 'translation' : 'video processing completion')));


        // Trigger the save function to checkpoint current edits
        handleSave({ allowEmptyCheckpoint: true, silentFailure: true }).then((success) => {
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
    // Native generation commits an exact-project receipt before it publishes success. A second
    // event-driven save is browser compatibility only and must never race that native commit.
    if (!listenForLifecycle || isDesktopRuntime()) return undefined;
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
