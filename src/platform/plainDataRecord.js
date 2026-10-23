// Shape primitives shared by the native bridge normalizers: plain-data record checks, key sets and
// UTF-8 byte length.

export const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

export const isPlainDataRecord = (value) => {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value))
    .every((descriptor) => descriptor.enumerable && 'value' in descriptor);
};

export const hasExactKeys = (value, keys) => (
  isPlainDataRecord(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
);

export const hasOnlyKeys = (value, keys) => (
  isPlainDataRecord(value) && Object.keys(value).every((key) => keys.has(key))
);

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
