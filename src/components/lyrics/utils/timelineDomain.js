const EMPTY_VIEW_SECONDS = 1;
const END_GUTTER_RATIO = 0.05;

const finiteNonNegative = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : 0
);

const finiteCueTimes = (lyrics) => {
  if (!Array.isArray(lyrics)) return [];
  return lyrics.flatMap((lyric) => {
    const start = finiteNonNegative(lyric?.start);
    const end = finiteNonNegative(lyric?.end);
    return end >= start ? [{ start, end }] : [];
  });
};

/**
 * One time-domain description shared by drawing, zooming, selection and seeking.
 *
 * `seekableEnd` is media playback truth. Once media exists it is also the hard selection bound:
 * dragging into the visual gutter or across a malformed cue may never create a range the video
 * cannot play. In subtitle-only mode the cue end is the only available bound. `contentEnd` still
 * keeps an out-of-bounds cue visible so it can be repaired, and `viewEnd` adds a non-content gutter
 * for legibility; neither is selectable or seekable.
 */
export const createTimelineDomain = (lyrics, mediaDuration) => {
  const cues = finiteCueTimes(lyrics);
  const seekableEnd = finiteNonNegative(mediaDuration);
  const cueStart = cues.length > 0
    ? Math.min(...cues.map((cue) => cue.start))
    : null;
  const cueEnd = cues.length > 0
    ? Math.max(...cues.map((cue) => cue.end))
    : 0;
  const selectableEnd = seekableEnd > 0 ? seekableEnd : cueEnd;
  const contentEnd = Math.max(seekableEnd, cueEnd);
  const viewEnd = contentEnd > 0
    ? contentEnd * (1 + END_GUTTER_RATIO)
    : EMPTY_VIEW_SECONDS;

  return Object.freeze({
    start: 0,
    seekableEnd,
    selectableEnd,
    cueStart,
    cueEnd,
    contentEnd,
    viewEnd,
  });
};

/** A range that contains every cue. With no cues, it represents the media. */
export const getSelectAllRange = (lyrics, mediaDuration) => {
  const domain = createTimelineDomain(lyrics, mediaDuration);
  return Object.freeze({
    start: 0,
    end: domain.selectableEnd,
  });
};

export const clampTimelineTime = (time, domain) => {
  const value = finiteNonNegative(time);
  return Math.min(domain.selectableEnd, value);
};

export const clampSeekTime = (time, domain) => {
  const value = finiteNonNegative(time);
  return Math.min(domain.seekableEnd, value);
};

export const clampTimelineRange = (range, domain) => {
  if (range === null || typeof range !== 'object') return null;
  const start = clampTimelineTime(range.start, domain);
  const end = clampTimelineTime(range.end, domain);
  if (!(end > start)) return null;
  return Object.freeze({ start, end });
};

export const clampTimelineMoveDelta = (range, requestedDelta, domain) => {
  const boundedRange = clampTimelineRange(range, domain);
  if (!boundedRange) return 0;
  const delta = Number.isFinite(Number(requestedDelta)) ? Number(requestedDelta) : 0;
  return Math.max(
    -boundedRange.start,
    Math.min(domain.selectableEnd - boundedRange.end, delta),
  );
};

/** A time selection owns every cue it visibly intersects, including a cue crossing media end. */
export const cueOverlapsTimelineRange = (cue, start, end) => (
  Number.isFinite(cue?.start)
  && Number.isFinite(cue?.end)
  && Number.isFinite(start)
  && Number.isFinite(end)
  && cue.start < end
  && cue.end > start
);

export const pixelToTimelineTime = (pixelX, rect, visibleTimeRange, domain) => {
  if (!(rect?.width > 0)) return domain.start;
  const relativeX = pixelX - rect.left;
  const visibleDuration = visibleTimeRange.end - visibleTimeRange.start;
  if (!(visibleDuration > 0)) return domain.start;
  return clampTimelineTime(
    visibleTimeRange.start + ((relativeX / rect.width) * visibleDuration),
    domain,
  );
};
