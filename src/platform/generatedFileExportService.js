import { invokeDesktopRaw } from './desktopRuntime';

const FORMAT_BY_MIME = Object.freeze({
  'image/png': Object.freeze({ extension: 'png', label: 'generated' }),
  'image/jpeg': Object.freeze({ extension: 'jpg', label: 'generated' }),
  'image/webp': Object.freeze({ extension: 'webp', label: 'generated' }),
  'image/gif': Object.freeze({ extension: 'gif', label: 'generated' }),
  'audio/wav': Object.freeze({ extension: 'wav', label: 'recording' }),
  'audio/wave': Object.freeze({ extension: 'wav', label: 'recording' }),
  'audio/x-wav': Object.freeze({ extension: 'wav', label: 'recording' }),
  'audio/webm': Object.freeze({ extension: 'webm', label: 'recording' }),
});
const MAX_BYTES = 64 * 1024 * 1024;

const safeFileName = (value, format) => {
  const raw = String(value || format.label);
  const dot = raw.lastIndexOf('.');
  const rawStem = dot > 0 ? raw.slice(0, dot) : raw;
  const stem = Array.from(rawStem, (character) => (
    /^[A-Za-z0-9_.-]$/.test(character) ? character : '_'
  )).join('').replace(/^[._-]+|\.+$/g, '').slice(0, 220) || format.label;
  return `${stem}.${format.extension}`;
};

export const exportGeneratedBlob = async (blob, suggestedName) => {
  const format = blob instanceof Blob ? FORMAT_BY_MIME[blob.type] : null;
  if (!format || blob.size <= 0 || blob.size > MAX_BYTES) {
    throw new Error('The generated file is invalid.');
  }
  const fileName = safeFileName(suggestedName, format);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength !== blob.size) throw new Error('The generated file is invalid.');
  const saved = await invokeDesktopRaw('generated_file_export', bytes, {
    'x-osg-content-type': blob.type,
    'x-osg-file-name': fileName,
  });
  if (typeof saved !== 'boolean') {
    throw new Error('The desktop file exporter returned an invalid response.');
  }
  return saved;
};
