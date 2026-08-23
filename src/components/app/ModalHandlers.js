import { abortVideoAnalysis } from '../../services/videoAnalysisService';
import {
  getCurrentCacheId as getRulesCacheId,
  setTranscriptionRulesForCache,
} from '../../utils/transcriptionRulesStore';
import {
  getCurrentCacheId as getSubtitlesCacheId,
  setUserProvidedSubtitlesForCache,
} from '../../utils/userSubtitlesStore';
import { isNativeMediaDescriptor } from '../../platform/mediaService';
import { generateFileCacheId } from '../../utils/cacheUtils';
import { resolveProjectForCache } from '../../platform/subtitleProjectStore';
import {
  refreshActiveNativeMedia,
  resolveActiveNativeMedia,
  revalidateActiveNativeMedia,
} from '../../platform/activeNativeMedia';
import { isDesktopRuntime } from '../../platform/desktopRuntime';

const rulesEditorContexts = new WeakMap();

/**
 * Hook for modal-related handlers
 */
export const useModalHandlers = (appState) => {
  const {
    setTranscriptionRulesState,
    setShowRulesEditor,
    setStatus,
    setUserProvidedSubtitlesState,
    setUseUserProvidedSubtitles,
    uploadedFile,
    t = (key, defaultValue) => defaultValue // Provide a default implementation if t is not available
  } = appState;
  let rulesEditorContextRef = rulesEditorContexts.get(setShowRulesEditor);
  if (!rulesEditorContextRef) {
    rulesEditorContextRef = { current: null };
    rulesEditorContexts.set(setShowRulesEditor, rulesEditorContextRef);
  }

  const captureRulesEditorContext = async () => {
    const mediaCapability = isDesktopRuntime() ? await resolveActiveNativeMedia() : null;
    const cacheId = mediaCapability?.cacheId ?? await getCacheIdForCurrentVideo();
    if (!cacheId
        || getRulesCacheId() !== cacheId
        || getSubtitlesCacheId() !== cacheId) {
      throw new Error('The active subtitle project changed.');
    }
    const project = await resolveProjectForCache(cacheId, { create: false });
    if (mediaCapability) await revalidateActiveNativeMedia(mediaCapability);
    if (!project?.projectId
        || (mediaCapability && project.projectId !== mediaCapability.projectId)
        || getRulesCacheId() !== cacheId
        || getSubtitlesCacheId() !== cacheId) {
      throw new Error('The active subtitle project changed.');
    }
    return Object.freeze({ cacheId, projectId: project.projectId, mediaCapability });
  };

  /**
   * Handle saving the edited transcription rules
   */
  const handleSaveRules = async (editedRules) => {
    const context = await (rulesEditorContextRef.current ?? captureRulesEditorContext());
    if (getRulesCacheId() !== context.cacheId
        || getSubtitlesCacheId() !== context.cacheId) {
      throw new Error('The active subtitle project changed.');
    }
    await setTranscriptionRulesForCache(context.cacheId, editedRules, {
      expectedProjectId: context.projectId,
    });
    const projectAfterWrite = await resolveProjectForCache(context.cacheId, { create: false });
    if (context.mediaCapability) await refreshActiveNativeMedia(context.mediaCapability);
    if (getRulesCacheId() !== context.cacheId
        || getSubtitlesCacheId() !== context.cacheId
        || projectAfterWrite?.projectId !== context.projectId) {
      throw new Error('The active subtitle project changed.');
    }
    setTranscriptionRulesState(editedRules);

  };

  /**
   * Handle viewing transcription rules
   */
  const handleViewRules = async () => {
    try {
      rulesEditorContextRef.current = await captureRulesEditorContext();
      setShowRulesEditor(true);
      return true;
    } catch {
      setStatus({
        message: t('errors.activeProjectChanged', 'The active subtitle project changed.'),
        type: 'error',
      });
      return false;
    }
  };

  /**
   * Handle adding or updating user-provided subtitles
   */
  const handleUserSubtitlesAdd = async (subtitlesText) => {
    const mediaCapability = isDesktopRuntime() ? await resolveActiveNativeMedia() : null;
    const cacheId = mediaCapability?.cacheId ?? await getCacheIdForCurrentVideo();
    if (!cacheId) throw new Error('The active subtitle project is unavailable.');
    if (getSubtitlesCacheId() !== cacheId) throw new Error('The active subtitle project changed.');
    const project = await resolveProjectForCache(cacheId, { create: false });
    if (mediaCapability) await revalidateActiveNativeMedia(mediaCapability);
    if (!project?.projectId
        || (mediaCapability && project.projectId !== mediaCapability.projectId)
        || getSubtitlesCacheId() !== cacheId) {
      throw new Error('The active subtitle project changed.');
    }
    await setUserProvidedSubtitlesForCache(cacheId, subtitlesText, {
      expectedProjectId: project.projectId,
    });
    const projectAfterWrite = await resolveProjectForCache(cacheId, { create: false });
    if (mediaCapability) await refreshActiveNativeMedia(mediaCapability);
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
   * Get cache ID for the current video source using unified approach
   */
  const getCacheIdForCurrentVideo = async () => {
    const rulesCacheId = getRulesCacheId();
    const subtitlesCacheId = getSubtitlesCacheId();
    if (isDesktopRuntime()) {
      const capability = await resolveActiveNativeMedia();
      if ((rulesCacheId !== null && rulesCacheId !== capability.cacheId)
          || (subtitlesCacheId !== null && subtitlesCacheId !== capability.cacheId)) {
        return null;
      }
      return capability.cacheId;
    }
    if (rulesCacheId && rulesCacheId === subtitlesCacheId) return rulesCacheId;
    if (rulesCacheId || subtitlesCacheId) return null;

    // Browser-only compatibility is explicit input state; it never reads the desktop mirrors.
    if (isNativeMediaDescriptor(uploadedFile)) return uploadedFile.assetId;
    if (uploadedFile instanceof File) return await generateFileCacheId(uploadedFile);
    return null;
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
    handleSaveRules,
    handleViewRules,
    handleUserSubtitlesAdd,
    getCacheIdForCurrentVideo,
    handleAbortVideoAnalysis
  };
};
