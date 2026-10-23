import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import { useFontReadiness } from '../../../services/useFontReadiness';
import { parseFontFamilyValue } from '../../../services/fontIdentity';
import { systemFontProbe } from '../../../platform/systemFontProbe';
import {
  PREVIEW_FULL_FRAME_CROP,
  previewCueList,
  previewFace,
} from '../native/nativePreviewScene';
import { useVideoSourceDimensions } from '../native/useNativePreviewSource';
import { releaseAtlasCanvas } from './canvasPreviewAtlas';
import { startCanvasFrameScheduler } from './canvasFrameScheduler';
import {
  canvasBackingSize,
  canvasCompositionSize,
  canvasPreviewFailure,
  platformName,
  stateKey,
} from './canvasPreviewModel';
import { createCanvasSubtitleRenderer } from './canvasSubtitleRenderer';
import useAtlasCacheRetry from './useAtlasCacheRetry';
import useSceneClockRedraws from './useSceneClockRedraws';

/**
 * Persistent, display-resolution preview compositor.
 *
 * The subtitle is painted from the same shaped line atlas staged for native export. The editor can
 * leave the hardware-decoded `<video>` visible underneath this transparent canvas; render-preview
 * surfaces can instead ask the canvas to composite the underlay for exact crop/backfill inspection.
 * No frame bytes cross IPC, no PNG is encoded or decoded, and React is not involved in playback.
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
  videoUnderlay = true,
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
    videoUnderlay,
  };

  useLayoutEffect(() => {
    // The complete scene invalidates selection and paint, not shaped glyphs. Atlas entries are
    // content-addressed by their own smaller dependency set and remain reusable across timing,
    // position, animation and colour edits.
    cueCursorRef.current = { index: 0, time: Number.NEGATIVE_INFINITY, sceneKey };
    drawRef.current();
  }, [paintKey, sceneKey]);

  useAtlasCacheRetry({
    retryToken,
    retryTokenRef,
    cacheRef,
    pendingRef,
    lifecycleGenerationRef,
    rendererFailureRef,
    publishedRef,
    drawRef,
  });

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
      rendererRef.current = createCanvasSubtitleRenderer(canvas, { drawVideo: videoUnderlay });
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
      const { width, height } = canvasBackingSize(bounds, window.devicePixelRatio);
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
  }, [publish, retryToken, videoUnderlay]);

  useEffect(() => startCanvasFrameScheduler({
    videoRef,
    sourceKey,
    publish,
    latestRef,
    rendererRef,
    canvasRef,
    cacheRef,
    pendingRef,
    lifecycleGenerationRef,
    rendererFailureRef,
    drawRef,
    publishedRef,
    overlayRebuildsRef,
    revisionRef,
    cueCursorRef,
    presentedFrameRef,
    presentedSceneRef,
    desiredPixelFrameRef,
    committedPixelFrameRef,
    publishedSceneRef,
  }), [videoRef, publish, retryToken, sourceKey]);

  useSceneClockRedraws({
    playing,
    seeking,
    currentTime,
    sourceKey,
    videoRef,
    latestRef,
    publishedSceneRef,
    desiredPixelFrameRef,
    drawRef,
  });

  useEffect(() => () => {
    lifecycleGenerationRef.current += 1;
    pendingRef.current.clear();
    for (const entry of cacheRef.current.values()) releaseAtlasCanvas(entry);
    cacheRef.current.clear();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`canvas-video-preview ${className}`.trim()}
      data-osg-preview-engine="canvas-atlas"
      data-osg-video-underlay={videoUnderlay ? 'canvas' : 'direct'}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        // The backing store has this same ratio; contain is therefore a no-op except while a resize
        // is settling, when it prevents one transient distorted frame.
        objectFit: 'contain',
        backgroundColor: videoUnderlay ? '#000' : 'transparent',
        display: 'block',
        pointerEvents: 'none',
        zIndex: 2,
        ...(style ?? {}),
      }}
    />
  );
};

export default CanvasVideoPreview;