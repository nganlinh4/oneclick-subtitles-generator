import {
  formatClock,
  formatSecondsFraction,
  formatTime,
  formatTimecode,
  formatTimecodeMilliseconds,
  toWholeMilliseconds,
} from './timeFormatter';

describe('formatTime', () => {
  test.each([
    [2.3, 'hms_ms', '0:02.30'],
    [1.13, 'hms_ms', '0:01.13'],
    [0.29, 'hms_ms', '0:00.29'],
    [59.9995, 'hms_ms', '1:00.00'],
    [3675.5, 'hms_ms', '1:01:15.50'],
    [2.299, 'hms_ms', '0:02.29'],
    [1.13, 's_ms', '1.13'],
    [0.29, 's_ms', '0.29'],
    [75.07, 's_ms', '75.07'],
    [59.9995, 's_ms', '60.00'],
    [5, 'hms', '0:05'],
    [75, 'hms', '1:15'],
    [330, 'hms', '5:30'],
    [59.9995, 'hms', '1:00'],
    [3600, 'hms', '1:00:00'],
    [3675, 'hms', '1:01:15'],
    [2, 'seconds', '2s'],
    [1.5, 'seconds', '1.50s'],
    [0.29, 'seconds', '0.29s'],
  ])('formatTime(%s, %s) is %s', (seconds, format, expected) => {
    expect(formatTime(seconds, format)).toBe(expected);
  });

  test('null/undefined render as an empty string', () => {
    expect(formatTime(null, 'hms')).toBe('');
    expect(formatTime(undefined)).toBe('');
  });
});

describe('formatTimecode', () => {
  test.each([
    [3661.5, '.', '01:01:01.500'],
    [3661.5, ',', '01:01:01,500'],
    [0, '.', '00:00:00.000'],
    [5.07, '.', '00:00:05.070'],
    [0.29, ',', '00:00:00,290'],
    [1.13, ',', '00:00:01,130'],
    [2.3, ',', '00:00:02,300'],
    [59.9995, ',', '00:01:00,000'],
    [3_661.007, ',', '01:01:01,007'],
    [360_000, '.', '100:00:00.000'],
  ])('formatTimecode(%s, %j) is %s', (seconds, separator, expected) => {
    expect(formatTimecode(seconds, separator)).toBe(expected);
  });

  test('returns the zero timecode for null/undefined, honouring the separator', () => {
    expect(formatTimecode(null)).toBe('00:00:00.000');
    expect(formatTimecode(undefined, ',')).toBe('00:00:00,000');
  });

  test('formats integer milliseconds without float math', () => {
    expect(formatTimecodeMilliseconds(3_661_007)).toBe('01:01:01,007');
  });
});

describe('formatClock options', () => {
  test.each([
    [65.29, { fractionDigits: 3, hours: 'never', minuteDigits: 2 }, '01:05.290'],
    [3725.1, { fractionDigits: 3, hours: 'never', minuteDigits: 2 }, '62:05.100'],
    [3725.9, { hours: 'never' }, '62:05'],
    [59.9995, { hours: 'never' }, '1:00'],
  ])('formatClock(%s, %j) is %s', (seconds, options, expected) => {
    expect(formatClock(seconds, options)).toBe(expected);
  });

  test('negative and non-finite input renders as zero', () => {
    expect(formatClock(-3, { hours: 'never' })).toBe('0:00');
    expect(formatClock(Number.NaN, { hours: 'never' })).toBe('0:00');
    expect(toWholeMilliseconds(undefined)).toBe(0);
  });

  test('one-digit fractions truncate after millisecond rounding', () => {
    expect(formatSecondsFraction(2.3, 1)).toBe('2.3');
    expect(formatSecondsFraction(0.29, 1)).toBe('0.2');
    expect(formatSecondsFraction(1.99996, 1)).toBe('2.0');
  });
});
