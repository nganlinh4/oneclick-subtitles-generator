import { useState } from 'react';
import { useNarrationLaneDrag } from './useNarrationLaneDrag';

/**
 * Owns the narration-lane staging state, kept out of TimelineVisualization so it stays lean:
 *  - globalSpeed: base speed scaling every clip's length (manual slider or Auto arrange)
 *  - placementStarts: per-clip start overrides (drag / arrange), or null for subtitle-anchored
 *  - perLineWeight: how much each clip may adapt its own speed to fit its slot (0 = uniform)
 * plus the lane drag handler, which needs the same state to hit-test/move clips.
 *
 * These only affect the lane until the user commits with "Pull subtitles to narration".
 */
export const useNarrationLaneState = ({
  timelineRef,
  getTimeRange,
  duration,
  lyrics,
  getSegmentsFor,
  reserveBottom,
  setLaneCursor,
}) => {
  const [globalSpeed, setGlobalSpeed] = useState(1);
  const [placementStarts, setPlacementStarts] = useState(null);
  const [perLineWeight, setPerLineWeight] = useState(0);

  const drag = useNarrationLaneDrag({
    timelineRef,
    getTimeRange,
    duration,
    lyrics,
    getSegmentsFor,
    reserveBottom,
    placementStarts,
    setPlacementStarts,
    globalSpeed,
    perLineWeight,
    setLaneCursor,
  });

  return {
    globalSpeed,
    setGlobalSpeed,
    placementStarts,
    setPlacementStarts,
    perLineWeight,
    setPerLineWeight,
    drag,
  };
};
