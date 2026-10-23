// Primitive snapshot and field validators shared by the native render request and response checks.
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invalidRequest, invalidResponse } from './renderErrors';
import { isRecord, utf8ByteLength } from './plainDataRecord';

const MAX_RENDER_DURATION_MICROS = 24 * 60 * 60 * 1_000_000;

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
