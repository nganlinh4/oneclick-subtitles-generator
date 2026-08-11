// Pure helpers for the narration lane, which is a client-side STAGING track of narration
// placement (clip start times + speeds) — decoupled from subtitle timing until the user commits
// with "Pull subtitles to narration". Subtitles only change at the commit step.

// Small overlap (seconds) tolerated between adjacent clips while arranging, so clips can pack
// tightly without being forced fully gap-separated. This preserves the reviewed allowed-overlap rule.
export const ACCEPTABLE_OVERLAP = 0.3;
// Caps for auto/per-line speed. Research (isochrony / speaking-rate studies): keep speed near 1.0×;
// past ~1.2× it audibly speeds up, so bias to gentle speed-UP only and clamp.
export const AUTO_SPEED_MAX = 1.5;
export const PER_LINE_SPEED_MAX = 1.6;
// Default per-line adaptiveness used by Auto arrange: a small, gentle nudge (0 = off, 1 = exact fit).
export const PER_LINE_WEIGHT_DEFAULT = 0.35;

/** Stable key matching a subtitle/lyric to its narration result. */
export const lyricKey = (lyric, index) => lyric?.id ?? lyric?.subtitle_id ?? index + 1;

/** Effective on-timeline length of a clip at the given speed (audio plays 1/speed as long). */
export const placementLength = (audioDuration, speed = 1) =>
  Math.max(0.05, (audioDuration > 0 ? audioDuration : 0.5) / (speed || 1));

/**
 * Per-clip effective speed: the base global speed, nudged UP toward the speed that would make the
 * clip exactly fill `slot` seconds, by `weight` (0..1). Speed-up only, clamped. weight 0 (or a clip
 * that already fits) returns the global speed unchanged — i.e. a uniform rate.
 */
export const effectiveSpeed = (audioDuration, slot, globalSpeed = 1, weight = 0, max = PER_LINE_SPEED_MAX) => {
  const g = globalSpeed || 1;
  if (weight <= 0 || !(slot > 0) || !(audioDuration > 0)) return g;
  const needed = audioDuration / slot; // speed to fit exactly into the slot
  if (needed <= g) return g; // already fits at the global speed — don't slow down
  return Math.min(max, g + weight * (needed - g));
};

/**
 * Resolve each clip's placed start, per-line effective speed and end, given staged start overrides
 * + a global speed + a per-line weight. A clip's slot is the gap to the NEXT clip's start (the last
 * clip is unbounded). Pure; shared by the lane draw, the audio apply and the commit so they agree.
 * @returns {Array} segments with { ...orig, start, speed, end } (input order preserved)
 */
export const resolvePlacements = (segments, placementStarts, globalSpeed = 1, weight = 0) => {
  const placed = (segments || []).map((s) => ({
    ...s,
    start: placementStarts && placementStarts[s.id] != null ? placementStarts[s.id] : s.start,
  }));
  const order = [...placed].sort((a, b) => a.start - b.start); // same object refs as `placed`
  for (let i = 0; i < order.length; i += 1) {
    const seg = order[i];
    const next = order[i + 1];
    const slot = next ? next.start - seg.start : Infinity;
    seg.speed = effectiveSpeed(seg.audioDuration, slot, globalSpeed, weight);
    seg.end = seg.start + placementLength(seg.audioDuration, seg.speed);
  }
  return placed;
};

/**
 * Sequential placement starts for narration clips, in time order. Each clip keeps its start unless
 * pushed right by the previous clip's end — minus ACCEPTABLE_OVERLAP, so clips may pack with a small
 * tolerated overlap rather than a hard gap. Placement only; does not change speed.
 * @returns {Object} { [id]: startSec }
 */
export const arrangePlacement = (segments, speed = 1, acceptableOverlap = ACCEPTABLE_OVERLAP) => {
  const ordered = [...(segments || [])].sort((a, b) => a.start - b.start);
  const starts = {};
  let previousEnd = -Infinity;
  for (const seg of ordered) {
    const start = Math.max(seg.start, previousEnd - acceptableOverlap);
    starts[seg.id] = start;
    previousEnd = start + placementLength(seg.audioDuration, speed);
  }
  return starts;
};

/**
 * Smart global speed: the gentlest speed-up (>= 1) so the narration's total natural length fits the
 * window it must cover (the classic isochrony ratio, total speech / available time), clamped. Used
 * by Auto arrange to "decide" the speed.
 */
export const computeAutoSpeed = (segments, windowSeconds, { min = 1, max = AUTO_SPEED_MAX } = {}) => {
  const total = (segments || []).reduce((sum, s) => sum + (s.audioDuration > 0 ? s.audioDuration : 0), 0);
  if (!(windowSeconds > 0) || total <= 0) return min;
  return Math.min(max, Math.max(min, total / windowSeconds));
};

/** Move a clip's placement start by deltaSec, snapping to nearby targets within snapTol seconds. */
export const movePlacementStart = (currentStart, deltaSec, { snapTargets = [], snapTol = 0.12 } = {}) => {
  const value = Math.max(0, currentStart + deltaSec);
  let best = value;
  let bestDist = snapTol;
  for (const target of snapTargets) {
    const dist = Math.abs(target - value);
    if (dist < bestDist) { bestDist = dist; best = target; }
  }
  return best;
};

/**
 * Commit the staged placement to subtitle timings: each subtitle becomes its clip's resolved
 * [start, end] (matching the lane exactly, per-line speeds included). Returns new lyrics for
 * applyTimings (undoable).
 */
export const placementToLyrics = (lyrics, segments, placementStarts, speed = 1, weight = 0) => {
  const byId = new Map(resolvePlacements(segments, placementStarts, speed, weight).map((s) => [s.id, s]));
  return (lyrics || []).map((lyric, i) => {
    const seg = byId.get(lyricKey(lyric, i));
    if (!seg) return lyric;
    return { ...lyric, start: seg.start, end: seg.end };
  });
};
