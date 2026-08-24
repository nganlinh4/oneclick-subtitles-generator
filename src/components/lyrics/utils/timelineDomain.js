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
 * `seekableEnd` is media playback truth. `contentEnd` also includes subtitles
 * outside the media bounds so they remain visible and editable. `viewEnd` adds
 * a non-content gutter for legibility; callers must never treat that gutter as
 * media or waveform duration.
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
  const contentEnd = Math.max(seekableEnd, cueEnd);
  const viewEnd = contentEnd > 0
    ? contentEnd * (1 + END_GUTTER_RATIO)
    : EMPTY_VIEW_SECONDS;

  return Object.freeze({
    start: 0,
    seekableEnd,
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
    end: domain.cueEnd > 0 ? domain.cueEnd : domain.seekableEnd,
  });
};

export const clampTimelineTime = (time, domain) => {
  const value = finiteNonNegative(time);
  return Math.min(domain.viewEnd, value);
};

export const clampSeekTime = (time, domain) => {
  const value = finiteNonNegative(time);
  return Math.min(domain.seekableEnd, value);
};

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

