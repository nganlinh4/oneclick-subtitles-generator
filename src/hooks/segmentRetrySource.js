// Resolves the media a segment retry runs against, bound to the retry's captured asset.
import { isDesktopRuntime } from '../platform/desktopRuntime';
import {
    getSelectedMedia,
    isNativeMediaDescriptor,
    isNativeMediaPlaybackUrl,
} from '../platform/mediaService';
import { fetchBrowserResource } from '../platform/browserFetch';
import {
    SubtitleOperationOwnershipError,
    assertSubtitleOperationCurrent,
} from '../utils/subtitleOperationOwnership';

export const stoppedError = () => new SubtitleOperationOwnershipError('subtitleOperationAborted');

export const assertResolvedSourceMatches = (context, sourceFile) => {
    assertSubtitleOperationCurrent(context);
    if (isNativeMediaDescriptor(sourceFile) && sourceFile.assetId !== context.assetId) {
        throw new SubtitleOperationOwnershipError();
    }
};

export const resolveCachedRetrySource = async (currentSource, url, {
    nativeRuntime = isDesktopRuntime,
    selectedMedia = getSelectedMedia,
    fetchMedia = globalThis.fetch,
    signal,
    validateOwnership,
    expectedAssetId = null,
} = {}) => {
    const validate = async () => {
        if (signal?.aborted) throw stoppedError();
        if (typeof validateOwnership === 'function') await validateOwnership();
        if (signal?.aborted) throw stoppedError();
    };
    await validate();
    const desktop = nativeRuntime();
    if (desktop && isNativeMediaDescriptor(currentSource)
        && currentSource.assetId === expectedAssetId) {
        await validate();
        return Object.freeze({ sourceFile: currentSource, usesOriginalMedia: true });
    }
    if (desktop) {
        const media = await selectedMedia();
        await validate();
        if (!isNativeMediaDescriptor(media)) {
            throw new Error('Select the media again before retrying this segment.');
        }
        if (typeof expectedAssetId !== 'string' || media.assetId !== expectedAssetId) {
            throw new SubtitleOperationOwnershipError();
        }
        return Object.freeze({ sourceFile: media, usesOriginalMedia: true });
    }
    if (currentSource) {
        await validate();
        return Object.freeze({ sourceFile: currentSource, usesOriginalMedia: true });
    }
    if (isNativeMediaPlaybackUrl(url)) {
        throw new Error('Native cached media cannot be fetched by the browser.');
    }
    const init = signal ? { signal } : undefined;
    const response = await fetchBrowserResource(url, init, { fetchImpl: fetchMedia });
    await validate();
    if (!response.ok) throw new Error(`Failed to fetch cached clip: ${response.statusText}`);
    const blob = await response.blob();
    await validate();
    const filename = url.split('?')[0].split('/').pop() || 'segment.mp4';
    return Object.freeze({
        sourceFile: new File([blob], filename, { type: blob.type || 'video/mp4' }),
        usesOriginalMedia: false,
    });
};
