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
 * arranging, because the frame index is a pure function of the playhead, so the frame that comes
 * back is the frame at the instant the user stopped on.
 *
 * `playing` is therefore a LAYER choice and not an on/off switch. It used to be one — the surface
 * simply stopped asking for frames during playback and the CSS overlay took the screen back — and
 * that meant playback was drawn by an implementation that agrees with the export in none of the ways
 * this migration is about. Now the surface keeps asking, for the cheaper of the two layers:
 *
 *   - `playing: false` → `composited`, the exported pixel, the frame a decision is made against;
 *   - `playing: true`  → `subtitles`, the pass alone on a transparent ground, laid over the `<video>`
 *     by the browser.
 *
 * WHAT THE PLAYING PATH DOES NOT GUARANTEE: the browser performs that last blend, over a frame its
 * own video decoder colour-managed on its own terms, so chroma subsampling, the browser's colour
 * management and its straight-alpha compositing all land between our pixels and the screen. It is
 * close, not exact. It is never the resting state — pausing asks for the composited frame at the
 * same instant — and the previous frame is held until that one decodes, so the handover is a
 * replacement rather than a blank.
 */

import { NATIVE_PREVIEW_LAYERS } from '../../../platform/nativePreviewFrames';
import useNativePreviewFrame from './useNativePreviewFrame';
import useNativePreviewRequest from './useNativePreviewRequest';
import { useNativePreviewBinding, useVideoSourceDimensions } from './useNativePreviewSource';

const [COMPOSITED_LAYER, SUBTITLES_LAYER] = NATIVE_PREVIEW_LAYERS;

const useNativePreview = ({
  active,
  playing = false,
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

  const layer = playing ? SUBTITLES_LAYER : COMPOSITED_LAYER;
  const { status, frame, error, onFrameLoadError, releaseSurface } = useNativePreviewFrame({
    active,
    projectId,
    mediaId,
    scene,
    atlas,
    frameIndex,
    layer,
  });

  return {
    frame,
    status,
    // A transport refusal is the more specific of the two, so it wins; a bake or staging refusal is
    // reported only when the transport had nothing to say.
    error: error ?? requestError,
    onFrameLoadError,
    releaseSurface,
    /** The layer being asked for now, which is not yet the layer `frame` carries while it changes. */
    layer,
    /**
     * True only when the frame on screen is the guaranteed one: a real composited frame, on a
     * surface that is judging output. The subtitle layer is deliberately not owned — it is an
     * approximation the browser finishes, so nothing may treat it as the exported pixel.
     */
    owned: active && frame !== null && frame.layer === COMPOSITED_LAYER,
  };
};

export default useNativePreview;
