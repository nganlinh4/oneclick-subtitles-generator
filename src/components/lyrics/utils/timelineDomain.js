const EMPTY_VIEW_SECONDS = 1;

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
 * dragging across an out-of-bounds or malformed cue may never create a range the video
 * cannot play. In subtitle-only mode the cue end is the only available bound. `contentEnd` still
 * keeps an out-of-bounds cue visible so it can be repaired. `viewEnd` ends at actual content: a
 * media-backed ruler must not advertise phantom time after the video, while subtitle-only content
 * and genuinely out-of-bounds cues remain visible for repair.
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
  const viewEnd = contentEnd > 0 ? contentEnd : EMPTY_VIEW_SECONDS;

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

/**
 * A range MOVE may only translate a cue whose whole span sits inside the selected range.
 * `cueOverlapsTimelineRange` is right for clear/split/regenerate, where touching the selection at
 * all makes a cue a legitimate candidate for the operation. A move is different: it drags a cue's
 * entire timing by one delta, so a cue that only partly overlaps the selection -- or, in the limit,
 * spans past both edges of it -- would have timing the user never selected dragged along with it.
 */
export const cueWithinTimelineRange = (cue, start, end) => (
  Number.isFinite(cue?.start)
  && Number.isFinite(cue?.end)
  && Number.isFinite(start)
  && Number.isFinite(end)
  && cue.start >= start
  && cue.end <= end
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
