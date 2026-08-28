import { splitSegmentForParallelProcessing } from './parallelProcessingUtils';

// This is the pure, credential-free half of Gemini request-window splitting: the ONE calculation
// that decides how many parallel provider requests a customer's selected range becomes. It has no
// dependency on a Gemini credential, a native command, or even a real media file, so it is proven
// directly here rather than only through a real-binary journey that can observe it merely as a side
// effect of provider success. e2e/journeys/providerBoundaries.journey.js proves the customer-visible
// wiring around this same function (the #max-duration-slider control and its live ".parallel-info"
// preview) but cannot force N>1 with the ~19-second pinned real-media fixture every ordinary journey
// opens; the 204s/60s case below is the exact shape e2e/support/fourWindowAsrFixture.js's real
// four-window local-ASR fixture already relies on, cross-referenced so both proofs agree on the math.
describe('splitSegmentForParallelProcessing', () => {
  test('does not split a segment that already fits within the request cap', () => {
    const result = splitSegmentForParallelProcessing({ start: 0, end: 19 }, 60);
    expect(result).toEqual([{ start: 0, end: 19, index: 0, isParallel: false }]);
  });

  test('splits an exactly-204-second segment into 4 windows at a 60-second cap, matching the real four-window ASR fixture', () => {
    const result = splitSegmentForParallelProcessing({ start: 0, end: 204 }, 60);
    expect(result).toHaveLength(4);
    expect(result.every((segment) => segment.isParallel)).toBe(true);
    expect(result.every((segment) => segment.totalSegments === 4)).toBe(true);
    // Evenly distributed, not merely capped: each window is 204/4 = 51 seconds.
    for (const [index, segment] of result.entries()) {
      expect(segment.index).toBe(index);
      expect(segment.end - segment.start).toBeCloseTo(51, 5);
    }
    expect(result[0].start).toBe(0);
    expect(result.at(-1).end).toBe(204);
  });

  test('the last window always ends exactly at the segment end, even with a non-integer split', () => {
    const result = splitSegmentForParallelProcessing({ start: 10, end: 130 }, 40);
    // 120s total / 40s cap => 3 windows of 40s each, offset by the segment's own start.
    expect(result).toHaveLength(3);
    expect(result[0].start).toBe(10);
    expect(result.at(-1).end).toBe(130);
    for (let index = 1; index < result.length; index += 1) {
      expect(result[index].start).toBeCloseTo(result[index - 1].end, 10);
    }
  });

  test('splits by ceiling the request count, never leaving a request over the cap', () => {
    // 205s at a 60s cap needs 4 requests (ceil(205/60) = 4), not 3 with one oversized tail request.
    const result = splitSegmentForParallelProcessing({ start: 0, end: 205 }, 60);
    expect(result).toHaveLength(4);
    for (const segment of result) {
      expect(segment.end - segment.start).toBeLessThanOrEqual(60 + 1e-9);
    }
  });

  test('rejects a missing segment or a zero/undefined request cap', () => {
    expect(() => splitSegmentForParallelProcessing(null, 60)).toThrow(/Invalid input/);
    expect(() => splitSegmentForParallelProcessing({ start: 0, end: 10 }, 0)).toThrow(/Invalid input/);
    expect(() => splitSegmentForParallelProcessing({ start: 0, end: 10 }, undefined)).toThrow(/Invalid input/);
  });
});
