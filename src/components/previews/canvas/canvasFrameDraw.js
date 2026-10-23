/**
 * One canvas preview frame: resolve the presented clock, select the active cue, compose video and
 * subtitle through the renderer as one atomic revision, and publish the typed preview state.
 */
import { activeCueAtFrom, cueTransformAt, easeSubtitle } from './canvasSubtitleMath';
import { atlasKey } from './canvasPreviewAtlas';
import { previewSceneTime } from './canvasPreviewModel';

/** Returns `selectCue(snapshot, time)`, walking forward from the last cue during monotonic playback. */
export const createCueSelector = (cueCursorRef) => (snapshot, time) => {
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

/**
 * Returns `draw(presentedClock, presentedSceneTime, presentedPixels)`. A draw re-entered while one
 * is running, or issued after `isStopped()`, is ignored.
 */
export const createFrameDrawer = ({
  latestRef,
  rendererRef,
  videoRef,
  canvasRef,
  cacheRef,
  rendererFailureRef,
  presentedFrameRef,
  presentedSceneRef,
  desiredPixelFrameRef,
  committedPixelFrameRef,
  publishedSceneRef,
  overlayRebuildsRef,
  revisionRef,
  publish,
  bake,
  selectCue,
  scheduleCaptureRetry,
  isStopped,
  currentGeneration,
}) => {
  let drawing = false;

  const draw = (presentedClock = null, presentedSceneTime = null, presentedPixels = null) => {
    if (isStopped() || drawing) return;
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
          scheduleCaptureRetry(video, currentGeneration());
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
      if (hasFrameCallback && snapshot.videoUnderlay && pixelFrame === null) {
        // No pixels to compose and, while paused, no future video frame to deliver any. Returning
        // silently here left the published state frozen (a customer-visible stuck "pending" after
        // a paused seek raced a lifecycle reset). The bounded capture retry re-snapshots the
        // paused element and ends in a typed canvasPreviewUnavailable refusal rather than an
        // eternal wait, so a lost one-shot wakeup can no longer wedge the preview.
        if (!video.seeking && video.readyState >= 2) {
          scheduleCaptureRetry(video, currentGeneration());
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
            scheduleCaptureRetry(video, currentGeneration());
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
        video: snapshot.videoUnderlay && hasFrameCallback ? pixelFrame : video,
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
        if (hasFrameCallback && snapshot.videoUnderlay) {
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
          scheduleCaptureRetry(video, currentGeneration());
        }
      }
      else publish({ status: 'ready', code: null });
    } finally {
      drawing = false;
    }
  };

  return draw;
};
