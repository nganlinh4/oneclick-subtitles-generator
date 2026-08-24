import {
  clampSeekTime,
  createTimelineDomain,
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

it('separates seekable media, editable cue content and the visual gutter', () => {
  const domain = createTimelineDomain(measuredBoundaryCue, 214.274);

  expect(domain).toEqual({
    start: 0,
    seekableEnd: 214.274,
    cueStart: 214.080,
    cueEnd: 216.159,
    contentEnd: 216.159,
    viewEnd: 216.159 * 1.05,
  });
  expect(getVisibleTimeRange(measuredBoundaryCue, 214.274, 0, 1)).toMatchObject({
    start: 0,
    end: domain.viewEnd,
    total: domain.viewEnd,
  });
});

it('selects all cues beyond media bounds without making them seekable', () => {
  const domain = createTimelineDomain(measuredBoundaryCue, 214.274);

  expect(getSelectAllRange(measuredBoundaryCue, 214.274)).toEqual({
    start: 0,
    end: 216.159,
  });
  expect(clampSeekTime(216.159, domain)).toBe(214.274);
});

it('maps pointer input through the visible timeline so out-of-media cues stay reachable', () => {
  const domain = createTimelineDomain(measuredBoundaryCue, 214.274);
  const rect = { left: 100, width: 1_000 };
  const visible = { start: 200, end: domain.viewEnd };
  const cueEndX = rect.left
    + (((domain.cueEnd - visible.start) / (visible.end - visible.start)) * rect.width);

  expect(pixelToTimelineTime(cueEndX, rect, visible, domain)).toBeCloseTo(216.159, 10);
  expect(pixelToTimelineTime(rect.left + rect.width, rect, visible, domain)).toBe(domain.viewEnd);
});

it('uses an explicit empty view without inventing playable media duration', () => {
  const domain = createTimelineDomain([], Number.NaN);
  expect(domain).toMatchObject({
    seekableEnd: 0,
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

  handleTimelineClick(
    { clientX: 1_050 },
    canvas,
    214.274,
    onTimelineClick,
    { start: 0, end: 216.159 * 1.05 },
    lastManualPanTime,
  );

  expect(onTimelineClick).toHaveBeenCalledWith(214.274);
  expect(lastManualPanTime.current).toBeGreaterThan(0);
});

