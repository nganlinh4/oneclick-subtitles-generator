// Source-bound frame scheduler for the canvas preview: arms requestVideoFrameCallback, follows
// seek/load media events, retries failed captures and drives the frame drawer. Returns a stop
// function that disarms everything it armed.
import { createAtlasBaker } from './canvasPreviewAtlas';
import { clearPresentedFrame, createFrameCapture } from './canvasFrameCapture';
import { createCueSelector, createFrameDrawer } from './canvasFrameDraw';
import {
  canvasPreviewFailure,
  previewSceneTime,
  transportOnlyClock,
  transportSceneTime,
} from './canvasPreviewModel';

const MAX_CAPTURE_RETRY_FRAMES = 3;

export const startCanvasFrameScheduler = ({
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
}) => {
  let videoFrameHandle = null;
  let videoWithFrameCallback = null;
  let videoFrameGeneration = 0;
  let captureRetryHandle = null;
  let captureRetryAttempts = 0;
  let stopped = false;
  // Black-surface rejection bookkeeping, reset with every seek generation: the check runs only
  // until a generation publishes its first frame, so steady playback never pays a readback.
  let publishedFrameThisGeneration = false;
  let blackSkipsThisGeneration = 0;

  const frameRefs = {
    presentedFrameRef,
    presentedSceneRef,
    desiredPixelFrameRef,
    committedPixelFrameRef,
    publishedSceneRef,
  };
  // A changed source identity invalidates every previously presented timestamp before any layout
  // effect is allowed to repaint. Native `loadstart`/`emptied` below also cover in-place fallback
  // loads which keep the React source key unchanged.
  clearPresentedFrame(frameRefs, sourceKey, { includeCommitted: true });

  const captureCandidate = createFrameCapture({
    latestRef,
    rendererRef,
    committedPixelFrameRef,
    sourceKey,
  });

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
    if (snapshot?.videoUnderlay
        && !publishedFrameThisGeneration
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

  // Invalidate every callback and retry armed for the current seek generation.
  const invalidateFrameGeneration = () => {
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
  };

  const supersedePendingFrame = () => {
    invalidateFrameGeneration();
    schedule();
  };

  const bake = createAtlasBaker({
    cacheRef,
    pendingRef,
    lifecycleGenerationRef,
    drawRef,
  });
  const selectCue = createCueSelector(cueCursorRef);
  const draw = createFrameDrawer({
    latestRef,
    rendererRef,
    videoRef,
    canvasRef,
    cacheRef,
    rendererFailureRef,
    ...frameRefs,
    overlayRebuildsRef,
    revisionRef,
    publish,
    bake,
    selectCue,
    scheduleCaptureRetry,
    isStopped: () => stopped,
    currentGeneration: () => videoFrameGeneration,
  });

  drawRef.current = draw;
  const video = videoRef.current;
  const hasFrameCallback = typeof video?.requestVideoFrameCallback === 'function';
  if (!hasFrameCallback) draw(transportOnlyClock(video), transportSceneTime(video, latestRef.current));
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
    else draw(transportOnlyClock(video), transportSceneTime(video, latestRef.current));
  };
  const completeSeek = () => {
    if (!hasFrameCallback) {
      draw(transportOnlyClock(video), transportSceneTime(video, latestRef.current));
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
    // A retry armed for the invalidated generation must not survive this boundary: its callback
    // exits on the generation mismatch without rescheduling, yet its pending handle blocks the
    // new generation from arming its own retry. With `loadeddata` and `canplay` arriving in one
    // task burst over a paused source whose first frame is genuinely black, that stale handle
    // left the canvas permanently blank after an A-to-B source switch.
    invalidateFrameGeneration();
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
      clearPresentedFrame(frameRefs, latestRef.current?.sourceKey ?? null);
      supersedePendingFrame();
    }
  };
  const beginSourceLoad = () => {
    clearPresentedFrame(frameRefs, latestRef.current?.sourceKey ?? null);
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
};
