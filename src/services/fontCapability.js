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

/** The record shape this build understands. A present incompatible schema is a terminal refusal. */
export const FONT_READINESS_SCHEMA = 1;

/** A published value that does not satisfy the native protocol is a terminal refusal, not a wait. */
export const FONT_READINESS_CONTRACT_MISMATCH = 'contract-mismatch';

/** Closed native refusal vocabulary, mirrored from `FontRefusal`. */
export const FONT_READINESS_REFUSAL = Object.freeze({
  noUsableSource: 'no-usable-source',
  integrityFailed: 'integrity-failed',
  storeUnavailable: 'store-unavailable',
  versionMismatch: 'version-mismatch',
  timedOut: 'timed-out',
  cancelled: 'cancelled',
});

const READINESS_TO_PACK_STATE = Object.freeze({
  [FONT_READINESS_STATE.ready]: MANAGED_PACK_STATE.installed,
  [FONT_READINESS_STATE.refused]: MANAGED_PACK_STATE.absent,
  [FONT_READINESS_STATE.resolving]: MANAGED_PACK_STATE.unknown,
  [FONT_READINESS_STATE.repairing]: MANAGED_PACK_STATE.unknown,
});

const READINESS_RECORD_KEYS = Object.freeze([
  'schema', 'epoch', 'state', 'family', 'version', 'reason', 'retryable',
]);
const REFUSAL_RETRYABILITY = Object.freeze({
  [FONT_READINESS_REFUSAL.noUsableSource]: true,
  [FONT_READINESS_REFUSAL.integrityFailed]: false,
  [FONT_READINESS_REFUSAL.storeUnavailable]: true,
  [FONT_READINESS_REFUSAL.versionMismatch]: false,
  [FONT_READINESS_REFUSAL.timedOut]: true,
  [FONT_READINESS_REFUSAL.cancelled]: false,
});

const isRecord = (value) => typeof value === 'object' && value !== null;

const plainRecord = (value) => {
  try {
    if (!isRecord(value) || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    if (Object.getOwnPropertySymbols(value).length !== 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
    )) return null;
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    );
  } catch {
    return null;
  }
};

const publishedValue = (globalScope) => {
  try {
    if (!isRecord(globalScope)
        || !Object.hasOwn(globalScope, '__OSG_FONT_READINESS__')) {
      return Object.freeze({ present: false, value: null });
    }
    return Object.freeze({ present: true, value: globalScope.__OSG_FONT_READINESS__ });
  } catch {
    // A host that says the property exists but cannot expose it has still published an unusable
    // contract. Treating that as "not yet" would leave every admission barrier waiting forever.
    return Object.freeze({ present: true, value: null });
  }
};

const recordStateIsValid = (record) => {
  if (record.state === FONT_READINESS_STATE.ready) {
    return record.version === MANAGED_FONT_PACKAGE.version
      && record.reason === null
      && record.retryable === false;
  }
  if (record.state === FONT_READINESS_STATE.refused) {
    return record.version === null
      && Object.hasOwn(REFUSAL_RETRYABILITY, record.reason)
      && record.retryable === REFUSAL_RETRYABILITY[record.reason];
  }
  return record.version === null && record.reason === null && record.retryable === false;
};

const parseFontReadiness = (value) => {
  const record = plainRecord(value);
  if (record === null
      || Object.keys(record).length !== READINESS_RECORD_KEYS.length
      || !READINESS_RECORD_KEYS.every((key) => Object.hasOwn(record, key))) return null;
  if (record.schema !== FONT_READINESS_SCHEMA
      || !Number.isSafeInteger(record.epoch)
      || record.epoch < 0
      || !Object.hasOwn(READINESS_TO_PACK_STATE, record.state)
      || record.family !== MANAGED_FONT_PACKAGE.family
      || typeof record.retryable !== 'boolean'
      || !recordStateIsValid(record)) return null;
  return Object.freeze(record);
};

/**
 * The readiness record native published, or `null` when there is none this build can read.
 *
 * A record from a newer schema is rejected rather than interpreted. The capability snapshot keeps
 * "no publication" distinct from this present-but-incompatible contract, so an export barrier can
 * fail closed instead of waiting forever.
 */
export const readFontReadiness = (globalScope) => {
  const published = publishedValue(globalScope);
  return published.present ? parseFontReadiness(published.value) : null;
};

/**
 * The capability snapshot every font decision reads.
 *
 * Frozen, and derived only from what native reported plus the package identity compiled into both
 * sides. Nothing here is discovered by measuring the DOM.
 */
export const fontCapabilitySnapshot = (globalScope = typeof window === 'undefined' ? null : window) => {
  const published = publishedValue(globalScope);
  const record = published.present ? parseFontReadiness(published.value) : null;
  const contractMismatch = published.present && record === null;
  const managedPack = contractMismatch
    ? MANAGED_PACK_STATE.absent
    : record === null
      ? MANAGED_PACK_STATE.unknown
      : READINESS_TO_PACK_STATE[record.state];
  const reported = plainRecord(published.value);

  return Object.freeze({
    managedPack,
    /** The reviewed identity this build expects; consumers compare requested faces to this. */
    expectedManagedFamily: MANAGED_FONT_PACKAGE.family,
    expectedManagedVersion: MANAGED_FONT_PACKAGE.version,
    /** The validated identity native reported. Never replaced with a contradictory JS constant. */
    managedFamily: record?.family ?? null,
    managedVersion: record?.version ?? null,
    /** Bounded diagnostic identity from an incompatible publication. Never grants capability. */
    reportedFamily: typeof reported?.family === 'string'
      ? reported.family.slice(0, 128)
      : null,
    reportedVersion: typeof reported?.version === 'string'
      ? reported.version.slice(0, 128)
      : null,
    /** True only when native positively confirmed it. `unknown` is deliberately not true. */
    managedPackInstalled: managedPack === MANAGED_PACK_STATE.installed,
    /** True while the answer is still pending, so a caller can show loading rather than failure. */
    pending: !contractMismatch && managedPack === MANAGED_PACK_STATE.unknown,
    /**
     * Whether native has published a readable record at all.
     *
     * Distinct from `pending` on purpose. A record that says `resolving` means work is under way
     * and will report; NO record means nothing has spoken, which is the normal state in a browser
     * and in a test that did not stage one. Collapsing the two produces a "preparing..." message
     * that can never advance — the same forever-waiting shape this module exists to remove, only
     * with friendlier wording.
     */
    published: published.present,
    /** The native state verbatim, for a caller that must distinguish resolving from repairing. */
    readiness: contractMismatch
      ? FONT_READINESS_STATE.refused
      : record === null ? FONT_READINESS_STATE.resolving : record.state,
    /**
     * Advances on every native change. A consumer compares it to tell a fresh answer from one it
     * already acted on, and to discard work owned by an older answer.
     */
    epoch: record === null ? 0 : record.epoch,
    /** A bounded machine-readable cause, present only when refused. */
    reason: contractMismatch
      ? FONT_READINESS_CONTRACT_MISMATCH
      : record === null ? null : record.reason,
    /** Whether offering a retry could plausibly help. Never true unless refused. */
    retryable: record === null ? false : record.retryable,
    /** The installed version, present only once verified. */
    installedVersion: record?.state === FONT_READINESS_STATE.ready ? record.version : null,
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
  // Every consumer has its own listener. The first listener to receive epoch N updates the shared
  // record; the others must still re-render once for that same native publication, while a later
  // duplicate event must wake none of them. Track delivery per subscriber as well as authority
  // monotonicity to preserve both guarantees.
  let lastDeliveredRecord = readFontReadiness(globalScope);

  const preserveMonotonicAuthority = () => {
    const current = readFontReadiness(globalScope);
    if (current !== null
        && (lastDeliveredRecord === null || current.epoch > lastDeliveredRecord.epoch)) {
      lastDeliveredRecord = current;
      onChange(fontCapabilitySnapshot(globalScope));
      return;
    }
    if (lastDeliveredRecord !== null) {
      globalScope.__OSG_FONT_READINESS__ = lastDeliveredRecord;
    }
  };

  const apply = (record) => {
    const incoming = parseFontReadiness(record);
    // Native assigns the window property before dispatching the DOM event. A stale or malformed
    // announcement has therefore already replaced the shared property by the time this listener
    // gets a chance to reject it. Restore the last record this subscriber accepted; merely ignoring
    // the payload would leave direct snapshot readers observing the rejected publication.
    if (incoming === null) {
      preserveMonotonicAuthority();
      return;
    }
    if (lastDeliveredRecord !== null && incoming.epoch <= lastDeliveredRecord.epoch) {
      preserveMonotonicAuthority();
      return;
    }
    const current = readFontReadiness(globalScope);
    if (current !== null && incoming.epoch < current.epoch) {
      lastDeliveredRecord = current;
      onChange(fontCapabilitySnapshot(globalScope));
      return;
    }
    if (current === null || incoming.epoch > current.epoch) {
      globalScope.__OSG_FONT_READINESS__ = incoming;
    }
    lastDeliveredRecord = incoming;
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
