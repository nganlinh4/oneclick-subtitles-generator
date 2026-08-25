import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { fontCapabilitySnapshot } from '../../../services/fontCapability';
import {
  PREVIEW_FULL_FRAME_CROP,
  atlasBakeRequest,
  bakePreviewAtlas,
  previewCueList,
  previewFace,
} from '../native/nativePreviewScene';
import { compositionSize } from '../native/nativePreviewGeometry';
import { useVideoSourceDimensions } from '../native/useNativePreviewSource';
import { activeCueAtFrom, cueTransformAt, easeSubtitle } from './canvasSubtitleMath';
import { createAtlasCanvas, createCanvasSubtitleRenderer } from './canvasSubtitleRenderer';

const MAX_CACHE_ENTRIES = 8;
const MAX_DEVICE_PIXEL_RATIO = 1.5;
const MAX_CANVAS_WIDTH = 1_600;
const MAX_CANVAS_HEIGHT = 1_000;

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

const faceProbe = () => {
  if (typeof document.fonts?.check !== 'function') return null;
  return ({ family, weight }) => {
    try {
      return document.fonts.check(`${weight} 16px "${family}"`);
    } catch {
      return false;
    }
  };
};

const stateKey = (state) => `${state.status}|${state.code ?? ''}`;
const atlasKey = (snapshot, activeCue) => (
  `${snapshot.sceneKey}|${activeCue.index}|${activeCue.cue.text}`
);

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
  customization,
  subtitles,
  resolution,
  crop = PREVIEW_FULL_FRAME_CROP,
  trimStart = 0,
  trimEnd = 0,
  onStateChange = null,
  className = '',
  style = null,
}) => {
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const cacheRef = useRef(new Map());
  const pendingRef = useRef(new Set());
  const generationRef = useRef(0);
  const latestRef = useRef(null);
  const drawRef = useRef(() => undefined);
  const publishedRef = useRef('');
  const revisionRef = useRef(0);
  const overlayRebuildsRef = useRef(0);
  const cueCursorRef = useRef({ index: 0, time: Number.NEGATIVE_INFINITY, sceneKey: '' });
  const dimensions = useVideoSourceDimensions(videoRef, sourceKey);

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
      capability: fontCapabilitySnapshot(),
      isSystemFaceInstalled: faceProbe(),
    });
  }, [fontFamily, fontWeight]);
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
    customization,
    cues,
    face,
    composition,
    crop,
    trimStart,
    trimEnd,
    sceneKey,
  };

  useLayoutEffect(() => {
    generationRef.current += 1;
    for (const entry of cacheRef.current.values()) {
      if (entry.canvas) {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
      }
    }
    cacheRef.current.clear();
    pendingRef.current.clear();
    cueCursorRef.current = { index: 0, time: Number.NEGATIVE_INFINITY, sceneKey };
    drawRef.current();
  }, [sceneKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    // jsdom deliberately has no raster canvas. Parent component tests inspect wiring and DOM; the
    // real drawing contract is exercised by the browser journey and renderer unit tests.
    if (navigator.userAgent.toLowerCase().includes('jsdom')) {
      publish({ status: 'idle', code: null });
      return undefined;
    }
    rendererRef.current = createCanvasSubtitleRenderer(canvas);
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
  }, [publish]);

  useEffect(() => {
    let frameHandle = null;
    let videoFrameHandle = null;
    let videoWithFrameCallback = null;
    let stopped = false;
    let drawing = false;

    const schedule = () => {
      if (stopped || !latestRef.current?.playing) return;
      const video = videoRef.current;
      if (typeof video?.requestVideoFrameCallback === 'function') {
        videoWithFrameCallback = video;
        videoFrameHandle = video.requestVideoFrameCallback(() => {
          draw();
          schedule();
        });
      } else {
        frameHandle = requestAnimationFrame(() => {
          draw();
          schedule();
        });
      }
    };

    const bake = (activeCue, snapshot) => {
      const key = atlasKey(snapshot, activeCue);
      if (cacheRef.current.has(key) || pendingRef.current.has(key)) return key;
      const generation = generationRef.current;
      pendingRef.current.add(key);
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
          if (generation !== generationRef.current) return;
          cachePut(cacheRef.current, key, { atlas, canvas: createAtlasCanvas(atlas) });
        } catch (error) {
          if (generation !== generationRef.current) return;
          const code = error?.code ?? 'canvasPreviewRejected';
          // A deterministic bake failure must be sticky for this scene. Retrying from `finally`
          // creates an unbounded microtask loop: bake -> fail -> draw -> bake, starving the whole
          // WebView so even diagnostics and controls stop responding. A changed scene gets a new
          // key and may bake; this exact request remains refused until then.
          cachePut(cacheRef.current, key, { error: code });
          publish({ status: 'error', code });
        } finally {
          pendingRef.current.delete(key);
          if (generation === generationRef.current) drawRef.current();
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

    const draw = () => {
      if (stopped || drawing) return;
      drawing = true;
      try {
        const snapshot = latestRef.current;
        const renderer = rendererRef.current;
        const video = videoRef.current;
        if (!snapshot?.active || renderer === null || video === null || snapshot.composition === null) {
          publish({ status: 'idle', code: null });
          return;
        }
        // Seeking invalidates the video's decoded presentation frame before the replacement is
        // available. Preserve the last atomically published composition instead of exposing an
        // intermediate old/empty/black frame. `video.seeking` closes the small interval before
        // React has committed the explicit lifecycle prop.
        if (snapshot.seeking || video.seeking) return;
        const time = Number.isFinite(video.currentTime) ? video.currentTime : snapshot.currentTime;
        const outsideTrim = time < snapshot.trimStart
          || (snapshot.trimEnd > snapshot.trimStart && time > snapshot.trimEnd);
        const selected = outsideTrim || snapshot.customization === null ? null : selectCue(snapshot, time);
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
            bake({ cue: next, index: selected.index + 1 }, snapshot);
          }
        }
        const result = renderer.draw({
          video,
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
          if (result.overlayRebuilt === true) overlayRebuildsRef.current += 1;
          revisionRef.current += 1;
          canvas.dataset.osgFrameRevision = String(revisionRef.current);
          canvas.dataset.osgCueIndex = selected === null ? '' : String(selected.index);
          canvas.dataset.osgViewportLeft = String(result.viewport.left);
          canvas.dataset.osgViewportTop = String(result.viewport.top);
          canvas.dataset.osgViewportWidth = String(result.viewport.width);
          canvas.dataset.osgViewportHeight = String(result.viewport.height);
          canvas.dataset.osgOverlayRebuilds = String(overlayRebuildsRef.current);
        }
        if (snapshot.face === null || snapshot.customization === null) {
          // The display canvas is opaque and sits above the live video. Returning before repainting
          // left its last pixels frozen while audio and the seek bar continued underneath it.
          publish({ status: 'error', code: 'fontUnavailable' });
        }
        else if (!drewVideo) publish({ status: 'source-loading', code: null });
        else if (selected === null) publish({
          status: snapshot.cues.length === 0 ? 'empty' : outsideTrim ? 'outside-trim' : 'between-cues',
          code: null,
        });
        else if (cacheRef.current.get(atlasKey(snapshot, selected))?.error) {
          publish({
            status: 'error',
            code: cacheRef.current.get(atlasKey(snapshot, selected)).error,
          });
        }
        else if (entry === null) publish({ status: 'pending', code: null });
        else publish({ status: 'ready', code: null });
      } finally {
        drawing = false;
      }
    };

    drawRef.current = draw;
    draw();
    schedule();
    return () => {
      stopped = true;
      drawRef.current = () => undefined;
      if (frameHandle !== null) cancelAnimationFrame(frameHandle);
      if (videoFrameHandle !== null && typeof videoWithFrameCallback?.cancelVideoFrameCallback === 'function') {
        videoWithFrameCallback.cancelVideoFrameCallback(videoFrameHandle);
      }
    };
  }, [playing, videoRef, publish]);

  // Paused seeks and externally driven playheads do not produce a video-frame callback.
  useEffect(() => {
    drawRef.current();
  }, [currentTime, seeking]);

  useEffect(() => () => {
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
        display: 'block',
        pointerEvents: 'none',
        zIndex: 2,
        ...(style ?? {}),
      }}
    />
  );
};

export default CanvasVideoPreview;
