import { getCachedSubtitles as checkCachedSubtitles } from '../services/subtitleCache';
import { isNativeMediaDescriptor } from '../platform/mediaService';
import { resolveActiveNativeMedia } from '../platform/activeNativeMedia';

/**
 * Cache helpers behind generateSubtitles/retryGeneration: the run's cache ID and a pure cache
 * read whose presentation the caller owns.
 */

/**
 * The cache ID of a generation run is the subtitle alias of the active native media.
 *
 * @returns {Promise<string>} the resolved cache ID
 */
export const resolveCacheIdForGeneration = async ({ input }) => {
    const capability = await resolveActiveNativeMedia({
        candidate: isNativeMediaDescriptor(input) ? input : null,
    });
    return capability.cacheId;
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
}) => {
    if (cacheId && !segment) {
        const cachedSubtitles = await checkCachedSubtitles(cacheId, null);

        if (cachedSubtitles) {
            return { cacheHit: true, cachedSubtitles };
        }
    }

    return { cacheHit: false, cachedSubtitles: null };
};
