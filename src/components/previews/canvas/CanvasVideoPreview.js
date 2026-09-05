import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { useFontReadiness } from '../../../services/useFontReadiness';
import { parseFontFamilyValue } from '../../../services/fontIdentity';
import { systemFontProbe } from '../../../platform/systemFontProbe';
import {
  PREVIEW_FULL_FRAME_CROP,
  atlasBakeCacheKey,
  atlasBakeRequest,
  bakePreviewAtlas,
  previewCueList,
  previewFace,
} from '../native/nativePreviewScene';
import { compositionSize, exactFrameRate } from '../native/nativePreviewGeometry';
import { useVideoSourceDimensions } from '../native/useNativePreviewSource';
import { activeCueAtFrom, cueTransformAt, easeSubtitle } from './canvasSubtitleMath';
import { createAtlasCanvas, createCanvasSubtitleRenderer } from './canvasSubtitleRenderer';

const MAX_CACHE_ENTRIES = 8;
const MAX_DEVICE_PIXEL_RATIO = 1.5;
const MAX_CANVAS_WIDTH = 1_600;
const MAX_CANVAS_HEIGHT = 1_000;
const MAX_CAPTURE_RETRY_FRAMES = 3;
const RETRYABLE_PREVIEW_FAILURES = new Set([
  'canvasPreviewUnavailable',
  // A face accepted by the product-level identity resolver can still be between stylesheet
  // installation and FontFaceSet activation. The exact same request becomes valid when the
  // browser finishes loading the face, so caching this as deterministic freezes restored projects.
  'glyphAtlasFaceLoading',
  'glyphAtlasSurfaceUnavailable',
]);

/** Adapt the native geometry contract once; canvas maths deliberately uses terse width/height. */
export const canvasCompositionSize = (input) => {
  const size = compositionSize(input);
  return size === null ? null : Object.freeze({ width: size.widthPx, height: size.heightPx });
};

const platformName = () => {
  const agent = navigator.userAgent.toLowerCase();
  if (agent.includes('windows')) return 'windows';
  if (agent.includes('mac os') || agent.includes('macintosh')) return 'macos';
  if (agent.includes('linux') || agent.includes('x11')) return 'linux';
  return null;
};

const stateKey = (state) => `${state.status}|${state.code ?? ''}|${state.retryable === true}`;

/** Distinguish a temporary canvas allocation failure from a request that will deterministically
 * fail for the same atlas key. Unknown failures stay non-retryable instead of becoming a loop. */
export const canvasPreviewFailure = (error) => {
  const candidate = typeof error?.code === 'string'
    ? error.code
    : error?.message === 'canvasPreviewUnavailable'
      ? error.message
      : 'canvasPreviewRejected';
  const code = /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(candidate)
    ? candidate
    : 'canvasPreviewRejected';
  return Object.freeze({ code, retryable: RETRYABLE_PREVIEW_FAILURES.has(code) });
};
const atlasKey = (snapshot, activeCue) => atlasBakeCacheKey({
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
    if (removed?.canvas) {
      removed.canvas.width = 0;
      removed.canvas.height = 0;
    }
  }
};

/**
 * The source decoder and the exported composition do not necessarily share a frame grid. A 15 fps
 * source legitimately holds its 1.2 s frame while a 30 fps export evaluates the subtitle scene at
 * 1.266666… s. Keep the scene on the authored output grid instead of delaying cue/easing time to
 * the source frame's presentation timestamp.
 */
export const previewSceneTime = (transportTime, frameRate, trimStart = 0) => {
  const time = Number(transportTime);
  const origin = Number(trimStart);
  const rate = exactFrameRate(frameRate);
  if (!Number.isFinite(time) || !Number.isFinite(origin) || rate === null) return 0;
  const position = (time - origin) * rate.fpsNumerator / rate.fpsDenominator;
  const arithmeticEpsilon = Number.EPSILON * Math.max(1, Math.abs(position)) * 8;
  const frame = Math.floor(position + arithmeticEpsilon);
  return origin + frame * rate.fpsDenominator / rate.fpsNumerator;
};

/**
 * Persistent, display-resolution preview compositor.
 *
 * The video frame is copied directly from the live `<video>` element and the subtitle is painted
 * from the same shaped line atlas staged for native export. No frame bytes cross IPC, no PNG is
 * encoded or decoded, and React is not involved in the playback loop.
 */
const CanvasVideoPreview = ({
  active = true,
  videoRef,
  sourceKey = null,
  playing = false,
  seeking = false,
  currentTime = 0,
  frameRate = 30,
  customization,
  subtitles,
  resolution,
  crop = PREVIEW_FULL_FRAME_CROP,
  trimStart = 0,
  trimEnd = 0,
  onStateChange = null,
  retryToken = 0,
  className = '',
  style = null,
}) => {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const cacheRef = useRef(new Map());
  const pendingRef = useRef(new Map());
  const lifecycleGenerationRef = useRef(0);
  const latestRef = useRef(null);
  const drawRef = useRef(() => undefined);
  const publishedRef = useRef('');
  const rendererFailureRef = useRef(null);
  const retryTokenRef = useRef(retryToken);
  const revisionRef = useRef(0);
  const overlayRebuildsRef = useRef(0);
  // `HTMLMediaElement.currentTime` is a transport target, not proof that the corresponding pixels
  // have reached the compositor. Keep the clock delivered with the last presented video frame so
  // subtitle selection, video pixels and the public revision always describe one atomic image.
  const presentedFrameRef = useRef({
    sourceKey: null, mediaTime: null, transportTime: null, provenance: null,
  });
  const presentedSceneRef = useRef({ sourceKey: null, time: null });
  const desiredPixelFrameRef = useRef({
    sourceKey: null, source: null, mediaTime: null, transportTime: null, provenance: null,
  });
  const committedPixelFrameRef = useRef({
    sourceKey: null, source: null, mediaTime: null, transportTime: null, provenance: null,
  });
  const publishedSceneRef = useRef({ sourceKey: null, time: null });
  const cueCursorRef = useRef({ index: 0, time: Number.NEGATIVE_INFINITY, sceneKey: '' });
  const dimensions = useVideoSourceDimensions(videoRef, sourceKey);
  const fontCapability = useFontReadiness();

  const cropKey = useMemo(() => JSON.stringify(crop), [crop]);
  const customizationKey = useMemo(() => JSON.stringify(customization), [customization]);
  const fontFamily = customization?.fontFamily ?? null;
  const fontWeight = customization?.fontWeight ?? null;
  const cues = useMemo(() => previewCueList(subtitles), [subtitles]);
  const cuesKey = useMemo(() => JSON.stringify(cues), [cues]);
  const face = useMemo(() => {
    const platform = platformName();
    if (platform === null || fontFamily === null || fontWeight === null) return null;
    return previewFace({
      fontFamily,
      fontWeight,
      platform,
      capability: fontCapability,
      isSystemFaceInstalled: systemFontProbe(),
    });
  }, [fontCapability, fontFamily, fontWeight]);
  const managedFontRequested = useMemo(() => {
    const parsed = parseFontFamilyValue(fontFamily);
    return parsed.ok && parsed.primary === fontCapability.expectedManagedFamily;
  }, [fontCapability.expectedManagedFamily, fontFamily]);
  const composition = useMemo(() => {
    if (dimensions === null) return null;
    return canvasCompositionSize({
      resolution,
      sourceWidthPx: dimensions.widthPx,
      sourceHeightPx: dimensions.heightPx,
      crop,
    });
    // cropKey is the content dependency; crop objects are often rebuilt on render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimensions?.widthPx, dimensions?.heightPx, resolution, cropKey]);

  const sceneKey = `${customizationKey}|${cuesKey}|${composition?.width ?? 0}x${composition?.height ?? 0}|${face?.key ?? face?.source ?? ''}`;
  // Paint invalidation is deliberately broader than atlas identity. Crop position/flip/backfill and
  // trim boundaries do not reshape text, but a paused canvas still has to repaint immediately.
  const paintKey = `${sceneKey}|${String(sourceKey ?? '')}|${cropKey}|${trimStart}|${trimEnd}|${active}`;

  const publish = useCallback((state) => {
    const key = stateKey(state);
    if (publishedRef.current === key) return;
    publishedRef.current = key;
    onStateChange?.(state);
  }, [onStateChange]);

  latestRef.current = {
    active,
    playing,
    seeking,
    currentTime,
    frameRate,
    customization,
    cues,
    face,
    fontCapability,
    managedFontRequested,
    composition,
    crop,
    trimStart,
    trimEnd,
    sceneKey,
    sourceKey,
  };

  useLayoutEffect(() => {
    // The complete scene invalidates selection and paint, not shaped glyphs. Atlas entries are
    // content-addressed by their own smaller dependency set and remain reusable across timing,
    // position, animation and colour edits.
    cueCursorRef.current = { index: 0, time: Number.NEGATIVE_INFINITY, sceneKey };
    drawRef.current();
  }, [paintKey, sceneKey]);

  useEffect(() => {
    if (Object.is(retryTokenRef.current, retryToken)) return;
    retryTokenRef.current = retryToken;
    lifecycleGenerationRef.current += 1;
    pendingRef.current.clear();
    rendererFailureRef.current = null;
    for (const [key, entry] of cacheRef.current) {
      if (entry.retryable === true) cacheRef.current.delete(key);
    }
    publishedRef.current = '';
    drawRef.current();
  }, [retryToken]);

  useEffect(() => {
    const fonts = document.fonts;
    if (typeof fonts?.addEventListener !== 'function') return undefined;
    const retryActivatedFaces = () => {
      let removed = false;
      for (const [key, entry] of cacheRef.current) {
        if (entry.error === 'glyphAtlasFaceLoading' && entry.retryable === true) {
          cacheRef.current.delete(key);
          removed = true;
        }
      }
      if (!removed) return;
      lifecycleGenerationRef.current += 1;
      pendingRef.current.clear();
      publishedRef.current = '';
      drawRef.current();
    };
    fonts.addEventListener('loadingdone', retryActivatedFaces);
    return () => fonts.removeEventListener('loadingdone', retryActivatedFaces);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    // jsdom deliberately has no raster canvas. Parent component tests inspect wiring and DOM; the
    // real drawing contract is exercised by the browser journey and renderer unit tests.
    if (navigator.userAgent.toLowerCase().includes('jsdom')) {
      publish({ status: 'idle', code: null });
      return undefined;
    }
    try {
      rendererRef.current = createCanvasSubtitleRenderer(canvas);
      rendererFailureRef.current = null;
    } catch (error) {
      const failure = canvasPreviewFailure(error);
      rendererRef.current = null;
      rendererFailureRef.current = failure;
      publish({ status: 'error', ...failure });
      return undefined;
    }
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
      const width = Math.max(1, Math.min(MAX_CANVAS_WIDTH, Math.round(bounds.width * ratio)));
      const height = Math.max(1, Math.min(MAX_CANVAS_HEIGHT, Math.round(bounds.height * ratio)));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      drawRef.current();
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(canvas);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      rendererRef.current = null;
    };
  }, [publish, retryToken]);

  useEffect(() => {
    let videoFrameHandle = null;
    let videoWithFrameCallback = null;
    let videoFrameGeneration = 0;
    let captureRetryHandle = null;
    let captureRetryAttempts = 0;
    let stopped = false;
    let drawing = false;
    // Black-surface rejection bookkeeping, reset with every seek generation: the check runs only
    // until a generation publishes its first frame, so steady playback never pays a readback.
    let publishedFrameThisGeneration = false;
    let blackSkipsThisGeneration = 0;

    // A changed source identity invalidates every previously presented timestamp before any layout
    // effect is allowed to repaint. Native `loadstart`/`emptied` below also cover in-place fallback
    // loads which keep the React source key unchanged.
    presentedFrameRef.current = {
      sourceKey, mediaTime: null, transportTime: null, provenance: null,
    };
    presentedSceneRef.current = { sourceKey, time: null };
    desiredPixelFrameRef.current = {
      sourceKey, source: null, mediaTime: null, transportTime: null, provenance: null,
    };
    committedPixelFrameRef.current = {
      sourceKey, source: null, mediaTime: null, transportTime: null, provenance: null,
    };
    publishedSceneRef.current = { sourceKey, time: null };

    const captureCandidate = (video, metadata, generation) => {
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

    const publishCandidate = (candidate) => {
      if (candidate === null
          || stopped
          || candidate.generation !== videoFrameGeneration
          || candidate.video.seeking
          || videoRef.current !== candidate.video
          || !Object.is(latestRef.current?.sourceKey, candidate.sourceKey)) return false;
      const snapshot = latestRef.current;
      const transportTime = candidate.transportTime ?? snapshot?.currentTime;
      const sceneTime = previewSceneTime(
        transportTime,
        snapshot?.frameRate,
        snapshot?.trimStart,
      );
      const published = publishedSceneRef.current;
      const priorFrame = presentedFrameRef.current;
      // `seeked` is the canonical paused publication. A late rVFC for that same settled target can
      // add an authoritative PTS, but it cannot change the already-visible pixels and therefore
      // must not manufacture a second visual revision or replace nullable telemetry based on race
      // order. A new target/source still publishes normally.
      if (!snapshot?.playing
          && Object.is(published.sourceKey, candidate.sourceKey)
          && Object.is(published.time, sceneTime)
          && Object.is(priorFrame.sourceKey, candidate.sourceKey)
          && Object.is(priorFrame.transportTime, transportTime)) return true;
      // The first capture(s) after a seek can legally be the transitioning decoder surface —
      // solid black — whichever boundary delivered them; the witness caught that flash both from
      // the settled snapshot and from the first post-seek presentation callback. One bounded
      // readback per seek generation rejects the surface and lets the next frame publish; after
      // two rejections the picture is accepted as real black content, and after a generation's
      // first accepted frame the check never runs again.
      if (!publishedFrameThisGeneration
          && blackSkipsThisGeneration < 2
          && rendererRef.current?.captureLooksBlack?.(candidate.source) === true) {
        blackSkipsThisGeneration += 1;
        if (!snapshot?.playing && !candidate.video.seeking && candidate.video.readyState >= 2) {
          scheduleCaptureRetry(candidate.video, candidate.generation);
        }
        return false;
      }
      publishedFrameThisGeneration = true;
      desiredPixelFrameRef.current = {
        sourceKey: candidate.sourceKey,
        source: candidate.source,
        mediaTime: candidate.mediaTime,
        transportTime,
        provenance: candidate.provenance,
      };
      captureRetryAttempts = 0;
      if (captureRetryHandle !== null) {
        cancelAnimationFrame(captureRetryHandle);
        captureRetryHandle = null;
      }
      if (!snapshot?.playing
          || !Object.is(published.sourceKey, candidate.sourceKey)
          || !Object.is(published.time, sceneTime)) {
        draw({
          mediaTime: candidate.mediaTime,
          transportTime,
          provenance: candidate.provenance,
        }, sceneTime, candidate.source);
      }
      return true;
    };

    const schedule = () => {
      // React updates latestRef during render, before passive cleanup of this source-bound effect.
      // Reject that commit->cleanup window explicitly so an already-dispatched callback from source
      // A cannot relabel its metadata/pixels with source B's scene.
      if (stopped
          || videoFrameHandle !== null
          || sourceKey === null
          || !Object.is(latestRef.current?.sourceKey, sourceKey)) return;
      const video = videoRef.current;
      if (typeof video?.requestVideoFrameCallback === 'function') {
        videoWithFrameCallback = video;
        const callbackGeneration = videoFrameGeneration;
        // Keep exactly one callback armed while paused too. A paused seek presents a new frame but
        // never enters the playback loop; gating this callback on `playing` made the React time
        // effect below publish the old frame under the new timestamp.
        let assignedHandle = null;
        assignedHandle = video.requestVideoFrameCallback((_now, metadata) => {
          // A browser is allowed to deliver a callback whose cancellation raced with dispatch. It
          // must not clear the handle armed for a newer seek generation.
          if (videoFrameHandle === assignedHandle) videoFrameHandle = null;
          try {
            if (callbackGeneration === videoFrameGeneration
                && videoRef.current === video
                && Object.is(latestRef.current?.sourceKey, sourceKey)) {
              const candidate = captureCandidate(video, metadata, callbackGeneration);
              // A callback delivered while `seeking` can still describe the frame the decoder is
              // leaving. Keep the visible composition frozen, but do not retain those pixels for
              // the eventual `seeked` publication. The settled media element is snapshotted below.
              if (candidate !== null && !video.seeking) publishCandidate(candidate);
              else if (candidate === null && rendererRef.current !== null) {
                scheduleCaptureRetry(video, callbackGeneration);
              }
            }
          } catch (error) {
            // `captureCandidate` already guards its own decoder read; this instead catches a throw
            // from `publishCandidate` (or the `draw()` it can trigger) that a canvas/atlas failure
            // can still raise. The `finally` below must still re-arm the chain, or one bad frame
            // permanently disarms the self-perpetuating rVFC loop: the picture freezes here while
            // the transport clock and seek bar keep advancing underneath it — exactly the watched
            // 'frozen video, advancing audio/seek bar' defect. The generation check above already
            // ran before this throw could happen, so the failure genuinely belongs to the frame
            // just attempted, not a superseded one. While playing, the very next decoded frame
            // retries on its own; while paused nothing else will, so this is reported as retryable
            // to keep the toast's manual Retry action meaningful.
            if (!stopped) {
              publish({ status: 'error', code: canvasPreviewFailure(error).code, retryable: true });
            }
          } finally {
            schedule();
          }
        });
        videoFrameHandle = assignedHandle;
      }
    };

    const scheduleCaptureRetry = (video, generation) => {
      if (stopped || captureRetryHandle !== null || generation !== videoFrameGeneration) return;
      captureRetryHandle = requestAnimationFrame(() => {
        captureRetryHandle = null;
        if (stopped
            || generation !== videoFrameGeneration
            || videoRef.current !== video
            || video.seeking
            || video.readyState < 2
            || !Object.is(latestRef.current?.sourceKey, sourceKey)) return;
        const candidate = captureCandidate(video, null, generation);
        if (candidate !== null) {
          publishCandidate(candidate);
          // The paused-publication dedupe can accept the candidate without repainting when the
          // refs already name this exact frame. A retry exists precisely because the screen is
          // owed a frame: when the publication still says so, resolve the current scene against
          // the refreshed pixels — and only then, so an ordinary retry never manufactures a
          // duplicate visual revision of the same content.
          if (publishedRef.current === '' || publishedRef.current.startsWith('pending')) {
            drawRef.current();
          }
          return;
        }
        captureRetryAttempts += 1;
        if (captureRetryAttempts < MAX_CAPTURE_RETRY_FRAMES) {
          scheduleCaptureRetry(video, generation);
          return;
        }
        captureRetryAttempts = 0;
        publish({ status: 'error', code: 'canvasPreviewUnavailable', retryable: true });
      });
    };

    const supersedePendingFrame = () => {
      videoFrameGeneration += 1;
      publishedFrameThisGeneration = false;
      blackSkipsThisGeneration = 0;
      captureRetryAttempts = 0;
      if (captureRetryHandle !== null) {
        cancelAnimationFrame(captureRetryHandle);
        captureRetryHandle = null;
      }
      if (videoFrameHandle !== null
          && typeof videoWithFrameCallback?.cancelVideoFrameCallback === 'function') {
        videoWithFrameCallback.cancelVideoFrameCallback(videoFrameHandle);
      }
      videoFrameHandle = null;
      schedule();
    };

    const bake = (activeCue, snapshot, requiredForVisibleFrame = true) => {
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

    const selectCue = (snapshot, time) => {
      const fadeIn = snapshot.customization.fadeInDuration;
      const fadeOut = snapshot.customization.fadeOutDuration;
      const cursor = cueCursorRef.current;
      // Ordinary playback is monotonic. Walk only the cues crossed since the prior video frame,
      // which makes a 100,000-cue project O(1) per frame instead of rescanning the document.
      if (cursor.sceneKey === snapshot.sceneKey && time >= cursor.time) {
        let index = Math.min(cursor.index, Math.max(0, snapshot.cues.length - 1));
        while (index < snapshot.cues.length && time > snapshot.cues[index].end + fadeOut) {
          index += 1;
        }
        cursor.index = index;
        cursor.time = time;
        return activeCueAtFrom(snapshot.cues, time, fadeIn, fadeOut, index);
      }
      // A backwards seek is rare and correctness matters more than indexing it: scan once from the
      // start so authored intervals and overlapping fades follow the export's exact selection rule.
      const selected = activeCueAtFrom(snapshot.cues, time, fadeIn, fadeOut, 0);
      cursor.sceneKey = snapshot.sceneKey;
      cursor.time = time;
      cursor.index = selected?.index ?? 0;
      return selected;
    };

    const draw = (presentedClock = null, presentedSceneTime = null, presentedPixels = null) => {
      if (stopped || drawing) return;
      drawing = true;
      try {
        const snapshot = latestRef.current;
        const renderer = rendererRef.current;
        const video = videoRef.current;
        if (snapshot === null || video === null) {
          publish({ status: 'idle', code: null });
          return;
        }
        // Seeking invalidates the video's decoded presentation frame before the replacement is
        // available. Preserve the last atomically published composition instead of exposing an
        // intermediate old/empty/black frame. `video.seeking` closes the small interval before
        // React has committed the explicit lifecycle prop.
        const callbackTransportTime = Number.isFinite(presentedClock?.transportTime)
          ? presentedClock.transportTime
          : null;
        const callbackMediaTime = Number.isFinite(presentedClock?.mediaTime)
          ? presentedClock.mediaTime
          : null;
        const callbackProvenance = typeof presentedClock?.provenance === 'string'
          ? presentedClock.provenance
          : null;
        const callbackSceneTime = Number.isFinite(presentedSceneTime) ? presentedSceneTime : null;
        // React can commit the `seeked` state one turn after the media element. A real presented
        // frame with `video.seeking === false` is authoritative and must not be discarded merely
        // because the prop is one render behind; a synchronous repaint still remains blocked.
        if (video.seeking || (snapshot.seeking && callbackTransportTime === null)) return;
        if (callbackTransportTime !== null) {
          presentedFrameRef.current = {
            sourceKey: snapshot.sourceKey,
            mediaTime: callbackMediaTime,
            transportTime: callbackTransportTime,
            provenance: callbackProvenance,
          };
          presentedSceneRef.current = {
            sourceKey: snapshot.sourceKey,
            time: callbackSceneTime ?? previewSceneTime(
              snapshot.playing ? video.currentTime : snapshot.currentTime,
              snapshot.frameRate,
              snapshot.trimStart,
            ),
          };
          if (presentedPixels !== null) {
            desiredPixelFrameRef.current = {
              sourceKey: snapshot.sourceKey,
              source: presentedPixels,
              mediaTime: callbackMediaTime,
              transportTime: callbackTransportTime,
              provenance: callbackProvenance,
            };
          }
        }
        // A source frame can arrive while project activation/font/scene preparation still keeps the
        // compositor inactive. Retain its authoritative clock so enabling the scene while paused
        // can paint immediately instead of waiting for playback or another seek.
        if (!snapshot.active || snapshot.composition === null) {
          publish({ status: 'idle', code: null });
          return;
        }
        if (renderer === null) {
          const failure = rendererFailureRef.current;
          publish(failure === null
            ? { status: 'idle', code: null }
            : { status: 'error', ...failure });
          return;
        }
        const priorFrame = Object.is(presentedFrameRef.current.sourceKey, snapshot.sourceKey)
          ? presentedFrameRef.current
          : null;
        const priorSceneTime = Object.is(presentedSceneRef.current.sourceKey, snapshot.sourceKey)
          ? presentedSceneRef.current.time
          : null;
        const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
        // Without callback metadata, a repaint (style/crop/atlas completion) must retain the clock
        // of the pixels already visible. Falling back to the live transport clock is safe only for
        // browsers without requestVideoFrameCallback, where `seeked` is the publication boundary.
        if (callbackTransportTime === null
            && !Number.isFinite(priorFrame?.transportTime)
            && hasFrameCallback) {
          // No pixels have ever been captured for this source. While paused and settled there may
          // be no future presentation to deliver them, so returning bare would freeze the
          // published state (a customer opening Render on a paused project saw a permanent idle
          // preview). The bounded retry snapshots the settled element or ends in a typed refusal.
          if (!video.seeking && !snapshot.playing && video.readyState >= 2) {
            scheduleCaptureRetry(video, videoFrameGeneration);
          }
          return;
        }
        const fallbackTransportTime = Number.isFinite(video.currentTime)
          ? video.currentTime
          : snapshot.currentTime;
        const sourceMediaTime = callbackTransportTime !== null
          ? callbackMediaTime
          : priorFrame?.mediaTime ?? null;
        const sourceClockProvenance = callbackTransportTime !== null
          ? callbackProvenance
          : priorFrame?.provenance ?? null;
        const sceneTime = callbackSceneTime
          ?? priorSceneTime
          ?? previewSceneTime(fallbackTransportTime, snapshot.frameRate, snapshot.trimStart);
        const transportTime = callbackTransportTime
          ?? priorFrame?.transportTime
          ?? (snapshot.playing || !Number.isFinite(snapshot.currentTime)
            ? fallbackTransportTime
            : snapshot.currentTime);
        const outsideTrim = transportTime < snapshot.trimStart
          || (snapshot.trimEnd > snapshot.trimStart && transportTime > snapshot.trimEnd);
        const selected = outsideTrim || snapshot.customization === null
          ? null
          : selectCue(snapshot, sceneTime);
        const desiredPixels = Object.is(desiredPixelFrameRef.current.sourceKey, snapshot.sourceKey)
          ? desiredPixelFrameRef.current
          : null;
        const committedPixels = Object.is(committedPixelFrameRef.current.sourceKey, snapshot.sourceKey)
          ? committedPixelFrameRef.current
          : null;
        const pixelFrame = presentedPixels ?? desiredPixels?.source ?? committedPixels?.source ?? null;
        if (hasFrameCallback && pixelFrame === null) {
          // No pixels to compose and, while paused, no future video frame to deliver any. Returning
          // silently here left the published state frozen (a customer-visible stuck "pending" after
          // a paused seek raced a lifecycle reset). The bounded capture retry re-snapshots the
          // paused element and ends in a typed canvasPreviewUnavailable refusal rather than an
          // eternal wait, so a lost one-shot wakeup can no longer wedge the preview.
          if (!video.seeking && video.readyState >= 2) {
            scheduleCaptureRetry(video, videoFrameGeneration);
          }
          return;
        }
        let entry = null;
        let activeWithEasing = null;
        let cueTransform = { x: 0, y: 0, scale: 1, rotate: 0, rotateY: 0 };
        if (selected !== null && snapshot.face !== null) {
          const key = bake(selected, snapshot);
          const cached = cacheRef.current.get(key) ?? null;
          if (cached === null) {
            // Publish a video frame and its subtitle as one visual revision. Painting the bare
            // video while its atlas is queued creates a flash at every cue/style boundary. Holding
            // the last complete canvas for one microtask is both shorter and visually atomic.
            publish({ status: 'pending', code: null });
            // While paused there may never be another presented frame, and the bake completion's
            // redraw has been observed to lose a race with a lifecycle reset — leaving this
            // "pending" on screen forever. Pending is a promise of a frame: arm the bounded
            // capture retry so the promise is kept or becomes a typed refusal.
            if (!video.seeking && !snapshot.playing && video.readyState >= 2) {
              scheduleCaptureRetry(video, videoFrameGeneration);
            }
            return;
          }
          entry = cached?.atlas ? cached : null;
          const eased = easeSubtitle(selected.progress, snapshot.customization.animationEasing);
          activeWithEasing = { ...selected, eased };
          cueTransform = cueTransformAt(
            snapshot.customization.animationType,
            selected.phase,
            selected.progress,
            snapshot.customization.animationEasing,
          );
          const next = snapshot.cues[selected.index + 1];
          if (next !== undefined) {
            bake({ cue: next, index: selected.index + 1 }, snapshot, false);
          }
        }
        const result = renderer.draw({
          video: hasFrameCallback ? pixelFrame : video,
          composition: snapshot.composition,
          crop: snapshot.crop,
          atlasEntry: entry,
          customization: snapshot.customization,
          active: activeWithEasing,
          cueTransform,
        });
        const drewVideo = result?.drewVideo === true;
        const canvas = canvasRef.current;
        if (canvas !== null && drewVideo) {
          if (hasFrameCallback) {
            committedPixelFrameRef.current = {
              sourceKey: snapshot.sourceKey,
              source: pixelFrame,
              mediaTime: sourceMediaTime,
              transportTime,
              provenance: sourceClockProvenance,
            };
          }
          presentedSceneRef.current = { sourceKey: snapshot.sourceKey, time: sceneTime };
          publishedSceneRef.current = { sourceKey: snapshot.sourceKey, time: sceneTime };
          if (result.overlayRebuilt === true) overlayRebuildsRef.current += 1;
          revisionRef.current += 1;
          canvas.dataset.osgFrameRevision = String(revisionRef.current);
          canvas.dataset.osgSourceMediaTime = sourceMediaTime === null
            ? ''
            : String(sourceMediaTime);
          canvas.dataset.osgTransportTime = String(transportTime);
          canvas.dataset.osgSourceClockProvenance = sourceClockProvenance ?? 'unknown';
          canvas.dataset.osgSceneTime = String(sceneTime);
          canvas.dataset.osgCueIndex = selected === null ? '' : String(selected.index);
          canvas.dataset.osgViewportLeft = String(result.viewport.left);
          canvas.dataset.osgViewportTop = String(result.viewport.top);
          canvas.dataset.osgViewportWidth = String(result.viewport.width);
          canvas.dataset.osgViewportHeight = String(result.viewport.height);
          canvas.dataset.osgOverlayRebuilds = String(overlayRebuildsRef.current);
        }
        if (selected !== null && snapshot.face === null) {
          // The display canvas is opaque and sits above the live video. Returning before repainting
          // left its last pixels frozen while audio and the seek bar continued underneath it.
          // A managed package that is resolving/repairing/refused belongs to the typed readiness
          // state machine. It is a prerequisite, not a renderer error; its toast owns the retry.
          publish(snapshot.managedFontRequested && !snapshot.fontCapability.managedPackInstalled
            ? { status: 'font-blocked', code: null }
            : { status: 'error', code: 'fontUnavailable', retryable: false });
        }
        else if (selected !== null && snapshot.customization === null) {
          publish({ status: 'error', code: 'canvasPreviewRejected', retryable: false });
        }
        else if (!drewVideo) publish({ status: 'source-loading', code: null });
        else if (selected === null) publish({
          status: snapshot.cues.length === 0 ? 'empty' : outsideTrim ? 'outside-trim' : 'between-cues',
          code: null,
        });
        else if (cacheRef.current.get(atlasKey(snapshot, selected))?.error) {
          const failure = cacheRef.current.get(atlasKey(snapshot, selected));
          publish({
            status: 'error',
            code: failure.error,
            retryable: failure.retryable === true,
          });
        }
        else if (entry === null) {
          publish({ status: 'pending', code: null });
          // Same promise as the pre-draw pending above: never leave "pending" without a wakeup
          // that does not depend on the paused video presenting another frame.
          if (!video.seeking && !snapshot.playing && video.readyState >= 2) {
            scheduleCaptureRetry(video, videoFrameGeneration);
          }
        }
        else publish({ status: 'ready', code: null });
      } finally {
        drawing = false;
      }
    };

    drawRef.current = draw;
    const video = videoRef.current;
    const hasFrameCallback = typeof video?.requestVideoFrameCallback === 'function';
    if (!hasFrameCallback) draw(
      {
        mediaTime: null,
        transportTime: video?.currentTime,
        provenance: 'transport-only',
      },
      previewSceneTime(
        video?.currentTime,
        latestRef.current?.frameRate,
        latestRef.current?.trimStart,
      ),
    );
    const wakeForDecodedFrame = () => {
      // rVFC is the stronger boundary and is already armed. The media events can precede actual
      // presentation, so using them as a second publication path recreates the stale-frame race.
      // One exception: a PAUSED element that settles after this effect armed rVFC may already have
      // made its only presentation (arming raced it, or an occluded surface never composites
      // another), so waiting for a callback would freeze the preview at idle until the customer
      // seeks. The settled-snapshot publication `seeked` uses is deterministic for that case too;
      // playback and in-flight seeks still belong to the stronger callbacks.
      if (hasFrameCallback) {
        if (video !== null && video.paused && !video.seeking && video.readyState >= 2
            && latestRef.current?.playing !== true) completeSeek();
        else schedule();
      }
      else draw(
        {
          mediaTime: null,
          transportTime: video?.currentTime,
          provenance: 'transport-only',
        },
        previewSceneTime(
          video?.currentTime,
          latestRef.current?.frameRate,
          latestRef.current?.trimStart,
        ),
      );
    };
    const completeSeek = () => {
      if (!hasFrameCallback) {
        draw(
          {
            mediaTime: null,
            transportTime: video?.currentTime,
            provenance: 'transport-only',
          },
          previewSceneTime(
            video?.currentTime,
            latestRef.current?.frameRate,
            latestRef.current?.trimStart,
          ),
        );
        return;
      }
      // A during-seek rVFC is not a completion boundary: Edge may report the outgoing/intermediate
      // source frame there. `seeked` plus HAVE_CURRENT_DATA is the first deterministic boundary.
      // Snapshot the element *now*, invalidate every callback that raced it, then re-arm the
      // permanent source-frame observer. The snapshot has an exact transport target but no
      // authoritative decoded PTS, so captureCandidate deliberately records nullable mediaTime.
      if (video === null || video.seeking || video.readyState < 2) {
        schedule();
        return;
      }
      videoFrameGeneration += 1;
      publishedFrameThisGeneration = false;
      blackSkipsThisGeneration = 0;
      captureRetryAttempts = 0;
      // A retry armed for the invalidated generation must not survive this boundary: its callback
      // exits on the generation mismatch without rescheduling, yet its pending handle blocks the
      // new generation from arming its own retry. With `loadeddata` and `canplay` arriving in one
      // task burst over a paused source whose first frame is genuinely black, that stale handle
      // left the canvas permanently blank after an A-to-B source switch.
      if (captureRetryHandle !== null) {
        cancelAnimationFrame(captureRetryHandle);
        captureRetryHandle = null;
      }
      if (videoFrameHandle !== null
          && typeof videoWithFrameCallback?.cancelVideoFrameCallback === 'function') {
        videoWithFrameCallback.cancelVideoFrameCallback(videoFrameHandle);
      }
      videoFrameHandle = null;
      // Only a PAUSED element needs the settled snapshot, because no future presentation may ever
      // come for it. A PLAYING video re-enters the presentation loop immediately, and its next
      // rVFC delivers the first decoded post-seek frame — while drawImage at this exact settled
      // boundary can still legally hand back the transitioning decoder surface as solid black,
      // which is precisely the one-frame black flash the continuity witness caught after playing
      // backward seeks. The held pre-seek composition covers the one-frame gap.
      if (!video.paused) {
        schedule();
        return;
      }
      const candidate = captureCandidate(
        video,
        null,
        videoFrameGeneration,
      );
      if (candidate !== null) publishCandidate(candidate);
      else if (rendererRef.current !== null) scheduleCaptureRetry(video, videoFrameGeneration);
      schedule();
    };
    const beginSeek = () => {
      if (hasFrameCallback) {
        // Preserve the already published Canvas pixels, but revoke permission to repaint them. In
        // the `seeked` -> rVFC interval drawImage(video) may already expose the new pixels while
        // this token still names the old cue, so a style/resize redraw would create a mixed frame.
        presentedFrameRef.current = {
          sourceKey: latestRef.current?.sourceKey ?? null,
          mediaTime: null,
          transportTime: null,
          provenance: null,
        };
        presentedSceneRef.current = {
          sourceKey: latestRef.current?.sourceKey ?? null,
          time: null,
        };
        desiredPixelFrameRef.current = {
          sourceKey: latestRef.current?.sourceKey ?? null,
          source: null,
          mediaTime: null,
          transportTime: null,
          provenance: null,
        };
        publishedSceneRef.current = {
          sourceKey: latestRef.current?.sourceKey ?? null,
          time: null,
        };
        supersedePendingFrame();
      }
    };
    const beginSourceLoad = () => {
      presentedFrameRef.current = {
        sourceKey: latestRef.current?.sourceKey ?? null,
        mediaTime: null,
        transportTime: null,
        provenance: null,
      };
      presentedSceneRef.current = {
        sourceKey: latestRef.current?.sourceKey ?? null,
        time: null,
      };
      desiredPixelFrameRef.current = {
        sourceKey: latestRef.current?.sourceKey ?? null,
        source: null,
        mediaTime: null,
        transportTime: null,
        provenance: null,
      };
      publishedSceneRef.current = {
        sourceKey: latestRef.current?.sourceKey ?? null,
        time: null,
      };
      if (hasFrameCallback) supersedePendingFrame();
    };
    video?.addEventListener?.('loadeddata', wakeForDecodedFrame);
    video?.addEventListener?.('canplay', wakeForDecodedFrame);
    video?.addEventListener?.('seeked', completeSeek);
    video?.addEventListener?.('seeking', beginSeek);
    video?.addEventListener?.('loadstart', beginSourceLoad);
    video?.addEventListener?.('emptied', beginSourceLoad);
    // A paused source can already be at HAVE_CURRENT_DATA before this effect arms rVFC. In that
    // legal ordering there is no future presentation callback to wait for, so publish the settled
    // current frame once. The same generation invalidation used by seek completion prevents a late
    // callback from overwriting it.
    if (sourceKey !== null && video !== null && video.readyState >= 2 && !video.seeking) completeSeek();
    else schedule();
    return () => {
      stopped = true;
      if (captureRetryHandle !== null) cancelAnimationFrame(captureRetryHandle);
      captureRetryHandle = null;
      drawRef.current = () => undefined;
      video?.removeEventListener?.('loadeddata', wakeForDecodedFrame);
      video?.removeEventListener?.('canplay', wakeForDecodedFrame);
      video?.removeEventListener?.('seeked', completeSeek);
      video?.removeEventListener?.('seeking', beginSeek);
      video?.removeEventListener?.('loadstart', beginSourceLoad);
      video?.removeEventListener?.('emptied', beginSourceLoad);
      if (videoFrameHandle !== null && typeof videoWithFrameCallback?.cancelVideoFrameCallback === 'function') {
        videoWithFrameCallback.cancelVideoFrameCallback(videoFrameHandle);
      }
    };
  }, [videoRef, publish, retryToken, sourceKey]);

  // The source callback owns decoded pixels; this small output-grid clock owns subtitle time. A
  // 15 fps source exported at 30 fps must publish the held source image twice with two different
  // scene instants. Skip missed output frames rather than replaying a backlog after a stalled tab.
  useEffect(() => {
    if (!playing) return undefined;
    const video = videoRef.current;
    let stopped = false;
    let frameHandle = null;
    const tick = () => {
      if (stopped) return;
      const snapshot = latestRef.current;
      const sceneTime = previewSceneTime(
        video?.currentTime,
        snapshot?.frameRate,
        snapshot?.trimStart,
      );
      const published = publishedSceneRef.current;
      if (!Object.is(published.sourceKey, snapshot?.sourceKey)
          || !Object.is(published.time, sceneTime)) {
        if (typeof video?.requestVideoFrameCallback === 'function') {
          const pixels = desiredPixelFrameRef.current;
          if (Object.is(pixels.sourceKey, snapshot?.sourceKey) && pixels.source !== null) {
            drawRef.current({
              mediaTime: pixels.mediaTime,
              transportTime: video?.currentTime,
              provenance: pixels.provenance,
            }, sceneTime, pixels.source);
          }
        } else {
          drawRef.current({
            mediaTime: null,
            transportTime: video?.currentTime,
            provenance: 'transport-only',
          }, sceneTime);
        }
      }
      frameHandle = requestAnimationFrame(tick);
    };
    frameHandle = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      if (frameHandle !== null) cancelAnimationFrame(frameHandle);
    };
  }, [playing, sourceKey, videoRef]);

  // Browsers without rVFC publish paused seeks from `seeked` (registered above). Do not let a React
  // transport update bypass the decoded-frame boundary on capable browsers.
  useEffect(() => {
    const video = videoRef.current;
    if (playing || typeof video?.requestVideoFrameCallback === 'function') return;
    drawRef.current(
      {
        mediaTime: null,
        transportTime: video?.currentTime,
        provenance: 'transport-only',
      },
      previewSceneTime(
        video?.currentTime,
        latestRef.current?.frameRate,
        latestRef.current?.trimStart,
      ),
    );
  }, [currentTime, seeking, playing, videoRef]);

  useEffect(() => () => {
    lifecycleGenerationRef.current += 1;
    pendingRef.current.clear();
    for (const entry of cacheRef.current.values()) {
      if (entry.canvas) {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
      }
    }
    cacheRef.current.clear();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`canvas-video-preview ${className}`.trim()}
      data-osg-preview-engine="canvas-atlas"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        // Fullscreen changes the element box to the monitor's aspect ratio. Stretching the bitmap
        // to that box distorts both the decoded frame and the subtitle geometry. Keep the authored
        // composition intact; the black element background owns any unavoidable letterbox area.
        objectFit: 'contain',
        backgroundColor: '#000',
        display: 'block',
        pointerEvents: 'none',
        zIndex: 2,
        ...(style ?? {}),
      }}
    />
  );
};

export default CanvasVideoPreview;
