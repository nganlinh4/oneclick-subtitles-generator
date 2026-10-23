import { useCallback, useRef } from 'react';
import { timeToX } from './utils/TimelineCalculations';
import { computeTimelineBands } from './utils/timelineBands';
import { movePlacementStart } from './narrationLaneActions';

/**
 * Dragging in the narration lane moves a clip's PLACEMENT (its staged start time) — subtitles
 * don't change until the user commits with "Pull subtitles to narration". Clip length is fixed by
 * the audio + global speed, so dragging is move-only.
 *
 * @returns {{onMouseDown:(e)=>boolean, onHoverMove:(e)=>void}}
 *   onMouseDown returns true when it started a lane drag (caller should then skip seek/select).
 */
export const useNarrationLaneDrag = ({
  timelineRef,
  getTimeRange,
  duration,
  lyrics,
  getSegmentsFor,
  reserveBottom,
  placementStarts,
  setPlacementStarts,
  globalSpeed,
  perLineWeight = 0,
  setLaneCursor,
}) => {
  const lastCursorRef = useRef(null);

  const pixelToTime = useCallback((clientX) => {
    const canvas = timelineRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const range = getTimeRange();
    const perPx = (range.end - range.start) / canvas.clientWidth;
    return Math.max(0, Math.min(duration || 1e9, range.start + (clientX - rect.left) * perPx));
  }, [timelineRef, getTimeRange, duration]);

  // Returns { seg } if (clientX, clientY) lands on a narration block, else null.
  const hitTest = useCallback((clientX, clientY) => {
    const canvas = timelineRef.current;
    if (!canvas || typeof setPlacementStarts !== 'function') return null;
    const segments = getSegmentsFor(lyrics, placementStarts, globalSpeed, perLineWeight);
    if (!segments.length) return null;

    const rect = canvas.getBoundingClientRect();
    const { narrationBand } = computeTimelineBands(canvas.clientHeight, reserveBottom, true);
    if (!narrationBand) return null;
    const yInCanvas = clientY - rect.top;
    if (yInCanvas < narrationBand.top - 4 || yInCanvas > narrationBand.top + narrationBand.height + 4) return null;

    const range = getTimeRange();
    const visibleDuration = range.end - range.start;
    const width = canvas.clientWidth;
    const px = clientX - rect.left;
    for (const seg of segments) {
      const x0 = timeToX(seg.start, range.start, visibleDuration, width);
      const x1 = timeToX(seg.end, range.start, visibleDuration, width);
      if (px >= x0 - 4 && px <= x1 + 4) return { seg };
    }
    return null;
  }, [timelineRef, setPlacementStarts, getSegmentsFor, lyrics, placementStarts, globalSpeed, perLineWeight, reserveBottom, getTimeRange]);

  const onMouseDown = useCallback((e) => {
    const hit = hitTest(e.clientX, e.clientY);
    if (!hit) return false;
    e.preventDefault();
    e.stopPropagation();

    const { seg } = hit;
    const baseStart = seg.start; // placement start at drag start
    const startTime = pixelToTime(e.clientX);
    const snapTargets = [];
    getSegmentsFor(lyrics, placementStarts, globalSpeed, perLineWeight).forEach((s) => {
      if (s.id !== seg.id) snapTargets.push(s.start, s.end);
    });

    if (setLaneCursor) setLaneCursor('grabbing');
    const onMove = (ev) => {
      const delta = pixelToTime(ev.clientX) - startTime;
      const newStart = movePlacementStart(baseStart, delta, { snapTargets });
      setPlacementStarts((prev) => ({ ...(prev || {}), [seg.id]: newStart }));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (setLaneCursor) setLaneCursor(null);
      lastCursorRef.current = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return true;
  }, [hitTest, pixelToTime, lyrics, placementStarts, globalSpeed, perLineWeight, getSegmentsFor, setPlacementStarts, setLaneCursor]);

  const onHoverMove = useCallback((e) => {
    const next = hitTest(e.clientX, e.clientY) ? 'grab' : null;
    if (next !== lastCursorRef.current) {
      lastCursorRef.current = next;
      if (setLaneCursor) setLaneCursor(next);
    }
  }, [hitTest, setLaneCursor]);

  return { onMouseDown, onHoverMove };
};
