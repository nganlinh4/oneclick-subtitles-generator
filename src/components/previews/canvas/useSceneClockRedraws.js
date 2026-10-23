/**
 * Redraws driven by the transport clock rather than by decoded frames: the output-grid clock while
 * playing, and React transport updates on browsers without requestVideoFrameCallback.
 */
import { useEffect } from 'react';

import { transportOnlyClock, transportSceneTime } from './canvasPreviewModel';

const useSceneClockRedraws = ({
  playing,
  seeking,
  currentTime,
  sourceKey,
  videoRef,
  latestRef,
  publishedSceneRef,
  desiredPixelFrameRef,
  drawRef,
}) => {
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
      const sceneTime = transportSceneTime(video, snapshot);
      const published = publishedSceneRef.current;
      if (!Object.is(published.sourceKey, snapshot?.sourceKey)
          || !Object.is(published.time, sceneTime)) {
        if (typeof video?.requestVideoFrameCallback === 'function' && snapshot?.videoUnderlay) {
          const pixels = desiredPixelFrameRef.current;
          if (Object.is(pixels.sourceKey, snapshot?.sourceKey) && pixels.source !== null) {
            drawRef.current({
              mediaTime: pixels.mediaTime,
              transportTime: video?.currentTime,
              provenance: pixels.provenance,
            }, sceneTime, pixels.source);
          }
        } else {
          drawRef.current(transportOnlyClock(video), sceneTime);
        }
      }
      frameHandle = requestAnimationFrame(tick);
    };
    frameHandle = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      if (frameHandle !== null) cancelAnimationFrame(frameHandle);
    };
  }, [playing, sourceKey, videoRef, latestRef, publishedSceneRef, desiredPixelFrameRef, drawRef]);

  // Browsers without rVFC publish paused seeks from `seeked` (registered above). Do not let a React
  // transport update bypass the decoded-frame boundary on capable browsers.
  useEffect(() => {
    const video = videoRef.current;
    if (playing || typeof video?.requestVideoFrameCallback === 'function') return;
    drawRef.current(transportOnlyClock(video), transportSceneTime(video, latestRef.current));
  }, [currentTime, seeking, playing, videoRef, latestRef, drawRef]);
};

export default useSceneClockRedraws;
