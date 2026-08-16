/**
 * The one entry point a preview surface uses to put a natively composited frame on screen.
 *
 * It composes the four pieces that have to agree — the project/media binding, the decoded source
 * size, the scene and staged atlas, and the transport — so that a surface asks one question ("what
 * should I be showing at this instant?") and gets one answer. Both preview surfaces call this, which
 * is what makes "one compositor, one glyph source" true of the editor and not only of the export.
 *
 * WHEN THE FRAME OWNS THE SURFACE is the whole of the accepted design's preview rule
 * (`docs/rewrite/NATIVE_RENDERER.md`): paused, scrubbing, and every style adjustment show the fully
 * composited native frame, because those are the surfaces where a user decides whether the output
 * looks right and where there is time to render one frame properly. Continuous playback does not,
 * and pausing must re-render the exact frame — which falls out of this design rather than needing
 * arranging, because `active` returns to true and the frame index is a pure function of the
 * playhead, so the frame that comes back is the frame at the instant the user stopped on.
 */

import useNativePreviewFrame from './useNativePreviewFrame';
import useNativePreviewRequest from './useNativePreviewRequest';
import { useNativePreviewBinding, useVideoSourceDimensions } from './useNativePreviewSource';

const useNativePreview = ({
  active,
  source,
  videoRef,
  sourceKey = null,
  customization,
  subtitles,
  resolution,
  frameRate,
  cropWidthPercent = 100,
  cropHeightPercent = 100,
  durationSeconds = null,
  currentTime = 0,
}) => {
  const { projectId, mediaId } = useNativePreviewBinding(source);
  const dimensions = useVideoSourceDimensions(videoRef, sourceKey);

  const { scene, atlas, frameIndex, error: requestError } = useNativePreviewRequest({
    active,
    customization,
    subtitles,
    resolution,
    frameRate,
    cropWidthPercent,
    cropHeightPercent,
    sourceWidthPx: dimensions === null ? null : dimensions.widthPx,
    sourceHeightPx: dimensions === null ? null : dimensions.heightPx,
    durationSeconds,
    currentTime,
  });

  const { status, frame, error, onFrameLoadError, releaseSurface } = useNativePreviewFrame({
    active,
    projectId,
    mediaId,
    scene,
    atlas,
    frameIndex,
  });

  return {
    frame,
    status,
    // A transport refusal is the more specific of the two, so it wins; a bake or staging refusal is
    // reported only when the transport had nothing to say.
    error: error ?? requestError,
    onFrameLoadError,
    releaseSurface,
    /** True only when a real composited frame exists and this surface is the one judging output. */
    owned: active && frame !== null,
  };
};

export default useNativePreview;
