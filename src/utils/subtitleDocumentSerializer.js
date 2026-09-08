import { subtitleDisplayText } from './subtitleSpeaker';

const MAX_SUBTITLE_ENTRIES = 100_000;
const MAX_SAFE_MILLISECONDS = Number.MAX_SAFE_INTEGER;
const MAX_SAFE_MILLISECONDS_BIGINT = BigInt(MAX_SAFE_MILLISECONDS);
const MAX_SUBTITLE_TIME_TEXT_LENGTH = 64;

export class SubtitleDocumentSerializationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SubtitleDocumentSerializationError';
    this.code = code;
  }
}

const invalidDocument = (message = 'The subtitle document is invalid.') => (
  new SubtitleDocumentSerializationError('invalidSubtitleDocument', message)
);

const reflectOrInvalid = (operation) => {
  try {
    return operation();
  } catch {
    throw invalidDocument();
  }
};

const snapshotDenseSubtitleArray = (value) => {
  const isArray = reflectOrInvalid(() => Array.isArray(value));
  if (!isArray) throw invalidDocument();

  // Read the non-accessor length descriptor first so bounds are established
  // before reflecting over any attacker-controlled indices.
  const lengthDescriptor = reflectOrInvalid(
    () => Object.getOwnPropertyDescriptor(value, 'length')
  );
  const length = lengthDescriptor && 'value' in lengthDescriptor
    ? lengthDescriptor.value
    : undefined;
  if (!Number.isInteger(length) || length <= 0 || length > MAX_SUBTITLE_ENTRIES) {
    throw invalidDocument();
  }

  const prototype = reflectOrInvalid(() => Object.getPrototypeOf(value));
  if (prototype !== Array.prototype) throw invalidDocument();

  const descriptors = reflectOrInvalid(() => Object.getOwnPropertyDescriptors(value));
  const descriptorKeys = Reflect.ownKeys(descriptors);
  if (descriptorKeys.length !== length + 1
      || descriptors.length?.value !== length
      || Object.getOwnPropertySymbols(descriptors).length > 0) {
    throw invalidDocument();
  }

  const snapshot = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) throw invalidDocument();
    snapshot[index] = descriptor.value;
  }
  return snapshot;
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

const snapshotSubtitle = (value) => {
  if (value === null || typeof value !== 'object'
      || reflectOrInvalid(() => Array.isArray(value))) {
    throw invalidDocument();
  }
  const prototype = reflectOrInvalid(() => Object.getPrototypeOf(value));
  if (prototype !== Object.prototype && prototype !== null) throw invalidDocument();
  const descriptors = reflectOrInvalid(() => Object.getOwnPropertyDescriptors(value));
  if (Object.getOwnPropertySymbols(descriptors).length > 0
      || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) {
    throw invalidDocument();
  }
  const read = (name) => descriptors[name]?.value;
  return Object.freeze({
    start: read('start'),
    end: read('end'),
    startTime: read('startTime'),
    endTime: read('endTime'),
    text: read('text'),
    speaker: read('speaker'),
  });
};

const parseTimestamp = (value) => {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(value);
  if (match === null) return null;
  const milliseconds = (
    Number(match[1]) * 3_600_000
    + Number(match[2]) * 60_000
    + Number(match[3]) * 1_000
    + Number(match[4])
  );
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
};

const parseSeconds = (value) => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw invalidDocument();
    const milliseconds = Math.round(value * 1_000);
    if (!Number.isSafeInteger(milliseconds) || milliseconds > MAX_SAFE_MILLISECONDS) {
      throw invalidDocument();
    }
    return milliseconds;
  }
  if (typeof value !== 'string'
      || value.length > MAX_SUBTITLE_TIME_TEXT_LENGTH
      || !isWellFormedUnicode(value)) {
    throw invalidDocument();
  }
  const timestamp = parseTimestamp(value);
  if (timestamp !== null) return timestamp;
  // Numeric strings use canonical unsigned fixed-point decimal syntax. Limit
  // their text size before parsing, round the fourth fractional digit half-up,
  // and admit only results within the exact safe-integer millisecond domain.
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (match === null || match[1].length > 13) throw invalidDocument();

  const wholeMilliseconds = BigInt(match[1]) * 1_000n;
  const fraction = match[2] || '';
  const millisecondDigits = fraction.slice(0, 3).padEnd(3, '0');
  let exactMilliseconds = wholeMilliseconds + BigInt(millisecondDigits);
  if (fraction.length > 3 && fraction.charCodeAt(3) >= 53) {
    exactMilliseconds += 1n;
  }
  if (exactMilliseconds > MAX_SAFE_MILLISECONDS_BIGINT) throw invalidDocument();
  return Number(exactMilliseconds);
};

export const parseSubtitleTimeSeconds = (value) => parseSeconds(value) / 1_000;

const formatMilliseconds = (milliseconds) => {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw invalidDocument();
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(remainder).padStart(3, '0')}`;
};

const formatCanonicalSeconds = (milliseconds) => {
  const numericSeconds = milliseconds / 1_000;
  if (Math.round(numericSeconds * 1_000) === milliseconds) return numericSeconds;
  const exactMilliseconds = BigInt(milliseconds);
  const wholeSeconds = exactMilliseconds / 1_000n;
  const remainder = exactMilliseconds % 1_000n;
  return `${wholeSeconds}.${String(remainder).padStart(3, '0')}`;
};

const parseConsistentTimeFields = (secondsValue, timestampValue) => {
  const hasSeconds = secondsValue !== undefined;
  const hasTimestamp = timestampValue !== undefined;
  if (!hasSeconds && !hasTimestamp) throw invalidDocument();
  const secondsMilliseconds = hasSeconds ? parseSeconds(secondsValue) : null;
  const timestampMilliseconds = hasTimestamp ? parseSeconds(timestampValue) : null;
  if (hasSeconds && hasTimestamp && secondsMilliseconds !== timestampMilliseconds) {
    throw invalidDocument();
  }
  return hasSeconds ? secondsMilliseconds : timestampMilliseconds;
};

export const normalizeSubtitleDocumentRows = (subtitles) => {
  const rawSubtitles = snapshotDenseSubtitleArray(subtitles);
  return Object.freeze(rawSubtitles.map((rawSubtitle, index) => {
    const subtitle = snapshotSubtitle(rawSubtitle);
    const startMilliseconds = parseConsistentTimeFields(subtitle.start, subtitle.startTime);
    const endMilliseconds = parseConsistentTimeFields(subtitle.end, subtitle.endTime);
    if (endMilliseconds < startMilliseconds
        || typeof subtitle.text !== 'string'
        || !isWellFormedUnicode(subtitle.text)) {
      throw invalidDocument();
    }
    return Object.freeze({
      id: index + 1,
      start: formatCanonicalSeconds(startMilliseconds),
      end: formatCanonicalSeconds(endMilliseconds),
      startTime: formatMilliseconds(startMilliseconds),
      endTime: formatMilliseconds(endMilliseconds),
      text: subtitleDisplayText(subtitle),
    });
  }));
};

export const secondsToSrtTimestamp = (seconds) => formatMilliseconds(parseSeconds(seconds));

export const serializeSrtDocument = (subtitles) => normalizeSubtitleDocumentRows(subtitles)
  .map((subtitle) => (
    `${subtitle.id}\n${subtitle.startTime} --> ${subtitle.endTime}\n${subtitle.text}`
  ))
  .join('\n\n');

export const serializeJsonSubtitleDocument = (subtitles) => JSON.stringify(
  normalizeSubtitleDocumentRows(subtitles),
  null,
  2
);

export const serializeTextSubtitleDocument = (subtitles) => normalizeSubtitleDocumentRows(subtitles)
  .map((subtitle) => subtitle.text)
  .join('\n');

export const serializeSubtitleDocument = (subtitles, format) => {
  switch (format) {
    case 'srt': return serializeSrtDocument(subtitles);
    case 'json': return serializeJsonSubtitleDocument(subtitles);
    case 'txt': return serializeTextSubtitleDocument(subtitles);
    default: throw invalidDocument();
  }
};
