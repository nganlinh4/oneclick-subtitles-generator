import { generateFileCacheId } from '../utils/cacheUtils';
import { getVideoDuration } from '../utils/videoProcessor';
import { activateSubtitleProjectBinding } from '../platform/subtitleProjectBinding';
import {
    generateUrlBasedCacheId,
    getCachedSubtitles as checkCachedSubtitles,
    requireSuccessfulSubtitleCacheSave,
    saveSubtitlesToCache
} from '../services/subtitleCache';
import { isNativeMediaDescriptor } from '../platform/mediaService';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import {
    refreshActiveNativeMedia,
    resolveActiveNativeMedia,
} from '../platform/activeNativeMedia';

// Re-export the shared cache helper so callers have a single import surface.
export { saveSubtitlesToCache };

/**
 * Caching helpers extracted from useSubtitles.
 *
 * These functions own the URL-based vs file-based cache-key resolution and the
 * cache load/save semantics used by generateSubtitles/retryGeneration. They are
 * pure-ish: all side effects (status updates, long-video warning) are threaded
 * through callbacks so behavior stays identical to the original inline code.
 */

/**
 * Resolve the cache ID for a fresh generation run.
 *
 * Mirrors the original inline logic: URL-based caching for YouTube/downloaded
 * videos, file-based caching for true file uploads (with the long-video
 * warning), and sets both rules/subtitles cache stores.
 *
 * @returns {Promise<string|null>} the resolved cache ID (or null when none applies)
 */
export const resolveCacheIdForGeneration = async ({
    input,
    inputType,
    currentVideoUrl,
    t,
    setStatus,
    debugLog: _debugLog
}) => {
    let cacheId = null;

    if (isDesktopRuntime()) {
        const capability = await resolveActiveNativeMedia({
            candidate: isNativeMediaDescriptor(input) ? input : null,
        });
        return capability.cacheId;
    }

    if (inputType === 'youtube' || currentVideoUrl) {
        // Use unified URL-based caching for all video URLs
        const urlToUse = inputType === 'youtube' ? input : currentVideoUrl;
        cacheId = await generateUrlBasedCacheId(urlToUse);

        await activateSubtitleProjectBinding(cacheId);

    } else if (inputType === 'file-upload') {
        // For actual file uploads (not downloaded videos), use file-based cache ID
        cacheId = isNativeMediaDescriptor(input)
            ? input.assetId
            : await generateFileCacheId(input);

        await activateSubtitleProjectBinding(cacheId);


        // Check if this is a video file and get its duration
        if (!isNativeMediaDescriptor(input) && input.type.startsWith('video/')) {
            try {
                const duration = await getVideoDuration(input);
                const durationMinutes = Math.floor(duration / 60);

                // If video is longer than 30 minutes, show warning and use special processing
                if (durationMinutes > 30) {
                    setStatus({
                        message: t('output.longVideoWarning', 'You are uploading a {{duration}} minute video. Uploading progress can be long depends on network speed.', { duration: durationMinutes }),
                        type: 'loading'
                    });
                }
            } catch (error) {
                console.warn('Error getting video duration:', error);
            }
        }
    }

    return cacheId;
};

/**
 * Check the cache and, when subtitles are found, load them immediately.
 *
 * On a cache hit it loads subtitles and signals an early return; the generation
 * transaction owns terminal status publication after any required durability
 * receipt. On a miss it clears the timeline for fresh generation. For segment
 * processing the cache check is skipped and existing subtitles are kept.
 *
 * @returns {Promise<{cacheHit: boolean}>} cacheHit true means the caller should return true early
 */
export const loadCachedSubtitlesIfAvailable = async ({
    cacheId,
    segment,
    currentVideoUrl,
    setSubtitlesData,
    debugLog
}) => {
    if (cacheId && !segment) {
        debugLog('[Subtitle Generation] Checking for cached subtitles with cache ID:', cacheId);
        const cachedSubtitles = await checkCachedSubtitles(cacheId, currentVideoUrl);
        debugLog('[Subtitle Generation] Cache check result:', {
            found: !!cachedSubtitles,
            count: cachedSubtitles ? cachedSubtitles.length : 0
        });

        if (cachedSubtitles) {
            debugLog('[Subtitle Generation] Loading cached subtitles immediately for timeline display');
            setSubtitlesData(cachedSubtitles);
            return { cacheHit: true, cachedSubtitles };
        }
        // If no cached subtitles found, clear the timeline for fresh generation
        debugLog('[Subtitle Generation] No cached subtitles found, clearing timeline for fresh generation');
        setSubtitlesData(null);
    } else if (segment) {
        debugLog('[Subtitle Generation] Skipping cache check for segment processing - generating fresh subtitles');
        // For segment processing, keep existing subtitles (don't clear)
    } else {
        // No cache ID available, clear timeline for fresh generation
        debugLog('[Subtitle Generation] No cache ID available, clearing timeline for fresh generation');
        setSubtitlesData(null);
    }

    return { cacheHit: false, cachedSubtitles: null };
};

/**
 * Resolve the cache ID for a retry run and persist results to cache.
 *
 * Mirrors the original inline retry caching: URL-based for YouTube/downloaded
 * videos, file-based for true uploads, saving the produced subtitles and setting
 * both rules/subtitles cache stores.
 */
export const persistRetryResultToCache = async ({
    input,
    inputType,
    subtitles,
    browserVideoUrl = null,
}) => {
    if (isDesktopRuntime()) {
        const capability = await resolveActiveNativeMedia({
            candidate: isNativeMediaDescriptor(input) ? input : null,
        });
        if (subtitles && subtitles.length > 0) {
            const receipt = await saveSubtitlesToCache(capability.cacheId, subtitles, {
                expectedProjectId: capability.projectId,
            });
            requireSuccessfulSubtitleCacheSave(receipt);
            if (receipt.cacheId !== capability.cacheId
                || receipt.projectId !== capability.projectId) {
                throw new Error('The active subtitle project changed during retry persistence.');
            }
            await refreshActiveNativeMedia(capability);
        }
        return capability.cacheId;
    }

    const currentVideoUrl = inputType === 'youtube'
        ? (typeof input === 'string' ? input : input?.url)
        : browserVideoUrl;
    let cacheId = null;

    if (inputType === 'youtube' || currentVideoUrl) {
        // Use unified URL-based caching
        const urlToUse = inputType === 'youtube' ? input : currentVideoUrl;
        cacheId = await generateUrlBasedCacheId(urlToUse);

        if (cacheId && subtitles && subtitles.length > 0) {
            requireSuccessfulSubtitleCacheSave(await saveSubtitlesToCache(cacheId, subtitles));
        }

        await activateSubtitleProjectBinding(cacheId);

    } else if (inputType === 'file-upload') {
        // For actual file uploads, use file-based cache ID
        cacheId = isNativeMediaDescriptor(input)
            ? input.assetId
            : await generateFileCacheId(input);
        if (cacheId && subtitles && subtitles.length > 0) {
            requireSuccessfulSubtitleCacheSave(await saveSubtitlesToCache(cacheId, subtitles));
        }

        await activateSubtitleProjectBinding(cacheId);

    }
    return cacheId;
};
