import { boundedTrimRange, durableTrimRange } from './TrimTimelineRow';

describe('render trim source bounds', () => {
  it('never lets a restored or stale range exceed the current video', () => {
    expect(boundedTrimRange({ trimStart: 120, trimEnd: 500 }, 191.034))
      .toEqual([120, 191.034]);
    expect(boundedTrimRange({ trimStart: 250, trimEnd: 500 }, 191.034))
      .toEqual([191.034, 191.034]);
  });

  it('displays durable zero as source end without persisting browser duration', () => {
    expect(boundedTrimRange({ trimStart: 0, trimEnd: 0 }, 191.034)).toEqual([0, 191.034]);
    expect(durableTrimRange([0, 191.034], 191.034)).toEqual({ trimStart: 0, trimEnd: 0 });
    expect(durableTrimRange([2, 190], 191.034)).toEqual({ trimStart: 2, trimEnd: 190 });
  });

  it('has no invented range before metadata is known', () => {
    expect(boundedTrimRange({ trimStart: 20, trimEnd: 40 }, 0)).toEqual([0, 0]);
  });
});
