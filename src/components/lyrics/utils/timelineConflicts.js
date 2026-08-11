// Detect narration timing conflicts using the reviewed overlap rule: a clip is flagged (its
// WHOLE block highlighted) when it overlaps a neighbour by a meaningful amount — a large absolute
// overlap, or a smaller overlap that still eats a big fraction of the shorter clip. Tiny,
// inaudible overlaps are not flagged.

export const LARGE_OVERLAP_SEC = 0.35;
export const NESTED_OVERLAP_MIN_SEC = 0.1;
export const NESTED_OVERLAP_RATIO = 0.5;

const shouldFlagOverlap = (a, b) => {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap <= 0) return false;
  if (overlap >= LARGE_OVERLAP_SEC) return true;
  const shorter = Math.min(Math.max(0, a.end - a.start), Math.max(0, b.end - b.start));
  if (shorter <= 0) return false;
  return overlap >= NESTED_OVERLAP_MIN_SEC && overlap / shorter >= NESTED_OVERLAP_RATIO;
};

/**
 * @param {Array<{id:*, start:number, end:number}>} segments
 * @returns {Set} ids of segments that overlap a neighbour beyond the threshold (whole-block flag)
 */
export const getTimingConflictIds = (segments) => {
  const sorted = [...(segments || [])].sort((a, b) => a.start - b.start || a.end - b.end);
  const ids = new Set();
  for (let i = 0; i < sorted.length; i += 1) {
    const current = sorted[i];
    for (let j = i + 1; j < sorted.length; j += 1) {
      const next = sorted[j];
      if (next.start >= current.end) break; // sorted by start: no later one can overlap either
      if (!shouldFlagOverlap(current, next)) continue;
      ids.add(current.id);
      ids.add(next.id);
    }
  }
  return ids;
};
