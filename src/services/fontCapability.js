/**
 * What the running application can actually draw with, as a fact from native bootstrap.
 *
 * WHY THIS EXISTS. `resolveFontIdentity` refuses the managed family unless its caller passes
 * `managedPackInstalled: true`, and that parameter defaulted to `false`. No production call site
 * ever passed it — only `fontIdentity.test.js` did. The editor's default subtitle font is
 * `'Google Sans, sans-serif'`, which IS the managed family, so on every real installation the
 * default font resolved to nothing, `previewFace` returned `null`, the preview request was never
 * built, and the editor showed "subtitle preview unavailable" forever. The tests passed because
 * they supplied the one input that makes the code work.
 *
 * The fix is not to pass `true`. It is to stop asking React to know: the native side already
 * installs and hash-verifies the managed package at startup and reports the result into the
 * WebView. This module is the single place that fact is read, so a caller cannot omit it and get a
 * silent `false`.
 *
 * WHAT IT IS NOT. Not a probe, not a guess, not a cache. If native has not spoken, this reports
 * `unknown` rather than `absent` — the difference between "the pack is not installed" and "we have
 * not been told yet" is exactly the difference between a typed failure and a pending state, and
 * collapsing them is the defect this module exists to remove.
 */

import { MANAGED_FONT_PACKAGE } from './fontIdentity';

/** How certain we are about the managed package. `unknown` is a pending state, never a failure. */
export const MANAGED_PACK_STATE = Object.freeze({
  installed: 'installed',
  absent: 'absent',
  unknown: 'unknown',
});

/**
 * The bootstrap fact, read from the value native code defines on the window.
 *
 * `apps/desktop/src-tauri/src/lib.rs` defines `__OSG_MANAGED_UI_FONT__` as a non-writable property
 * before any application script runs: `true` when `UiFontRuntime::prepare` installed and verified
 * the package, `false` when it could not. Absent means the property was never defined — a browser,
 * a test that did not stage it, or a native bootstrap that has not reached the window yet.
 */
const readManagedPackState = (globalScope) => {
  if (typeof globalScope !== 'object' || globalScope === null) return MANAGED_PACK_STATE.unknown;
  const value = globalScope.__OSG_MANAGED_UI_FONT__;
  if (value === true) return MANAGED_PACK_STATE.installed;
  if (value === false) return MANAGED_PACK_STATE.absent;
  return MANAGED_PACK_STATE.unknown;
};

/**
 * The capability snapshot every font decision reads.
 *
 * Frozen, and derived only from what native reported plus the package identity that is compiled
 * into both sides. Nothing here is discovered by measuring the DOM.
 */
export const fontCapabilitySnapshot = (globalScope = typeof window === 'undefined' ? null : window) => {
  const managedPack = readManagedPackState(globalScope);
  return Object.freeze({
    managedPack,
    managedFamily: MANAGED_FONT_PACKAGE.family,
    managedVersion: MANAGED_FONT_PACKAGE.version,
    /** True only when native positively confirmed it. `unknown` is deliberately not true. */
    managedPackInstalled: managedPack === MANAGED_PACK_STATE.installed,
    /** True while the answer is still pending, so a caller can show loading rather than failure. */
    pending: managedPack === MANAGED_PACK_STATE.unknown,
  });
};

/**
 * Re-exported so font consumers need only this module, while the value itself lives in the shared
 * leaf that the render customization defaults also read. Declaring it here as well is what produced
 * two disagreeing defaults in the first place.
 */
export { DEFAULT_SUBTITLE_FONT_FAMILY, DEFAULT_SUBTITLE_FONT_NAME } from '../shared/subtitle/defaultSubtitleFont';
