// Strict plain-data guards shared by the translation source, language-chain and record parsers.
export const MAX_TRANSLATION_ENTRIES = 100_000;
const MAX_TRANSLATION_STRING_BYTES = 1024 * 1024;
export const MAX_TRANSLATION_AGGREGATE_BYTES = 700 * 1024;
export const MAX_LANGUAGE_CHAIN_ITEMS = 32;

export const textEncoder = new TextEncoder();

export class TranslationDataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TranslationDataError';
    this.code = code;
    Object.assign(this, details);
  }
}

const isWellFormedUnicode = (value) => {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
};

export const assertBoundedString = (value, field, maxBytes = MAX_TRANSLATION_STRING_BYTES) => {
  if (!isWellFormedUnicode(value) || textEncoder.encode(value).byteLength > maxBytes) {
    throw new TranslationDataError(
      'invalidTranslationData',
      `${field} must be bounded, well-formed Unicode`,
      { field }
    );
  }
  return value;
};

export const dataDescriptors = (value, field) => {
  let prototype = null;
  let descriptors = null;
  try {
    prototype = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.getPrototypeOf(value)
      : null;
    descriptors = prototype === Object.prototype
      ? Object.getOwnPropertyDescriptors(value)
      : null;
  } catch {
    prototype = null;
    descriptors = null;
  }
  if (prototype !== Object.prototype || descriptors === null) {
    throw new TranslationDataError(
      'invalidTranslationData',
      `${field} must be a plain data object`,
      { field }
    );
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      throw new TranslationDataError(
        'invalidTranslationData',
        `${field} must not contain symbol properties`,
        { field }
      );
    }
    const descriptor = descriptors[key];
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TranslationDataError(
        'invalidTranslationData',
        `${field}.${key} must not be an accessor`,
        { field: `${field}.${key}` }
      );
    }
  }
  return descriptors;
};

export const readData = (descriptors, key) => descriptors[key]?.value;

export const arrayDataValues = (value, field, { minimum = 0, maximum } = {}) => {
  let descriptors = null;
  try {
    descriptors = Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
      ? Object.getOwnPropertyDescriptors(value)
      : null;
  } catch {
    descriptors = null;
  }
  const length = descriptors?.length?.value;
  if (!descriptors || !Number.isSafeInteger(length) || length < minimum
      || (maximum !== undefined && length > maximum)) {
    throw new TranslationDataError('invalidTranslationData', `${field} is not a bounded data array`);
  }
  const allowedKeys = new Set(['length']);
  const rows = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TranslationDataError(
        'invalidTranslationData',
        `${field}[${index}] must be an own data value`
      );
    }
    rows.push(descriptor.value);
  }
  if (Reflect.ownKeys(descriptors).some((key) => (
    typeof key !== 'string' || !allowedKeys.has(key)
  ))) {
    throw new TranslationDataError('invalidTranslationData', `${field} has unsupported properties`);
  }
  return rows;
};

export const assertAllowedKeys = (descriptors, allowed, field) => {
  const unknown = Reflect.ownKeys(descriptors).find((key) => (
    typeof key !== 'string' || !allowed.has(key)
  ));
  if (unknown !== undefined) {
    const printableKey = typeof unknown === 'symbol' ? 'symbol' : unknown;
    throw new TranslationDataError(
      'invalidTranslationData',
      `${field}.${printableKey} is not supported`,
      { field: `${field}.${printableKey}` }
    );
  }
};

export const assertSafeIdentifier = (value, field) => {
  if (typeof value === 'string') {
    assertBoundedString(value, field, 1024);
    if (value.length === 0) {
      throw new TranslationDataError('invalidTranslationData', `${field} must not be empty`);
    }
    return value;
  }
  if (Number.isSafeInteger(value)) return value;
  throw new TranslationDataError(
    'invalidTranslationData',
    `${field} must be a string or safe integer`,
    { field }
  );
};

export const assertTime = (value, field) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new TranslationDataError(
      'invalidTranslationData',
      `${field} must be a finite non-negative number`,
      { field }
    );
  }
  return value;
};

export const canonicalIdentifier = (value, index) => {
  if (typeof value === 'string') return `string:${value}`;
  if (Number.isSafeInteger(value)) return `number:${value}`;
  return `ordinal:${index}`;
};
