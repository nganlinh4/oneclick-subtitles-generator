/**
 * Freezing a decoded `<video>` frame for the canvas preview, and the per-source frame bookkeeping
 * that a seek or source load invalidates.
 */

/**
 * Forget every presented/desired frame and published scene for `sourceKey`. `includeCommitted`
 * also drops the last committed pixels, which only a changed source identity may do.
 */
export const clearPresentedFrame = ({
  presentedFrameRef,
  presentedSceneRef,
  desiredPixelFrameRef,
  committedPixelFrameRef,
  publishedSceneRef,
}, sourceKey, { includeCommitted = false } = {}) => {
  presentedFrameRef.current = {
    sourceKey, mediaTime: null, transportTime: null, provenance: null,
  };
  presentedSceneRef.current = { sourceKey, time: null };
  desiredPixelFrameRef.current = {
    sourceKey, source: null, mediaTime: null, transportTime: null, provenance: null,
  };
  if (includeCommitted) {
    committedPixelFrameRef.current = {
      sourceKey, source: null, mediaTime: null, transportTime: null, provenance: null,
    };
  }
  publishedSceneRef.current = { sourceKey, time: null };
};

/**
 * Returns `captureCandidate(video, metadata, generation)`: a frozen frame candidate for `sourceKey`,
 * or null when the decoder surface cannot be read yet.
 */
export const createFrameCapture = ({
  latestRef,
  rendererRef,
  committedPixelFrameRef,
  sourceKey,
}) => {
  return (video, metadata, generation) => {
    if (!latestRef.current?.videoUnderlay) {
      return Object.freeze({
        generation,
        video,
        sourceKey,
        source: null,
        mediaTime: Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime : null,
        transportTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
        provenance: Number.isFinite(metadata?.mediaTime) ? 'rvfc' : 'settled-transport',
      });
    }
    const retained = Object.is(committedPixelFrameRef.current.sourceKey, sourceKey)
      ? committedPixelFrameRef.current.source
      : null;
    let frozenSource = null;
    try {
      frozenSource = rendererRef.current?.captureVideoFrame?.(video, retained) ?? null;
    } catch {
      // Chromium can expose HAVE_CURRENT_DATA while drawImage still rejects the transitioning
      // decoder surface. The caller retries on a bounded animation-frame clock; an exception must
      // never escape rVFC and permanently disarm observation.
      return null;
    }
    if (frozenSource === null) return null;
    return Object.freeze({
      generation,
      video,
      sourceKey,
      source: frozenSource,
      // `currentTime` is the transport target. Only rVFC metadata is an authoritative decoded
      // presentation timestamp; keep it nullable instead of merging two clocks under one name.
      mediaTime: Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime : null,
      transportTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      provenance: Number.isFinite(metadata?.mediaTime) ? 'rvfc' : 'settled-transport',
    });
  };
};
