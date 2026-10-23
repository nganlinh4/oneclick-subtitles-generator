// Presentation and project-ownership guards for one subtitle generation run.
import { getActiveProjectSnapshot } from '../platform/projectService';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import { loadExactProjectSubtitles } from '../platform/subtitleProjectStore';
import { assertAutoGenerationContextCurrent } from '../utils/autoGenerationOwnership';
import { getCurrentCacheId as getRulesCacheId } from '../utils/transcriptionRulesStore';
import { getCurrentCacheId as getSubtitlesCacheId } from '../utils/userSubtitlesStore';

/**
 * The run that most recently claimed `ownerRef` is the only one allowed to publish status or rows,
 * and only while its delivery project is still the active one (and its auto-run is current).
 */
export const createGenerationPresentation = ({
    runId,
    autoRunContext,
    ownerRef,
    setStatus,
    setSubtitlesData,
}) => {
    let deliveryContext = null;
    const presentationToken = Object.freeze({ runId });
    ownerRef.current = presentationToken;
    const ownsPresentation = () => (
        ownerRef.current === presentationToken
    );
    const canPresent = () => {
        if (!ownsPresentation()) return false;
        if (isDesktopRuntime()) {
            const currentCache = typeof getSubtitlesCacheId === 'function' ? getSubtitlesCacheId() : null;
            if (deliveryContext?.cacheId && currentCache && currentCache !== deliveryContext.cacheId) {
                return false;
            }
            const activeProject = typeof getActiveProjectSnapshot === 'function' ? getActiveProjectSnapshot() : null;
            if (deliveryContext?.projectId && activeProject?.metadata?.id && activeProject.metadata.id !== deliveryContext.projectId) {
                return false;
            }
        }
        if (!autoRunContext) return true;
        try {
            assertAutoGenerationContextCurrent(autoRunContext);
            return true;
        } catch {
            return false;
        }
    };
    const setGenerationStatus = (value) => {
        if (canPresent()) setStatus(value);
    };
    const setGenerationSubtitlesData = (value) => {
        if (!canPresent()) return undefined;
        if (typeof value === 'function') {
            return setSubtitlesData((current) => {
                if (!canPresent()) return current;
                return value(current);
            });
        }
        return setSubtitlesData(value);
    };
    return {
        ownsPresentation,
        canPresent,
        setGenerationStatus,
        setGenerationSubtitlesData,
        releasePresentation: () => {
            if (ownsPresentation()) ownerRef.current = null;
        },
        getDeliveryContext: () => deliveryContext,
        bindDeliveryContext: (context) => {
            deliveryContext = context;
            return context;
        },
    };
};

/**
 * Validator for a manual run: the presented project, both per-project stores and (when required)
 * the active native media must still name the run's context before and after the durable read.
 */
export const createActiveProjectValidator = ({
    canPresent,
    refreshNativeMedia,
    getNativeProjectId = null,
    message,
}) => {
    const stillOwned = (context) => canPresent()
        && getRulesCacheId() === context.cacheId
        && getSubtitlesCacheId() === context.cacheId
        && (getNativeProjectId === null || getNativeProjectId() === context.projectId);
    return async (context) => {
        await refreshNativeMedia();
        if (!stillOwned(context)) throw new Error(message);
        await loadExactProjectSubtitles(context.cacheId, context.projectId);
        await refreshNativeMedia();
        if (!stillOwned(context)) throw new Error(message);
        return context;
    };
};
