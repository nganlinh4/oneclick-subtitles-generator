import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isNativeNarrationResult } from '../../platform/nativeNarrationCapabilities';
import { lyricKey, resolvePlacements } from './narrationLaneActions';
import { getTimingConflictIds } from './utils/timelineConflicts';

// The immutable backup sibling holds a clip's natural (un-edited) duration.
const backupName = (filename) => {
  if (!filename) return null;
  const slash = filename.lastIndexOf('/');
  const dir = slash >= 0 ? filename.slice(0, slash) : '';
  const base = slash >= 0 ? filename.slice(slash + 1) : filename;
  return `${dir ? `${dir}/` : ''}backup_${base}`;
};

// Narration results are mirrored to window by the narration UI; prefer grouped when active.
const readNarrations = () => {
  if (typeof window === 'undefined') return [];
  if (window.useGroupedSubtitles && Array.isArray(window.groupedNarrations) && window.groupedNarrations.length) {
    return window.groupedNarrations;
  }
  return window.originalNarrations || window.translatedNarrations || [];
};

/**
 * Base segments: one per generated clip, anchored at its subtitle's start, carrying the clip's
 * natural (backup) audio duration. Placement-independent — the staging layer positions them.
 */
const buildBaseSegments = (lyrics, narrations, durations) => {
  const successful = (narrations || []).filter((n) => n && n.success && n.filename);
  if (!successful.length || !Array.isArray(lyrics) || !lyrics.length) return [];

  const resolveDuration = (filename) => {
    const backup = backupName(filename);
    if (backup && typeof durations[backup] === 'number') return durations[backup];
    if (typeof durations[filename] === 'number') return durations[filename];
    return null;
  };

  const lyricById = new Map(lyrics.map((l, i) => [lyricKey(l, i), l]));
  const base = [];
  for (const narration of successful) {
    const lyric = lyricById.get(narration.subtitle_id);
    if (!lyric || !Number.isFinite(lyric.start)) continue;
    const audioDuration = resolveDuration(narration.filename);
    if (!(audioDuration > 0)) continue;
    base.push({ id: narration.subtitle_id, filename: narration.filename, start: lyric.start, audioDuration });
  }
  return base;
};

/**
 * Place base segments onto the timeline: apply per-clip start overrides + a global speed and a
 * per-line adaptive weight (resolvePlacements), then flag clips whose overlap with a neighbour
 * exceeds the conflict threshold (whole block highlighted, SGT-style). Returns draw-ready segments
 * ({ start, end, speed, conflict, ... }).
 */
const placeSegments = (baseSegments, placementStarts, speed, weight) => {
  const placed = resolvePlacements(baseSegments, placementStarts, speed, weight);
  const conflictIds = getTimingConflictIds(placed);
  placed.forEach((s) => { s.conflict = conflictIds.has(s.id); });
  return placed;
};

/**
 * Narration-lane data for the timeline staging track.
 *
 * Returns the placement-independent `segments` (for the controls + commit) and a stable
 * `getSegmentsFor(lyrics, placementStarts, speed)` that produces the draw/hit-test segments for
 * any placement + speed, using the currently-cached durations. The lane is built from the exact
 * inputs being drawn, so it never desyncs.
 *
 * @param {Array} lyrics
 */
export const useNarrationTimelineData = (lyrics) => {
  const [durations, setDurations] = useState({});
  const [tick, setTick] = useState(0); // bumps re-read of window narrations on change events
  const durationsRef = useRef(durations);
  durationsRef.current = durations;

  useEffect(() => {
    const onChange = () => setTick((t) => t + 1);
    window.addEventListener('narrations-updated', onChange);
    window.addEventListener('narration-speed-modified', onChange);
    return () => {
      window.removeEventListener('narrations-updated', onChange);
      window.removeEventListener('narration-speed-modified', onChange);
    };
  }, []);

  // Fetch (and cache) clip durations when the set of narration files changes.
  useEffect(() => {
    const filenames = readNarrations()
      .filter((n) => n && n.success && n.filename)
      .map((n) => n.filename);
    if (!filenames.length) return undefined;
    const nativeDurations = {};
    readNarrations().filter(isNativeNarrationResult).forEach((narration) => {
      const duration = Number(narration.durationMicros) / 1_000_000;
      if (!narration.filename || !Number.isFinite(duration) || duration <= 0) return;
      nativeDurations[narration.filename] = duration;
      const backup = backupName(narration.filename);
      if (backup) nativeDurations[backup] = duration;
    });
    if (Object.keys(nativeDurations).length > 0) {
      setDurations((previous) => ({ ...previous, ...nativeDurations }));
    }
    return undefined;
  }, [tick]);

  const segments = useMemo(() => {
    // Narration events increment tick specifically to invalidate this derived list.
    void tick;
    return buildBaseSegments(lyrics, readNarrations(), durations);
  }, [lyrics, durations, tick]);

  // Stable: build the placed (draw/hit-test) segments for any placement + speed + per-line weight.
  const getSegmentsFor = useCallback(
    (lyricsArg, placementStarts = null, speed = 1, weight = 0) =>
      placeSegments(buildBaseSegments(lyricsArg, readNarrations(), durationsRef.current), placementStarts, speed, weight),
    [],
  );

  return { segments, getSegmentsFor };
};

export default useNarrationTimelineData;
