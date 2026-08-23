import { useEffect } from 'react';
import { enhanceF5TTSNarrations } from '../../../utils/narrationEnhancer';
import { loadProjectSubtitleGrouping } from '../../../platform/projectSubtitleGroupingStore';
import { getActiveProjectSnapshot } from '../../../platform/projectService';
import {
  publishProjectNarrationGrouping,
  publishProjectNarrationResults,
} from '../../../platform/projectNarrationState';

const activeAuthority = () => {
  const snapshot = getActiveProjectSnapshot();
  return snapshot?.metadata?.id && Number.isSafeInteger(snapshot.stateVersion)
    ? { projectId: snapshot.metadata.id, projectStateVersion: snapshot.stateVersion }
    : null;
};

/**
 * Custom hook for managing window state objects for narration
 * @param {Object} params - Parameters
 * @param {Array} params.generationResults - Current generation results
 * @param {string} params.subtitleSource - Selected subtitle source
 * @param {string} params.narrationMethod - Selected narration method
 * @param {Array} params.originalSubtitles - Original subtitles
 * @param {Array} params.translatedSubtitles - Translated subtitles
 * @param {Array} params.subtitles - Fallback subtitles
 * @param {boolean} params.useGroupedSubtitles - Whether to use grouped subtitles
 * @param {Array} params.groupedSubtitles - Grouped subtitles
 * @param {Function} params.setGroupedSubtitles - Function to set grouped subtitles
 * @param {Function} params.setUseGroupedSubtitles - Function to set use grouped subtitles state
 * @param {string} params.groupingIntensity - Grouping intensity level
 */
const useWindowStateManager = ({
  generationResults,
  subtitleSource,
  narrationMethod,
  originalSubtitles,
  translatedSubtitles,
  subtitles,
  useGroupedSubtitles,
  groupedSubtitles,
  setGroupedSubtitles,
  setUseGroupedSubtitles,
  groupingIntensity
}) => {
  // Publish one project/revision-owned narration projection. Grouped narration is a real third
  // source, not an alias for whichever original/translated array happened to be populated last.
  useEffect(() => {
    const authority = activeAuthority();
    if (authority === null || !Array.isArray(generationResults)) return;
    const grouped = useGroupedSubtitles === true
      && Array.isArray(groupedSubtitles)
      && groupedSubtitles.length > 0;
    const source = grouped
      ? 'grouped'
      : (subtitleSource === 'translated' ? 'translated' : 'original');
    const cuePlan = grouped
      ? groupedSubtitles
      : (source === 'translated' ? translatedSubtitles : originalSubtitles || subtitles || []);
    const results = narrationMethod === 'f5tts'
      ? enhanceF5TTSNarrations(generationResults, cuePlan || [])
      : generationResults;
    publishProjectNarrationResults({
      ...authority,
      source,
      results,
    });
  }, [
    generationResults,
    groupedSubtitles,
    narrationMethod,
    originalSubtitles,
    subtitleSource,
    subtitles,
    translatedSubtitles,
    useGroupedSubtitles,
  ]);

  // Hydrate only an exact project/source-owned grouping. The durable store also consumes a pending
  // native delivery left behind by a crash after commit but before acknowledgement.
  useEffect(() => {
    const sourceType = subtitleSource === 'translated' ? 'translated' : 'original';
    const sourceSubtitles = sourceType === 'translated'
      ? translatedSubtitles
      : originalSubtitles || subtitles;
    if (!Array.isArray(sourceSubtitles) || sourceSubtitles.length === 0) {
      setGroupedSubtitles(null);
      setUseGroupedSubtitles(false);
      return undefined;
    }
    let disposed = false;
    void loadProjectSubtitleGrouping({
      sourceType,
      subtitles: sourceSubtitles,
      intensity: groupingIntensity,
    }).then((loaded) => {
      if (disposed) return;
      if (loaded === null) {
        setGroupedSubtitles(null);
        setUseGroupedSubtitles(false);
        return;
      }
      setGroupedSubtitles(loaded.groupedSubtitles);
      setUseGroupedSubtitles(true);
    }).catch((error) => {
      if (!disposed) {
        setGroupedSubtitles(null);
        setUseGroupedSubtitles(false);
        console.error('Could not hydrate project subtitle grouping:', error);
      }
    });
    return () => { disposed = true; };
  }, [
    groupingIntensity,
    originalSubtitles,
    setGroupedSubtitles,
    setUseGroupedSubtitles,
    subtitleSource,
    subtitles,
    translatedSubtitles,
    useGroupedSubtitles,
  ]);

  // Save subtitle source to localStorage when it changes
  useEffect(() => {
    if (subtitleSource) {
      try {
        localStorage.setItem('subtitle_source', subtitleSource);
      } catch (error) {
        console.error('Error saving subtitle source to localStorage:', error);
      }
    }
  }, [subtitleSource]);

  // Publish grouping selection through the same project/revision authority as narration results.
  useEffect(() => {
    const authority = activeAuthority();
    if (authority === null) return;
    publishProjectNarrationGrouping({
      ...authority,
      enabled: useGroupedSubtitles === true,
      groupedCues: groupedSubtitles,
      baseSource: subtitleSource === 'translated' ? 'translated' : 'original',
    });
  }, [groupedSubtitles, subtitleSource, useGroupedSubtitles]);

  // Clear grouped subtitles when the original timeline is fully cleared
  // This ensures the Narration planned list disappears when user deletes all subtitles via the timeline action
  useEffect(() => {
    const onTimingChanged = (event) => {
      try {
        const detail = event?.detail || {};
        const updated = detail.updatedLyrics;
        // Only react when timeline reports a clear-range that results in zero subtitles
        if (detail.action === 'clear-range' && Array.isArray(updated) && updated.length === 0) {
          // Only clear grouping when the narration source is the original subtitles
          if (subtitleSource === 'original') {
            // Reset state
            setGroupedSubtitles(null);
            setUseGroupedSubtitles(false);
            // Also clear global originals that some components use as fallback
            window.originalSubtitles = [];
            window.subtitlesData = [];
          }
        }
      } catch (e) {
        // Non-fatal; ignore
      }
    };

    window.addEventListener('subtitle-timing-changed', onTimingChanged);
    return () => window.removeEventListener('subtitle-timing-changed', onTimingChanged);
  }, [subtitleSource, setGroupedSubtitles, setUseGroupedSubtitles]);

  // Listen for translation reset to clear grouped subtitles cache
  useEffect(() => {
    const handleTranslationReset = () => {

      // Clear the grouped subtitles state if we're using translated subtitles
      if (subtitleSource === 'translated') {
        setGroupedSubtitles(null);
        setUseGroupedSubtitles(false);
      }
    };

    const handleTranslationUpdated = (_event) => {
      // Clear the grouped subtitles state if we're using translated subtitles
      if (subtitleSource === 'translated') {
        setGroupedSubtitles(null);
        // Don't disable grouping, just clear the current grouped subtitles
        // so they can be regenerated with the updated translations
      }
    };

    window.addEventListener('translation-reset', handleTranslationReset);
    window.addEventListener('translation-updated', handleTranslationUpdated);

    return () => {
      window.removeEventListener('translation-reset', handleTranslationReset);
      window.removeEventListener('translation-updated', handleTranslationUpdated);
    };
  }, [subtitleSource, setGroupedSubtitles, setUseGroupedSubtitles]);

};

export default useWindowStateManager;
