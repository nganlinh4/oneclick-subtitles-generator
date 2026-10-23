import { abortVideoAnalysis } from '../../services/videoAnalysisService';
import {
  getCurrentCacheId as getSubtitlesCacheId,
  setUserProvidedSubtitlesForCache,
} from '../../utils/userSubtitlesStore';
import { resolveProjectForCache } from '../../platform/subtitleProjectStore';
import {
  refreshActiveNativeMedia,
  resolveActiveNativeMedia,
  revalidateActiveNativeMedia,
} from '../../platform/activeNativeMedia';

/**
 * Hook for modal-related handlers
 */
export const useModalHandlers = (appState) => {
  const {
    setStatus,
    setUserProvidedSubtitlesState,
    setUseUserProvidedSubtitles,
    t = (key, defaultValue) => defaultValue // Provide a default implementation if t is not available
  } = appState;

  /**
   * Handle adding or updating user-provided subtitles
   */
  const handleUserSubtitlesAdd = async (subtitlesText) => {
    const mediaCapability = await resolveActiveNativeMedia();
    const cacheId = mediaCapability.cacheId;
    if (!cacheId) throw new Error('The active subtitle project is unavailable.');
    if (getSubtitlesCacheId() !== cacheId) throw new Error('The active subtitle project changed.');
    const project = await resolveProjectForCache(cacheId, { create: false });
    await revalidateActiveNativeMedia(mediaCapability);
    if (!project?.projectId
        || project.projectId !== mediaCapability.projectId
        || getSubtitlesCacheId() !== cacheId) {
      throw new Error('The active subtitle project changed.');
    }
    await setUserProvidedSubtitlesForCache(cacheId, subtitlesText, {
      expectedProjectId: project.projectId,
    });
    const projectAfterWrite = await resolveProjectForCache(cacheId, { create: false });
    await refreshActiveNativeMedia(mediaCapability);
    if (getSubtitlesCacheId() !== cacheId
        || projectAfterWrite?.projectId !== project.projectId) {
      throw new Error('The active subtitle project changed.');
    }
    setUserProvidedSubtitlesState(subtitlesText);

    // The enablement flag is part of the same persisted result. Clearing the
    // text must not leave timing-generation enabled with no source lines.
    const hasProvidedSubtitles = typeof subtitlesText === 'string'
      && subtitlesText.trim() !== '';
    setUseUserProvidedSubtitles(hasProvidedSubtitles);

  };

  /**
   * Handle aborting video analysis
   */
  const handleAbortVideoAnalysis = () => {
    const analysisAborted = abortVideoAnalysis();
    if (analysisAborted) {
      // If video analysis was aborted, update the status
      setStatus({ message: t('output.videoAnalysisAborted', 'Video analysis aborted'), type: 'warning' });
    }
    return analysisAborted;
  };

  return {
    handleUserSubtitlesAdd,
    handleAbortVideoAnalysis
  };
};
