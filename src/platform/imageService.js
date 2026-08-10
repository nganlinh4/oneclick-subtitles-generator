import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { invokeDesktop, invokeDesktopRaw } from './desktopRuntime';

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const IMAGE_FORMATS = Object.freeze({
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
});
const descriptorKeys = Object.freeze(['assetId', 'mimeType', 'sizeBytes']);

const isPlainRecord = (value) => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
);

const hasExactKeys = (value, expected) => {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
};

const isArrayBuffer = (value) => (
  value !== null
  && typeof value === 'object'
  && Object.prototype.toString.call(value) === '[object ArrayBuffer]'
  && Number.isSafeInteger(value.byteLength)
);

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try {
    return uuidVersion(value) === 7;
  } catch {
    return false;
  }
};

const invalidRequest = () => {
  const error = new Error('The native reference-image request is invalid');
  error.name = 'ImageServiceError';
  error.code = 'invalidImageRequest';
  return error;
};

const invalidResponse = () => {
  const error = new Error('The desktop host returned invalid reference-image data');
  error.name = 'ImageServiceError';
  error.code = 'invalidImageResponse';
  return error;
};

const normalizeMimeType = (value) => {
  if (typeof value !== 'string') throw invalidRequest();
  const mimeType = IMAGE_FORMATS[value.trim().toLowerCase()];
  if (mimeType === undefined) throw invalidRequest();
  return mimeType;
};

const normalizeDescriptor = (value, expected = {}) => {
  if (!hasExactKeys(value, descriptorKeys)
      || !isUuidV7(value.assetId)
      || !Number.isSafeInteger(value.sizeBytes)
      || value.sizeBytes < 1
      || value.sizeBytes > MAX_REFERENCE_BYTES
      || !Object.values(IMAGE_FORMATS).includes(value.mimeType)
      || (expected.mimeType !== undefined && value.mimeType !== expected.mimeType)
      || (expected.sizeBytes !== undefined && value.sizeBytes !== expected.sizeBytes)) {
    throw invalidResponse();
  }
  return Object.freeze({ ...value });
};

export const importReferenceImage = async (blob) => {
  if (typeof Blob === 'undefined'
      || !(blob instanceof Blob)
      || !Number.isSafeInteger(blob.size)
      || blob.size < 1
      || blob.size > MAX_REFERENCE_BYTES) {
    throw invalidRequest();
  }
  const mimeType = normalizeMimeType(blob.type);
  let bytes;
  try {
    bytes = await blob.arrayBuffer();
  } catch {
    throw invalidRequest();
  }
  if (!isArrayBuffer(bytes) || bytes.byteLength !== blob.size) throw invalidRequest();
  return normalizeDescriptor(
    await invokeDesktopRaw('image_blob_import', bytes, { 'x-osg-content-type': mimeType }),
    { mimeType, sizeBytes: bytes.byteLength }
  );
};

export const releaseReferenceImage = async (assetId) => {
  if (!isUuidV7(assetId)) throw invalidRequest();
  const released = await invokeDesktop('image_blob_release', { assetId });
  if (typeof released !== 'boolean') throw invalidResponse();
  return released;
};
