import {
  clampSeekTime,
  clampTimelineMoveDelta,
  clampTimelineRange,
  createTimelineDomain,
  cueOverlapsTimelineRange,
  cueWithinTimelineRange,
  getSelectAllRange,
  pixelToTimelineTime,
} from './timelineDomain';
import { getVisibleTimeRange } from './TimelineCalculations';
import { handleTimelineClick } from './TimelineInteractions';

const measuredBoundaryCue = [{
  id: 'last',
  start: 214.080,
  end: 216.159,
  text: 'last cue',
}];

it('separates seekable/selectable media from repairable cue content without phantom ruler time', () => {
  const domain = createTimelineDomain(measuredBoundaryCue, 214.274);

  expect(domain).toEqual({
    start: 0,
    seekableEnd: 214.274,
    selectableEnd: 214.274,
    cueStart: 214.080,
    cueEnd: 216.159,
    contentEnd: 216.159,
    viewEnd: 216.159,
  });
  expect(getVisibleTimeRange(measuredBoundaryCue, 214.274, 0, 1)).toMatchObject({
    start: 0,
    end: domain.viewEnd,
    total: domain.viewEnd,
  });
});

it('hard-bounds select-all and pointer input to playable media', () => {
  const domain = createTimelineDomain(measuredBoundaryCue, 214.274);

  expect(getSelectAllRange(measuredBoundaryCue, 214.274)).toEqual({
    start: 0,
    end: 214.274,
  });
  expect(clampSeekTime(216.159, domain)).toBe(214.274);
  const rect = { left: 100, width: 1_000 };
  const visible = { start: 200, end: domain.viewEnd };
  const cueEndX = rect.left
    + (((domain.cueEnd - visible.start) / (visible.end - visible.start)) * rect.width);

  expect(pixelToTimelineTime(cueEndX, rect, visible, domain)).toBe(domain.selectableEnd);
  expect(pixelToTimelineTime(rect.left + rect.width, rect, visible, domain))
    .toBe(domain.selectableEnd);
  expect(clampTimelineRange({ start: 100, end: 999_999 }, domain)).toEqual({
    start: 100,
    end: 214.274,
  });
  expect(clampTimelineMoveDelta({ start: 200, end: 210 }, 99, domain))
    .toBeCloseTo(4.274);
  expect(clampTimelineMoveDelta({ start: 2, end: 12 }, -99, domain)).toBe(-2);
  expect(cueOverlapsTimelineRange(measuredBoundaryCue[0], 0, domain.selectableEnd)).toBe(true);
  expect(cueOverlapsTimelineRange(measuredBoundaryCue[0], 0, 214)).toBe(false);
});

// cueWithinTimelineRange backs a range MOVE's cue selection (useLyricsEditorHelpers.js):
// translating a cue's whole span by one delta is only correct when the cue sits entirely inside
// the selection. cueOverlapsTimelineRange -- used for clear/split/regenerate -- deliberately
// disagrees on a cue that only partly overlaps, which is exactly the point of having both.
it('requires a cue to sit entirely inside the range, unlike the looser overlap check', () => {
  const contained = { start: 3, end: 4 };
  const widerThanSelection = { start: 0, end: 20 };
  const overlapsOnlyAtStart = { start: 1, end: 3.5 };
  const overlapsOnlyAtEnd = { start: 3.5, end: 20 };

  expect(cueWithinTimelineRange(contained, 2.7, 6.3)).toBe(true);
  expect(cueWithinTimelineRange(widerThanSelection, 2.7, 6.3)).toBe(false);
  expect(cueWithinTimelineRange(overlapsOnlyAtStart, 2.7, 6.3)).toBe(false);
  expect(cueWithinTimelineRange(overlapsOnlyAtEnd, 2.7, 6.3)).toBe(false);

  // All four still register as an overlap -- the two checks answer different questions.
  expect(cueOverlapsTimelineRange(widerThanSelection, 2.7, 6.3)).toBe(true);
  expect(cueOverlapsTimelineRange(overlapsOnlyAtStart, 2.7, 6.3)).toBe(true);
  expect(cueOverlapsTimelineRange(overlapsOnlyAtEnd, 2.7, 6.3)).toBe(true);
});

it('uses an explicit empty view without inventing playable media duration', () => {
  const domain = createTimelineDomain([], Number.NaN);
  expect(domain).toMatchObject({
    seekableEnd: 0,
    selectableEnd: 0,
    cueEnd: 0,
    contentEnd: 0,
    viewEnd: 1,
  });
  expect(getSelectAllRange([], 0)).toEqual({ start: 0, end: 0 });
});

it('clamps seeking separately when the pointer lands on subtitle-only time', () => {
  const onTimelineClick = vi.fn();
  const lastManualPanTime = { current: 0 };
  const canvas = {
    getBoundingClientRect: () => ({ left: 100, width: 1_000 }),
  };
  const visible = { start: 0, end: 216.159 };
  const subtitleOnlyX = canvas.getBoundingClientRect().left
    + ((215 / visible.end) * canvas.getBoundingClientRect().width);

  handleTimelineClick(
    { clientX: subtitleOnlyX },
    canvas,
    214.274,
    onTimelineClick,
    visible,
    lastManualPanTime,
  );

  expect(onTimelineClick).toHaveBeenCalledWith(214.274);
  expect(lastManualPanTime.current).toBeGreaterThan(0);
});
