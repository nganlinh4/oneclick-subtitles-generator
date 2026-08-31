const DEFAULT_INTERVAL_MS = 100;
const DEFAULT_MAX_ATTEMPTS = 300;

/**
 * Publish native capability state only after the nested PromptDJ application is alive.
 * The outer srcDoc load event fires before /promptdj has installed its message listener.
 */
export const startPromptDjReadinessBridge = ({
  isReady,
  publish,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (handle) => clearTimeout(handle),
}) => {
  if (typeof isReady !== 'function' || typeof publish !== 'function'
      || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1
      || !Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new TypeError('PromptDJ readiness bridge configuration is invalid');
  }
  let cancelled = false;
  let handle = null;
  let attempts = 0;
  const probe = () => {
    if (cancelled) return;
    attempts += 1;
    let ready = false;
    try { ready = isReady() === true; } catch { ready = false; }
    if (ready) {
      Promise.resolve().then(publish).catch(() => undefined);
      return;
    }
    if (attempts < maxAttempts) handle = schedule(probe, intervalMs);
  };
  probe();
  return () => {
    cancelled = true;
    if (handle !== null) cancelSchedule(handle);
  };
};
