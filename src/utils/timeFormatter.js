/**
 * The one time-format module. Every formatter rounds to whole milliseconds first and only then
 * splits into units, so float noise (1.13 * 100 = 112.99...) never drops a displayed digit.
 */

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_SECOND = 1_000;

const pad = (value, length = 2) => String(value).padStart(length, '0');

/** Seconds to whole milliseconds; negative and non-finite input clamps to zero. */
export const toWholeMilliseconds = (seconds) => {
  const milliseconds = Math.round(Number(seconds) * MS_PER_SECOND);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0;
};

const splitMilliseconds = (totalMilliseconds) => ({
  hours: Math.floor(totalMilliseconds / MS_PER_HOUR),
  minutes: Math.floor((totalMilliseconds % MS_PER_HOUR) / MS_PER_MINUTE),
  seconds: Math.floor((totalMilliseconds % MS_PER_MINUTE) / MS_PER_SECOND),
  milliseconds: totalMilliseconds % MS_PER_SECOND,
});

// Truncates the millisecond remainder to `digits` places (2 -> hundredths).
const fraction = (milliseconds, digits) => (
  digits > 0 ? `.${pad(Math.floor(milliseconds / 10 ** (3 - digits)), digits)}` : ''
);

/** Zero-padded `HH:MM:SS<sep>mmm` from an integer millisecond count. */
export const formatTimecodeMilliseconds = (totalMilliseconds, separator = ',') => {
  const { hours, minutes, seconds, milliseconds } = splitMilliseconds(totalMilliseconds);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(milliseconds, 3)}`;
};

/** Zero-padded `HH:MM:SS<sep>mmm` ('.' for WebVTT, ',' for SRT); null renders as zero. */
export const formatTimecode = (seconds, separator = '.') => (
  formatTimecodeMilliseconds(seconds == null ? 0 : toWholeMilliseconds(seconds), separator)
);

/**
 * Clock text. `hours: 'auto'` gives `H:MM:SS` from one hour up and `M:SS` below it;
 * `hours: 'never'` folds hours into the minute count. `minuteDigits` pads the minute field
 * when no hour field is shown.
 */
export const formatClock = (seconds, { fractionDigits = 0, hours = 'auto', minuteDigits = 1 } = {}) => {
  const parts = splitMilliseconds(toWholeMilliseconds(seconds));
  const showHours = hours === 'auto' && parts.hours > 0;
  const head = showHours
    ? `${parts.hours}:${pad(parts.minutes)}`
    : pad(parts.hours * 60 + parts.minutes, minuteDigits);
  return `${head}:${pad(parts.seconds)}${fraction(parts.milliseconds, fractionDigits)}`;
};

/** Whole seconds plus a truncated fraction, e.g. `75.13` (2 digits) or `2.3` (1 digit). */
export const formatSecondsFraction = (seconds, fractionDigits = 2) => {
  const totalMilliseconds = toWholeMilliseconds(seconds);
  return `${Math.floor(totalMilliseconds / MS_PER_SECOND)}`
    + fraction(totalMilliseconds % MS_PER_SECOND, fractionDigits);
};

/**
 * Format seconds for display.
 * @param {number} timeInSeconds
 * @param {'seconds'|'hms'|'hms_ms'|'s_ms'} format
 *   'seconds' -> `1.50s` (`2s` for whole seconds), 'hms' -> `M:SS` / `H:MM:SS`,
 *   'hms_ms' -> `M:SS.hh` / `H:MM:SS.hh`, 's_ms' -> `S.hh`.
 */
export const formatTime = (timeInSeconds, format = 'seconds') => {
  if (timeInSeconds === undefined || timeInSeconds === null) {
    return '';
  }
  if (format === 'hms') return formatClock(timeInSeconds);
  if (format === 'hms_ms') return formatClock(timeInSeconds, { fractionDigits: 2 });
  if (format === 's_ms') return formatSecondsFraction(timeInSeconds, 2);
  return `${timeInSeconds.toFixed(2).replace(/\.00$/, '')}s`;
};
