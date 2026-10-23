// Primitive snapshot and field validators shared by the native render request and response checks.
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invalidRequest, invalidResponse } from './renderErrors';

const MAX_RENDER_DURATION_MICROS = 24 * 60 * 60 * 1_000_000;

export const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

export const snapshotPlainRecord = (value) => {
  try {
    if (!isRecord(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null
        || Object.getOwnPropertySymbols(value).length !== 0) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(
      (descriptor) => !descriptor.enumerable || !('value' in descriptor)
    )) {
      return null;
    }
    return Object.freeze(Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
    ));
  } catch {
    return null;
  }
};

export const isPlainRecord = (value) => snapshotPlainRecord(value) !== null;

export const snapshotExactRecord = (value, keys) => {
  const snapshot = snapshotPlainRecord(value);
  if (snapshot === null || Object.keys(snapshot).length !== keys.length
      || !keys.every((key) => Object.prototype.hasOwnProperty.call(snapshot, key))) {
    return null;
  }
  return snapshot;
};

export const hasExactKeys = (value, keys) => (
  snapshotExactRecord(value, keys) !== null
);

export const hasOnlyKeys = (value, keys) => (
  isPlainRecord(value) && Object.keys(value).every((key) => keys.has(key))
);

export const uuidHasVersion = (value, expectedVersion) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === expectedVersion;
  } catch {
    return false;
  }
};

export const dataProperty = (value, key) => {
  try {
    if (!isRecord(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value')
      ? Object.freeze({ value: descriptor.value })
      : null;
  } catch {
    return null;
  }
};

export const requireInteger = (value, minimum, maximum, response = false) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw response ? invalidResponse() : invalidRequest();
  }
  return value;
};

export const requireFinite = (value, minimum, maximum) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidRequest();
  }
  return value;
};

export const requireUuid = (value, expectedVersion, response = false) => {
  if (!uuidHasVersion(value, expectedVersion)) {
    throw response ? invalidResponse() : invalidRequest();
  }
  return value;
};

export const requireEnum = (value, allowed) => {
  if (!allowed.has(value)) throw invalidRequest();
  return value;
};

export const isWellFormedUtf16 = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      if (index + 1 >= value.length) return false;
      const following = value.charCodeAt(index + 1);
      if (following < 0xDC00 || following > 0xDFFF) return false;
      index += 1;
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false;
    }
  }
  return true;
};

export const hasControlCharacter = (value, allowTextWhitespace = false) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const isControl = codeUnit <= 0x1F || (codeUnit >= 0x7F && codeUnit <= 0x9F);
    if (isControl && !(allowTextWhitespace && [0x09, 0x0A, 0x0D].includes(codeUnit))) {
      return true;
    }
  }
  return false;
};

export const utf8ByteLength = (value) => new TextEncoder().encode(value).byteLength;

export const requireString = (value, maximumBytes = 16_384, options = {}) => {
  const { allowTextWhitespace = false } = options;
  if (typeof value !== 'string' || value.length === 0 || !isWellFormedUtf16(value)
      || hasControlCharacter(value, allowTextWhitespace)
      || utf8ByteLength(value) > maximumBytes) {
    throw invalidRequest();
  }
  return value;
};

export const requireColor = (value) => {
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]+$/.test(value)
      || ![4, 5, 7, 9].includes(value.length)) {
    throw invalidRequest();
  }
  return value;
};

export const requireGradientDirection = (value) => {
  if (typeof value !== 'string' || !/^\d+deg$/.test(value)) throw invalidRequest();
  const degrees = Number(value.slice(0, -3));
  if (!Number.isSafeInteger(degrees) || degrees > 360) throw invalidRequest();
  return value;
};

export const requireBoolean = (value) => {
  if (typeof value !== 'boolean') throw invalidRequest();
  return value;
};

export const secondsToMicros = (value) => {
  const seconds = requireFinite(Number(value), 0, MAX_RENDER_DURATION_MICROS / 1_000_000);
  return requireInteger(Math.round(seconds * 1_000_000), 0, MAX_RENDER_DURATION_MICROS);
};
