import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { saveSubtitlesToCache } from '../services/subtitleCache';
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
 * Saves the editor's lyrics into the active native project. Lifecycle checkpoints flush the durable
 * editor-history owner directly (lifecycleOrchestrator), so this hook registers no event listeners.
 */
export const useLyricsSave = ({
  lyrics,
  updateSavedLyrics,
  onSaveSubtitles,
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

      const cacheId = getSubtitleContextCacheId();
      const mediaCapability = await resolveActiveNativeMedia();
      if (cacheId !== mediaCapability.cacheId) return refuse();

      if (!cacheId) {
        console.error('No cache ID found for current media');
        return refuse();
      }

      const result = await saveSubtitlesToCache(cacheId, lyrics, {
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
        onSaveSubtitles(lyrics);
      }
      window.dispatchEvent(new CustomEvent('subtitles-saved', { detail: { success: true } }));
      window.dispatchEvent(new CustomEvent('subtitle-timing-changed', {
        detail: { action: 'save', timestamp: Date.now(), subtitles: lyrics }
      }));
      return true;
    } catch (error) {
      console.error('Error saving subtitles:', error);
      return refuse();
    }
  }, [lyrics, onSaveSubtitles, t, updateSavedLyrics]);

  return { handleSave };
};
