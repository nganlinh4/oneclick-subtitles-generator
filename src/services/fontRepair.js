/**
 * Asking native to install the managed subtitle font again.
 *
 * A readiness record that says `retryable` and offers no way to retry is a worse interface than one
 * that says nothing at all, so this ships with the flag rather than after it. The command takes no
 * arguments on purpose: where to install from is resolved by native at startup and never travels
 * across this boundary.
 *
 * The result of the attempt does NOT come back from this call. Native publishes it through the same
 * readiness record every other outcome uses, so a caller subscribes with `subscribeToFontReadiness`
 * and reacts to the record. Returning a second, competing answer here is how two sources of truth
 * start disagreeing.
 */

import { invokeDesktop, isDesktopRuntime } from '../platform/desktopRuntime';

export const FONT_REPAIR_COMMAND = 'font_readiness_retry';

/**
 * Start a repair. Resolves with the state the attempt begins from, normally `repairing`.
 *
 * Returns `null` outside the desktop runtime rather than throwing: a browser context has no managed
 * package to repair, and a caller offering a retry button should not have to know that.
 */
export const retryManagedFont = async () => {
  if (!isDesktopRuntime()) return null;
  return invokeDesktop(FONT_REPAIR_COMMAND, {});
};
