/**
 * Bounded, content-addressed cache of baked glyph atlases for the canvas preview. Bakes run in a
 * microtask, failures are cached as sticky refusals, and evicted atlas canvases release their memory.
 */
import { atlasBakeCacheKey, atlasBakeRequest, bakePreviewAtlas } from '../native/nativePreviewScene';
import { canvasPreviewFailure } from './canvasPreviewModel';
import { createAtlasCanvas } from './canvasSubtitleRenderer';

const MAX_CACHE_ENTRIES = 8;

/** Zero an atlas canvas so the browser can reclaim its backing store immediately. */
export const releaseAtlasCanvas = (entry) => {
  if (entry?.canvas) {
    entry.canvas.width = 0;
    entry.canvas.height = 0;
  }
};

export const atlasKey = (snapshot, activeCue) => atlasBakeCacheKey({
  customization: snapshot.customization,
  text: activeCue.cue.text,
  compositionWidthPx: snapshot.composition.width,
  compositionHeightPx: snapshot.composition.height,
  face: snapshot.face,
});

const cachePut = (cache, key, entry) => {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    const removed = cache.get(oldest);
    cache.delete(oldest);
    releaseAtlasCanvas(removed);
  }
};

/** Returns `bake(activeCue, snapshot, requiredForVisibleFrame)`, which yields the atlas cache key. */
export const createAtlasBaker = ({
  cacheRef,
  pendingRef,
  lifecycleGenerationRef,
  drawRef,
}) => (activeCue, snapshot, requiredForVisibleFrame = true) => {
  const key = atlasKey(snapshot, activeCue);
  if (cacheRef.current.has(key)) return key;
  const pending = pendingRef.current.get(key);
  if (pending !== undefined) {
    // A speculative next-cue bake can become visible while it is still running (for example a
    // paused seek across the cue boundary). Promote that work so completion wakes the canvas.
    if (requiredForVisibleFrame) pending.redraw = true;
    return key;
  }
  const generation = lifecycleGenerationRef.current;
  const pendingBake = { redraw: requiredForVisibleFrame };
  pendingRef.current.set(key, pendingBake);
  queueMicrotask(() => {
    try {
      const bakeRequest = atlasBakeRequest({
        customization: snapshot.customization,
        text: activeCue.cue.text,
        compositionWidthPx: snapshot.composition.width,
        compositionHeightPx: snapshot.composition.height,
        face: snapshot.face,
      });
      if (bakeRequest === null || bakeRequest.request === null) {
        throw Object.assign(new Error('glyphAtlasBakeRejected'), {
          code: bakeRequest?.refusal ?? 'glyphAtlasBakeRejected',
        });
      }
      const atlas = bakePreviewAtlas(bakeRequest);
      if (generation !== lifecycleGenerationRef.current) return;
      cachePut(cacheRef.current, key, { atlas, canvas: createAtlasCanvas(atlas) });
    } catch (error) {
      if (generation !== lifecycleGenerationRef.current) return;
      const failure = canvasPreviewFailure(error);
      // A deterministic bake failure must be sticky for this scene. Retrying from `finally`
      // creates an unbounded microtask loop: bake -> fail -> draw -> bake, starving the whole
      // WebView so even diagnostics and controls stop responding. A changed scene gets a new
      // key and may bake; this exact request remains refused until then.
      cachePut(cacheRef.current, key, { error: failure.code, retryable: failure.retryable });
      // Do not publish from speculative work. `bake` also warms the next cue, and an error in
      // that prefetch must not replace the ready state of the cue the user is currently seeing.
      // The draw below resolves the active cue again and publishes this keyed refusal only if
      // that exact atlas is actually required by the current frame.
    } finally {
      pendingRef.current.delete(key);
      // Warming an inactive cue must not republish the current full frame. Besides wasting a
      // video-sized copy, that duplicate revision looked like a visual change to automation.
      if (pendingBake.redraw && generation === lifecycleGenerationRef.current) drawRef.current();
    }
  });
  return key;
};
