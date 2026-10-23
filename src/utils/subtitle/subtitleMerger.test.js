import { mergeSegmentSubtitles } from './subtitleMerger';

const freezeTrack = (rows) => Object.freeze(
  rows.map((row) => Object.freeze({ ...row }))
);

const intervals = (rows) => rows.map(({ id, start, end }) => ({ id, start, end }));

describe('subtitle segment merging', () => {
  test('replaces a complete segment while retaining and clamping every boundary straddler', () => {
    const existing = freezeTrack([
      { id: 'before', start: 0, end: 4, text: 'before' },
      { id: 'whole', start: 2, end: 25, text: 'spans both boundaries' },
      { id: 'starts-before', start: 6, end: 12, text: 'crosses the start' },
      { id: 'exact-before', start: 8, end: 10, text: 'touches the start' },
      { id: 'inside', start: 11, end: 13, text: 'replaced' },
      { id: 'ends-after', start: 18, end: 24, text: 'crosses the end' },
      { id: 'exact-after', start: 20, end: 21, text: 'touches the end' },
      { id: 'after', start: 22, end: 26, text: 'after' },
    ]);
    const replacement = freezeTrack([
      { id: 'new-a', start: 10, end: 15, text: 'replacement A' },
      { id: 'new-b', start: 15, end: 20, text: 'replacement B' },
    ]);
    const existingSnapshot = JSON.stringify(existing);
    const replacementSnapshot = JSON.stringify(replacement);

    const merged = mergeSegmentSubtitles(existing, replacement, { start: 10, end: 20 });

    expect(intervals(merged)).toEqual([
      { id: 'before', start: 0, end: 4 },
      { id: 'whole', start: 2, end: 10 },
      { id: 'starts-before', start: 6, end: 10 },
      { id: 'exact-before', start: 8, end: 10 },
      { id: 'new-a', start: 10, end: 15 },
      { id: 'new-b', start: 15, end: 20 },
      { id: 'whole', start: 20, end: 25 },
      { id: 'ends-after', start: 20, end: 24 },
      { id: 'exact-after', start: 20, end: 21 },
      { id: 'after', start: 22, end: 26 },
    ]);
    expect(JSON.stringify(existing)).toBe(existingSnapshot);
    expect(JSON.stringify(replacement)).toBe(replacementSnapshot);
    expect(merged).not.toBe(existing);
    expect(merged).not.toBe(replacement);
    expect(merged[0]).toBe(existing[0]);
    expect(merged.find((row) => row.id === 'new-a')).toBe(replacement[0]);
  });

  test('an empty authoritative result clears only its requested half-open range', () => {
    const existing = freezeTrack([
      { id: 'before', start: 0, end: 2, text: 'before' },
      { id: 'crosses', start: 4, end: 12, text: 'crosses both boundaries' },
      { id: 'inside', start: 6, end: 8, text: 'stale speech' },
      { id: 'after', start: 12, end: 14, text: 'after' },
    ]);

    expect(intervals(mergeSegmentSubtitles(existing, [], { start: 5, end: 10 }))).toEqual([
      { id: 'before', start: 0, end: 2 },
      { id: 'crosses', start: 4, end: 5 },
      { id: 'crosses', start: 10, end: 12 },
      { id: 'after', start: 12, end: 14 },
    ]);
  });

  test('does not write whole-track diagnostics during large multi-segment merges', () => {
    const consoleSpies = ['log', 'debug', 'info', 'warn', 'error']
      .map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    let track = Array.from({ length: 4_000 }, (_, index) => ({
      id: `old-${index}`,
      start: index * 0.5,
      end: (index * 0.5) + 0.45,
      text: `Existing subtitle ${index}`,
    }));

    try {
      for (let segmentIndex = 0; segmentIndex < 80; segmentIndex += 1) {
        const start = segmentIndex * 20;
        const end = start + 20;
        track = mergeSegmentSubtitles(
          track,
          [{ id: `new-${segmentIndex}`, start, end, text: 'replacement' }],
          { start, end }
        );
      }

      consoleSpies.forEach((spy) => expect(spy).not.toHaveBeenCalled());
    } finally {
      consoleSpies.forEach((spy) => spy.mockRestore());
    }
  });
});
