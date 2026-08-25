import { generateFileCacheId } from '../utils/cacheUtils';
import { getVideoDuration } from '../utils/videoProcessor';
import { activateSubtitleProjectBinding } from '../platform/subtitleProjectBinding';
import {
    generateUrlBasedCacheId,
    getCachedSubtitles as checkCachedSubtitles
} from '../services/subtitleCache';
import { isNativeMediaDescriptor } from '../platform/mediaService';
import { isDesktopRuntime } from '../platform/desktopRuntime';
import {
    resolveActiveNativeMedia,
} from '../platform/activeNativeMedia';

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
 * Read a cache candidate without mutating presentation state.
 *
 * The generation transaction validates exact project ownership on both sides of this async read,
 * then owns any hit/miss presentation change. Keeping this helper pure prevents an A-to-B project
 * switch from publishing A's rows or A's miss into B.
 *
 * @returns {Promise<{cacheHit: boolean}>} cacheHit true means the caller should return true early
 */
export const loadCachedSubtitlesIfAvailable = async ({
    cacheId,
    segment,
    currentVideoUrl,
}) => {
    if (cacheId && !segment) {
        const cachedSubtitles = await checkCachedSubtitles(cacheId, currentVideoUrl);

        if (cachedSubtitles) {
            return { cacheHit: true, cachedSubtitles };
        }
    }

    return { cacheHit: false, cachedSubtitles: null };
};
