// Accessor-free snapshots of host-returned data, shared by the native service normalizers.
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { snapshotPlainRecord } from './plainDataRecord';

/**
 * A frozen copy of a plain data record whose own keys are all in `allowed` and include every key in
 * `required`. Getters, symbols, non-enumerable keys and exotic prototypes all fail with `failure()`.
 */
export const snapshotDataRecord = (value, {
  required,
  allowed = required,
  failure,
}) => {
  const snapshot = snapshotPlainRecord(value);
  if (snapshot === null
      || Object.keys(snapshot).some((key) => !allowed.includes(key))
      || required.some((key) => !Object.hasOwn(snapshot, key))) {
    throw failure();
  }
  return snapshot;
};

/** A frozen copy of a dense data array of at most `maximum` items, with no extra own keys. */
export const snapshotDataArray = (value, maximum, failure) => {
  try {
    if (!Array.isArray(value)) throw failure();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value')
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) {
      throw failure();
    }
    const length = lengthDescriptor.value;
    if (Reflect.ownKeys(descriptors).length !== length + 1) throw failure();
    const snapshot = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw failure();
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    throw failure();
  }
};

export const exactRecord = (value, keys, failure) => snapshotDataRecord(value, {
  required: keys,
  failure,
});

export const isUuidVersion = (value, expected) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expected;
  } catch {
    return false;
  }
};
