// How many windows the native transcription planner splits a range into. This mirrors
// apps/desktop/src-tauri/src/transcription/planner.rs (`plan_windows` / `plan_live_windows`)
// exactly; keep the constants and arithmetic in step with that file.

const MIN_WINDOW_DURATION_MS = 30_000;
const MAX_WINDOW_DURATION_MS = 600_000;
const DEFAULT_WINDOW_DURATION_MS = 600_000;
const LIVE_PREFIX_CONTEXT_MS = 3_000;
const MAX_PLANNED_WINDOWS = 120;

const ceilDiv = (numerator, denominator) => Math.floor((numerator + denominator - 1) / denominator);

/**
 * @param {{ rangeStartMs: number, rangeEndMs: number, preferredWindowMs?: number|null,
 *   live?: boolean }} plan the range in integer milliseconds and the requested window length
 * @returns {number} the planned window count; 1 for an empty or invalid range
 */
export const plannedTranscriptionWindowCount = ({
  rangeStartMs,
  rangeEndMs,
  preferredWindowMs = null,
  live = false,
}) => {
  const total = rangeEndMs - rangeStartMs;
  if (!Number.isFinite(total) || rangeStartMs < 0 || total <= 0) return 1;
  const reservedContextMs = live ? LIVE_PREFIX_CONTEXT_MS : 0;
  const preferred = Number.isFinite(preferredWindowMs) ? preferredWindowMs : DEFAULT_WINDOW_DURATION_MS;
  const requested = Math.min(Math.max(preferred, MIN_WINDOW_DURATION_MS), MAX_WINDOW_DURATION_MS);
  const ownedForCap = ceilDiv(total, MAX_PLANNED_WINDOWS);
  const windowMs = Math.min(
    Math.max(requested, ownedForCap + reservedContextMs),
    MAX_WINDOW_DURATION_MS,
  );
  return ceilDiv(total, windowMs - reservedContextMs);
};
