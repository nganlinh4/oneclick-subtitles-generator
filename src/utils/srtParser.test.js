import { parseSrtContent, secondsToSrtTime } from './srtParser';

it('parses BOM, CRLF, multiline text, optional indexes, and fractional variants exactly', () => {
  expect(parseSrtContent(
    '\uFEFF8\r\n00:00:01,5 --> 00:00:02.250 position:10%\r\nFirst line\r\nSecond line\r\n\r\n'
    + '00:01:03,04 --> 00:01:04,005\r\nDone\r\n'
  )).toEqual([
    {
      id: 8,
      start: 1.5,
      end: 2.25,
      text: 'First line\nSecond line',
      startTime: '00:00:01,500',
      endTime: '00:00:02,250',
    },
    {
      id: 2,
      start: 63.04,
      end: 64.005,
      text: 'Done',
      startTime: '00:01:03,040',
      endTime: '00:01:04,005',
    },
  ]);
});

it.each([
  ['one malformed cue', '1\n00:00:00,000 --> 00:00:01,000\nGood\n\n2\nnot timing\nBad'],
  ['duplicate sequence IDs', '1\n00:00:00,000 --> 00:00:01,000\nA\n\n1\n00:00:01,000 --> 00:00:02,000\nB'],
  ['invalid minute', '1\n00:60:00,000 --> 01:00:01,000\nBad'],
  ['invalid second', '1\n00:00:60,000 --> 00:01:01,000\nBad'],
  ['backwards range', '1\n00:00:02,000 --> 00:00:01,000\nBad'],
  ['zero duration', '1\n00:00:01,000 --> 00:00:01,000\nBad'],
  ['unsafe duration', `1\n${'9'.repeat(30)}:00:00,000 --> ${'9'.repeat(30)}:00:01,000\nBad`],
])('rejects the whole document for %s', (_case, input) => {
  expect(parseSrtContent(input)).toEqual([]);
});

it('keeps the existing seconds formatter contract', () => {
  expect(secondsToSrtTime(3_661.007)).toBe('01:01:01,007');
});
