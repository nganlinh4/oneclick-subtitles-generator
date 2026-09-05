import { projectClipSubtitles } from './segmentTimestamps';

it('never moves earlier cues when a growing stream crosses the clip-duration threshold', () => {
  const range = { start: 30, end: 90 };
  const earlier = { start: 2, end: 4, text: 'First words' };
  const before = projectClipSubtitles([earlier], range);
  const after = projectClipSubtitles([earlier, { start: 59, end: 65, text: 'Tail' }], range);
  expect(before).toEqual([{ start: 32, end: 34, text: 'First words' }]);
  expect(after[0]).toEqual(before[0]);
  expect(after[1]).toEqual({ start: 89, end: 90, text: 'Tail' });
});

it('projects hour-long source windows without guessing, coercing, or retaining invalid cues', () => {
  expect(projectClipSubtitles([
    { start: 0, end: 2, text: 'zero' },
    { start: 50, end: 55, text: 'late' },
    { start: 70, end: 80, text: 'outside' },
    { start: NaN, end: 4 }, { start: '2', end: 3 }, { start: 2, end: 1 },
  ], { start: 3600, end: 3660 })).toEqual([
    { start: 3600, end: 3602, text: 'zero' },
    { start: 3650, end: 3655, text: 'late' },
  ]);
});
