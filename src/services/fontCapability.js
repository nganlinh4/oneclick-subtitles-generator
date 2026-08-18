/**
 * What the running application can actually draw with, as a fact from native bootstrap.
 *
 * WHY THIS EXISTS. `resolveFontIdentity` refuses the managed family unless its caller says the
 * package is installed, and that parameter used to default to `false`. No production call site ever
 * passed it — only `fontIdentity.test.js` did. The editor's default subtitle font IS the managed
 * family, so on every real installation the default font resolved to nothing, `previewFace`
 * returned `null`, the preview request was never built, and the editor said the preview was
 * unavailable forever. The tests passed because they supplied the one input production never did.
 *
 * The fix is not to pass `true`. It is to stop asking React to know: native installs and
 * hash-verifies the managed package and publishes a typed readiness record. This module is the only
 * place that record is read.
 *
 * WHY IT IS A RECORD AND NOT A BOOLEAN. Readiness changes. Native waits a bounded time for the font
 * at startup; when that wait expires the installation keeps running and can finish seconds later.
 * The old bootstrap froze a boolean with `Object.defineProperty`, so a font that arrived late could
 * never be reported, and the editor waited for a preview that would never come. The record carries
 * an epoch that advances on every change, a typed reason when refused, and whether retrying is
 * worth offering.
 *
 * WHAT IT IS NOT. Not a probe, not a guess, not a cache. If native has not spoken, this reports
 * `unknown` rather than `absent` — the difference between "the package is not installed" and "we
 * have not been told yet" is the difference between a typed failure and a pending state, and
 * collapsing them is the defect this module exists to remove.
 */

import { MANAGED_FONT_PACKAGE } from './fontIdentity';

/** How certain we are about the managed package. `unknown` is a pending state, never a failure. */
export const MANAGED_PACK_STATE = Object.freeze({
  installed: 'installed',
  absent: 'absent',
  unknown: 'unknown',
});

/** The native states, mirrored from `font_readiness.rs`. Kept in step by a test on both sides. */
export const FONT_READINESS_STATE = Object.freeze({
  resolving: 'resolving',
  repairing: 'repairing',
  ready: 'ready',
  refused: 'refused',
});

/** The event native emits whenever the record changes. */
export const FONT_READINESS_EVENT = 'osg://font-readiness';

/** The record shape this build understands. A newer schema is treated as unknown, not guessed at. */
export const FONT_READINESS_SCHEMA = 1;

const READINESS_TO_PACK_STATE = Object.freeze({
  [FONT_READINESS_STATE.ready]: MANAGED_PACK_STATE.installed,
  [FONT_READINESS_STATE.refused]: MANAGED_PACK_STATE.absent,
  [FONT_READINESS_STATE.resolving]: MANAGED_PACK_STATE.unknown,
  [FONT_READINESS_STATE.repairing]: MANAGED_PACK_STATE.unknown,
});

const isRecord = (value) => typeof value === 'object' && value !== null;

/**
 * The readiness record native published, or `null` when there is none this build can read.
 *
 * A record from a newer schema is refused rather than interpreted. Guessing at an unknown shape is
 * how a capability check starts reporting confident nonsense after an upgrade.
 */
export const readFontReadiness = (globalScope) => {
  if (!isRecord(globalScope)) return null;
  const record = globalScope.__OSG_FONT_READINESS__;
  if (!isRecord(record) || record.schema !== FONT_READINESS_SCHEMA) return null;
  if (!Object.hasOwn(READINESS_TO_PACK_STATE, record.state)) return null;
  // Every field the contract promises must be present. A truncated record is not a lenient version
  // of a valid one: accepting `{ schema, state: 'ready' }` would report a font usable on the word of
  // something that cannot even say which family or which answer it is.
  if (typeof record.family !== 'string' || record.family.length === 0) return null;
  if (!Number.isInteger(record.epoch) || record.epoch < 0) return null;
  return record;
};

/**
 * The capability snapshot every font decision reads.
 *
 * Frozen, and derived only from what native reported plus the package identity compiled into both
 * sides. Nothing here is discovered by measuring the DOM.
 */
export const fontCapabilitySnapshot = (globalScope = typeof window === 'undefined' ? null : window) => {
  const record = readFontReadiness(globalScope);
  const managedPack = record === null
    ? MANAGED_PACK_STATE.unknown
    : READINESS_TO_PACK_STATE[record.state];

  return Object.freeze({
    managedPack,
    managedFamily: MANAGED_FONT_PACKAGE.family,
    managedVersion: MANAGED_FONT_PACKAGE.version,
    /** True only when native positively confirmed it. `unknown` is deliberately not true. */
    managedPackInstalled: managedPack === MANAGED_PACK_STATE.installed,
    /** True while the answer is still pending, so a caller can show loading rather than failure. */
    pending: managedPack === MANAGED_PACK_STATE.unknown,
    /**
     * Whether native has published a readable record at all.
     *
     * Distinct from `pending` on purpose. A record that says `resolving` means work is under way
     * and will report; NO record means nothing has spoken, which is the normal state in a browser
     * and in a test that did not stage one. Collapsing the two produces a "preparing..." message
     * that can never advance — the same forever-waiting shape this module exists to remove, only
     * with friendlier wording.
     */
    published: record !== null,
    /** The native state verbatim, for a caller that must distinguish resolving from repairing. */
    readiness: record === null ? FONT_READINESS_STATE.resolving : record.state,
    /**
     * Advances on every native change. A consumer compares it to tell a fresh answer from one it
     * already acted on, and to discard work owned by an older answer.
     */
    epoch: record === null ? 0 : record.epoch,
    /** A bounded machine-readable cause, present only when refused. */
    reason: record === null ? null : (record.reason ?? null),
    /** Whether offering a retry could plausibly help. Never true unless refused. */
    retryable: record === null ? false : record.retryable === true,
    /** The installed version, present only once verified. */
    installedVersion: record === null ? null : (record.version ?? null),
  });
};

/**
 * Call `onChange` whenever native publishes a new readiness record.
 *
 * Returns a function that stops listening. The record on the window is replaced before `onChange`
 * runs, so a listener that calls `fontCapabilitySnapshot()` sees the new value rather than the one
 * it is being notified about — there is one source of truth, not an event payload racing a global.
 */
export const subscribeToFontReadiness = (
  onChange,
  { globalScope = typeof window === 'undefined' ? null : window, listen = null } = {},
) => {
  if (typeof onChange !== 'function' || !isRecord(globalScope)) return () => {};

  const apply = (record) => {
    if (isRecord(record)) globalScope.__OSG_FONT_READINESS__ = record;
    onChange(fontCapabilitySnapshot(globalScope));
  };

  // The desktop transport when one is supplied; otherwise a DOM event, which is what tests and any
  // non-Tauri host can drive without a mock of the Tauri API.
  if (typeof listen === 'function') {
    let stop = () => {};
    let cancelled = false;
    Promise.resolve(listen(FONT_READINESS_EVENT, (event) => apply(event?.payload)))
      .then((unlisten) => {
        if (cancelled) unlisten?.();
        else stop = typeof unlisten === 'function' ? unlisten : () => {};
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop();
    };
  }

  const handler = (event) => apply(event?.detail);
  globalScope.addEventListener(FONT_READINESS_EVENT, handler);
  return () => globalScope.removeEventListener(FONT_READINESS_EVENT, handler);
};

/**
 * Re-exported so font consumers need only this module, while the value itself lives in the shared
 * leaf that the render customization defaults also read. Declaring it here as well is what produced
 * two disagreeing defaults in the first place.
 */
export { DEFAULT_SUBTITLE_FONT_FAMILY, DEFAULT_SUBTITLE_FONT_NAME } from '../shared/subtitle/defaultSubtitleFont';
