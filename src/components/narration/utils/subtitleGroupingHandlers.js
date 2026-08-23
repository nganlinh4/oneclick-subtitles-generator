import { DEFAULT_FAST_TEXT_MODEL_ID } from '../../../config/geminiModels';
import { groupSubtitlesForNarration } from '../../../services/gemini/subtitleGroupingService';
import {
  acknowledgeProjectSubtitleGrouping,
  captureProjectSubtitleGrouping,
  clearProjectSubtitleGrouping,
  loadProjectSubtitleGrouping,
  persistProjectSubtitleGrouping,
} from '../../../platform/projectSubtitleGroupingStore';

const selectedSource = ({
  subtitleSource,
  hasTranslatedSubtitles,
  translatedSubtitles,
  originalSubtitles,
}) => ({
  sourceType: subtitleSource === 'translated' ? 'translated' : 'original',
  subtitles: subtitleSource === 'translated' && hasTranslatedSubtitles
    ? translatedSubtitles
    : originalSubtitles,
});

const publishCompatibilityProjection = (enabled, rows) => {
  window.useGroupedSubtitles = enabled;
  window.groupedSubtitles = rows;
};

/**
 * Toggle project-owned narration grouping. Provider output is never visible until the exact
 * project/source record has been persisted, reread, and its native result delivery acknowledged.
 */
export const handleGroupingToggle = async (checked, {
  groupedSubtitles,
  subtitleSource,
  hasTranslatedSubtitles,
  translatedSubtitles,
  originalSubtitles,
  translatedLanguage,
  originalLanguage,
  groupingIntensity,
  setUseGroupedSubtitles,
  setGroupedSubtitles,
  setIsGroupingSubtitles,
}) => {
  const source = selectedSource({
    subtitleSource,
    hasTranslatedSubtitles,
    translatedSubtitles,
    originalSubtitles,
  });

  if (!checked) {
    setIsGroupingSubtitles?.(true);
    try {
      if (Array.isArray(source.subtitles) && source.subtitles.length > 0) {
        await clearProjectSubtitleGrouping({
          ...source,
          intensity: groupingIntensity,
        });
      }
      setGroupedSubtitles?.(null);
      setUseGroupedSubtitles(false);
      publishCompatibilityProjection(false, null);
      return true;
    } catch (error) {
      console.error('Could not durably disable subtitle grouping:', error);
      return false;
    } finally {
      setIsGroupingSubtitles?.(false);
    }
  }

  if (!Array.isArray(source.subtitles) || source.subtitles.length === 0) {
    setUseGroupedSubtitles(false);
    return false;
  }

  setIsGroupingSubtitles?.(true);
  try {
    // A durable record survives an acknowledgement failure or process crash. Reuse and consume it
    // before asking the provider to perform duplicate work.
    const existing = await loadProjectSubtitleGrouping({
      ...source,
      intensity: groupingIntensity,
    });
    if (existing !== null) {
      setGroupedSubtitles?.(existing.groupedSubtitles);
      setUseGroupedSubtitles(true);
      publishCompatibilityProjection(true, existing.groupedSubtitles);
      return true;
    }

    const context = await captureProjectSubtitleGrouping({
      ...source,
      intensity: groupingIntensity,
    });
    const languageCode = source.sourceType === 'translated'
      ? translatedLanguage?.languageCode
      : originalLanguage?.languageCode;
    const result = await groupSubtitlesForNarration(
      context.sourceRows,
      languageCode || 'en',
      DEFAULT_FAST_TEXT_MODEL_ID,
      groupingIntensity,
      {
        projectId: context.projectId,
        expectedProjectStateVersion: context.projectStateVersion,
      }
    );
    const receipt = await persistProjectSubtitleGrouping(context, result);
    const record = await acknowledgeProjectSubtitleGrouping(receipt);

    setGroupedSubtitles?.(record.groupedRows);
    setUseGroupedSubtitles(true);
    publishCompatibilityProjection(true, record.groupedRows);
    return true;
  } catch (error) {
    // No fallback grouping and no early UI publication: the durable native delivery remains
    // claimable when parsing, ownership, persistence, or acknowledgement fails.
    console.error('Could not group subtitles for narration:', error);
    if (!Array.isArray(groupedSubtitles) || groupedSubtitles.length === 0) {
      setUseGroupedSubtitles(false);
    }
    return false;
  } finally {
    setIsGroupingSubtitles?.(false);
  }
};
