import { plannedTranscriptionWindowCount } from './transcriptionWindowPlan';

// The same ranges as the tests in apps/desktop/src-tauri/src/transcription/planner.rs.
test.each([
  ['single window under target', 0, 45_000, 60_000, false, 1],
  ['exact multiples', 10_000, 130_000, 60_000, false, 2],
  ['balanced non-multiple', 0, 63_000, 60_000, false, 2],
  ['balanced non-multiple, three windows', 0, 123_000, 60_000, false, 3],
  ['rounding distributed', 0, 66_000, 60_000, false, 2],
  ['preference clamped up to 30 s', 0, 60_000, 20_000, false, 2],
  ['ten-minute preference kept', 0, 1_200_000, 600_000, false, 2],
  ['live prefix context', 0, 120_000, 60_000, true, 3],
  ['ten hours grows to the 120-window cap', 0, 36_000_000, 30_000, false, 120],
  ['ten hours live stays within the cap', 0, 36_000_000, 30_000, true, 120],
  ['a day hits the ten-minute ceiling', 0, 86_400_000, 60_000, false, 144],
  ['short media keeps the requested length', 0, 3_600_000, 60_000, false, 60],
  ['short live media', 0, 240_000, 60_000, true, 5],
  ['no preference uses ten minutes', 0, 1_200_001, null, false, 3],
])('%s', (_label, rangeStartMs, rangeEndMs, preferredWindowMs, live, expected) => {
  expect(plannedTranscriptionWindowCount({ rangeStartMs, rangeEndMs, preferredWindowMs, live }))
    .toBe(expected);
});

test('an empty or invalid range plans one window', () => {
  expect(plannedTranscriptionWindowCount({ rangeStartMs: 100, rangeEndMs: 100 })).toBe(1);
  expect(plannedTranscriptionWindowCount({ rangeStartMs: 100, rangeEndMs: 50 })).toBe(1);
  expect(plannedTranscriptionWindowCount({ rangeStartMs: -1, rangeEndMs: 50 })).toBe(1);
});
