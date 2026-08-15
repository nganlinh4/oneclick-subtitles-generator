import { invokeDesktop } from './desktopRuntime';
import { isDesktopRuntime } from './runtimeEnvironment';

const FORMATS = Object.freeze(new Set(['srt', 'json', 'txt']));
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_FILE_NAME_BYTES = 240;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 256;
const encoder = new TextEncoder();

const invalidArchive = () => new Error('The subtitle archive is invalid.');

const reflectArchiveOrInvalid = (operation) => {
  try {
    return operation();
  } catch {
    throw invalidArchive();
  }
};

const snapshotDenseArchiveArray = (value) => {
  const isArray = reflectArchiveOrInvalid(() => Array.isArray(value));
  if (!isArray) throw invalidArchive();

  const lengthDescriptor = reflectArchiveOrInvalid(
    () => Object.getOwnPropertyDescriptor(value, 'length')
  );
  const length = lengthDescriptor && 'value' in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (!Number.isInteger(length) || length <= 0 || length > MAX_ARCHIVE_ENTRIES) {
    throw invalidArchive();
  }

  const prototype = reflectArchiveOrInvalid(() => Object.getPrototypeOf(value));
  if (prototype !== Array.prototype) throw invalidArchive();

  const descriptors = reflectArchiveOrInvalid(() => Object.getOwnPropertyDescriptors(value));
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (descriptorKeys.length !== length + 1
      || descriptors.length?.value !== length
      || Object.getOwnPropertySymbols(descriptors).length > 0) {
    throw invalidArchive();
  }

  const snapshot = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) throw invalidArchive();
    snapshot[index] = descriptor.value;
  }
  return snapshot;
};

const snapshotDocumentRequest = (rawRequest) => {
  if (rawRequest === null || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
    throw new Error('The subtitle export request is invalid.');
  }
  const prototype = Object.getPrototypeOf(rawRequest);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('The subtitle export request is invalid.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(rawRequest);
  if (Object.getOwnPropertySymbols(rawRequest).length > 0
      || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) {
    throw new Error('The subtitle export request is invalid.');
  }
  return Object.freeze({
    suggestedName: descriptors.suggestedName?.value,
    format: descriptors.format?.value,
    content: descriptors.content?.value,
  });
};

const isWellFormedUnicode = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
};

const normalizeSuggestedName = (value, format) => {
  const extension = `.${format}`;
  const raw = typeof value === 'string' ? value.trim() : '';
  const withoutExtension = raw.toLowerCase().endsWith(extension)
    ? raw.slice(0, -extension.length)
    : raw;
  const cleaned = Array.from(withoutExtension, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 32 || codePoint === 127 || '/\\:<>"|?*'.includes(character)
      ? '_'
      : character;
  }).join('').replace(/[ .]+$/g, '') || 'subtitles';
  const maxStemBytes = MAX_FILE_NAME_BYTES - encoder.encode(extension).byteLength;
  let stem = '';
  for (const character of cleaned) {
    if (encoder.encode(stem + character).byteLength > maxStemBytes) break;
    stem += character;
  }
  return `${stem || 'subtitles'}${extension}`;
};

export const createSubtitleDocumentExportService = ({
  invokeCommand = invokeDesktop,
  isNativeRuntime = isDesktopRuntime,
} = {}) => ({
  async save(rawRequest = {}) {
    const { suggestedName, format, content } = snapshotDocumentRequest(rawRequest);
    if (!isNativeRuntime()) {
      throw new Error('Subtitle document export requires the desktop app.');
    }
    if (!FORMATS.has(format) || typeof suggestedName !== 'string'
      || typeof content !== 'string'
      || !isWellFormedUnicode(content)
      || !isWellFormedUnicode(suggestedName)
      || encoder.encode(content).byteLength > MAX_CONTENT_BYTES) {
      throw new Error('The subtitle export request is invalid.');
    }
    const saved = await invokeCommand('subtitle_document_export', {
      request: {
        suggestedName: normalizeSuggestedName(suggestedName, format),
        format,
        content,
      },
    });
    if (typeof saved !== 'boolean') {
      throw new Error('The desktop subtitle exporter returned an invalid response.');
    }
    return Object.freeze({ status: saved ? 'saved' : 'cancelled' });
  },
});

export const subtitleDocumentExportService = createSubtitleDocumentExportService();

export const exportSubtitleDocument = (request) => subtitleDocumentExportService.save(request);

const dedupeArchiveName = (value, format, usedNames) => {
  const normalized = normalizeSuggestedName(value, format);
  const stem = normalized.slice(0, -(format.length + 1));
  if (!usedNames.has(normalized.toLowerCase())) {
    usedNames.add(normalized.toLowerCase());
    return normalized;
  }
  let candidate;
  for (let suffix = 2; ; suffix += 1) {
    const suffixText = `_${suffix}`;
    const extension = `.${format}`;
    const maxStemBytes = MAX_FILE_NAME_BYTES
      - encoder.encode(suffixText).byteLength
      - encoder.encode(extension).byteLength;
    let truncatedStem = '';
    for (const character of stem) {
      if (encoder.encode(truncatedStem + character).byteLength > maxStemBytes) break;
      truncatedStem += character;
    }
    candidate = `${truncatedStem || 'subtitles'}${suffixText}${extension}`;
    if (!usedNames.has(candidate.toLowerCase())) break;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
};

export const normalizeSubtitleArchiveEntries = (rawEntries) => {
  const entries = snapshotDenseArchiveArray(rawEntries);
  const usedNames = new Set();
  let aggregateBytes = 0;
  return Object.freeze(entries.map((rawEntry) => {
    if (rawEntry === null || typeof rawEntry !== 'object'
        || reflectArchiveOrInvalid(() => Array.isArray(rawEntry))) {
      throw invalidArchive();
    }
    const prototype = reflectArchiveOrInvalid(() => Object.getPrototypeOf(rawEntry));
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidArchive();
    }
    const descriptors = reflectArchiveOrInvalid(() => Object.getOwnPropertyDescriptors(rawEntry));
    if (Object.getOwnPropertySymbols(descriptors).length > 0
        || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) {
      throw invalidArchive();
    }
    const format = descriptors.format?.value;
    const content = descriptors.content?.value;
    const suggestedName = descriptors.suggestedName?.value;
    if (!FORMATS.has(format) || format === 'txt' || typeof content !== 'string'
        || !isWellFormedUnicode(content)
        || (typeof suggestedName === 'string' && !isWellFormedUnicode(suggestedName))) {
      throw invalidArchive();
    }
    const contentBytes = encoder.encode(content).byteLength;
    aggregateBytes += contentBytes;
    if (contentBytes > MAX_CONTENT_BYTES || aggregateBytes > MAX_ARCHIVE_BYTES) {
      throw invalidArchive();
    }
    return Object.freeze({
      suggestedName: dedupeArchiveName(suggestedName, format, usedNames),
      format,
      content,
    });
  }));
};

export const exportSubtitleArchive = async (
  entries,
  suggestedName = 'translated_subtitles.zip'
) => {
  if (!isDesktopRuntime()) throw new Error('The subtitle archive is invalid.');
  const normalizedEntries = normalizeSubtitleArchiveEntries(entries);
  if (typeof suggestedName !== 'string' || !isWellFormedUnicode(suggestedName)) {
    throw new Error('The subtitle archive is invalid.');
  }
  const rawStem = suggestedName.replace(/\.zip$/i, '');
  const safeStem = Array.from(rawStem, (character) => (
    /^[A-Za-z0-9_.-]$/.test(character) ? character : '_'
  )).join('').replace(/^[._-]+|\.+$/g, '').slice(0, 220) || 'translated_subtitles';
  const saved = await invokeDesktop('subtitle_archive_export', {
    request: {
      suggestedName: `${safeStem}.zip`,
      entries: normalizedEntries,
    },
  });
  if (typeof saved !== 'boolean') {
    throw new Error('The desktop subtitle exporter returned an invalid response.');
  }
  return Object.freeze({ status: saved ? 'saved' : 'cancelled' });
};
