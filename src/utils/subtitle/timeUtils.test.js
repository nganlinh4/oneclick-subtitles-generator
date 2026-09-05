import { convertTimeStringToSeconds as parse } from './timeUtils';

it.each([
  ['01:02:03.450', 3723.45], ['01:02:03', 3723], ['00:03.5', 3.5],
  ['00:03.05', 3.05], ['00:03.005', 3.005], ['00:03,5', 3.5],
  ['90:03.25', 5403.25], ['90m03s250ms', 5403.25], ['00m03s5ms', 3.005],
  ['00m00s000ms', 0], ['2m03s', 123],
  ['00:03s060ms', 3.06], ['01:00s000ms', 60], ['90:03s250ms', 5403.25],
])('parses %s without guessing time units', (text, expected) => {
  expect(parse(text)).toBeCloseTo(expected, 8);
});

it.each(['', 'nonsense 1 2 3', 'at 01:02:03', '-01:02', '00:60', '01:60:00',
  '00m60s000ms', '00m03s1000ms', '00:60s000ms', '01:02:03s450ms', '01:02 trailing', null, 0])(
  'refuses ambiguous or malformed timestamp %s instead of returning zero', text => {
    expect(() => parse(text)).toThrow();
  }
);
