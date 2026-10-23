// The one set of shape primitives the native bridge normalizers share: plain-data record checks,
// exact/allowed key sets, frozen record snapshots, native error codes and UTF-8 byte length.

/** A plain object: prototype `Object.prototype` or `null`. Arrays and class instances are not. */
export const isRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const dataDescriptors = (value) => {
  if (!isRecord(value)) return null;
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors)
      .every((descriptor) => descriptor.enumerable && Object.hasOwn(descriptor, 'value'))
      ? descriptors
      : null;
  } catch {
    return null;
  }
};

/** A plain record whose own keys are all strings naming enumerable data (non-accessor) fields. */
export const isPlainDataRecord = (value) => dataDescriptors(value) !== null;

/** A frozen copy of a plain data record, so later reads cannot observe a mutation; else null. */
export const snapshotPlainRecord = (value) => {
  const descriptors = dataDescriptors(value);
  if (descriptors === null) return null;
  return Object.freeze(Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
  ));
};

const hasExactSnapshotKeys = (record, keys) => (
  Object.keys(record).length === keys.length
  && keys.every((key) => Object.hasOwn(record, key))
);

/** `snapshotPlainRecord` restricted to exactly `keys` (an array, any order); else null. */
export const snapshotExactRecord = (value, keys) => {
  const snapshot = snapshotPlainRecord(value);
  return snapshot !== null && hasExactSnapshotKeys(snapshot, keys) ? snapshot : null;
};

/** A plain data record with exactly the own keys in `keys` (an array, any order). */
export const hasExactKeys = (value, keys) => (
  isPlainDataRecord(value) && hasExactSnapshotKeys(value, keys)
);

/** A plain data record whose own keys are all listed in `keys` (an array); none are required. */
export const hasOnlyKeys = (value, keys) => (
  isPlainDataRecord(value) && Object.keys(value).every((key) => keys.includes(key))
);

/**
 * Duck-typed `AbortSignal`. Signals are class instances, so they never pass `isRecord`; this is the
 * one check for a caller-supplied cancellation signal.
 */
export const isAbortSignalLike = (value) => {
  if (value === null || typeof value !== 'object') return false;
  try {
    return typeof value.aborted === 'boolean'
      && typeof value.addEventListener === 'function'
      && typeof value.removeEventListener === 'function';
  } catch {
    return false;
  }
};

/** The code shape every sanitized native refusal carries (`desktopRuntime` enforces it too). */
export const NATIVE_ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,127}$/;

export const isNativeErrorCode = (value) => (
  typeof value === 'string' && NATIVE_ERROR_CODE_PATTERN.test(value)
);

/**
 * The frozen `{ code, message }` record a native job or channel failure carries, or null when the
 * shape, code or message type is wrong. Callers apply their own message bound and code mapping.
 */
export const snapshotNativeError = (value) => {
  const snapshot = snapshotExactRecord(value, ['code', 'message']);
  return snapshot !== null && isNativeErrorCode(snapshot.code) && typeof snapshot.message === 'string'
    ? snapshot
    : null;
};

/** UTF-8 encoded length; a lone surrogate counts as the 3-byte U+FFFD an encoder would emit. */
export const utf8ByteLength = (value) => {
  let bytes = 0;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point <= 0x7f) bytes += 1;
    else if (point <= 0x7ff) bytes += 2;
    else if (point <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
};
