/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
/**
 * Throttles a callback to be called at most once per `delay` milliseconds.
 * Also returns the result of the last "fresh" call...
 */
export function throttle<T extends (...args: Parameters<T>) => ReturnType<T>>(
  func: T,
  delay: number,
): (...args: Parameters<T>) => ReturnType<T> {
  let lastCall = -Infinity;
  let lastResult: ReturnType<T>;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall >= delay) {
      lastResult = func(...args);
      lastCall = now;
    }
    return lastResult;
  };
}
