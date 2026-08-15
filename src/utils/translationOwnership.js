export const TRANSLATION_SCHEMA_VERSION = 1;
export const MAX_TRANSLATION_ENTRIES = 100_000;
export const MAX_TRANSLATION_STRING_BYTES = 1024 * 1024;
export const MAX_TRANSLATION_AGGREGATE_BYTES = 700 * 1024;
export const MAX_LANGUAGE_CHAIN_ITEMS = 32;

const textEncoder = new TextEncoder();

export class TranslationDataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TranslationDataError';
    this.code = code;
    Object.assign(this, details);
  }
}

export const createTranslationAbortError = (message = 'Translation request was aborted') => {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'translationAborted';
  return error;
};

export const isWellFormedUnicode = (value) => {
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

const assertBoundedString = (value, field, maxBytes = MAX_TRANSLATION_STRING_BYTES) => {
  if (!isWellFormedUnicode(value) || textEncoder.encode(value).byteLength > maxBytes) {
    throw new TranslationDataError(
      'invalidTranslationData',
      `${field} must be bounded, well-formed Unicode`,
      { field }
    );
  }
  return value;
};

const dataDescriptors = (value, field) => {
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

const readData = (descriptors, key) => descriptors[key]?.value;

const arrayDataValues = (value, field, { minimum = 0, maximum } = {}) => {
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

const assertAllowedKeys = (descriptors, allowed, field) => {
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

const assertSafeIdentifier = (value, field) => {
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

const assertTime = (value, field) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new TranslationDataError(
      'invalidTranslationData',
      `${field} must be a finite non-negative number`,
      { field }
    );
  }
  return value;
};

const canonicalIdentifier = (value, index) => {
  if (typeof value === 'string') return `string:${value}`;
  if (Number.isSafeInteger(value)) return `number:${value}`;
  return `ordinal:${index}`;
};

/**
 * Snapshot the exact source rows without consulting getters or preserving mutable references.
 */
export const snapshotTranslationSource = (subtitles) => {
  let sourceRows;
  try {
    sourceRows = arrayDataValues(subtitles, 'subtitles', {
      minimum: 1,
      maximum: MAX_TRANSLATION_ENTRIES,
    });
  } catch {
    throw new TranslationDataError(
      'invalidTranslationSource',
      `Translation source must contain 1-${MAX_TRANSLATION_ENTRIES} plain subtitles`
    );
  }

  const stableIds = new Set();
  const rows = sourceRows.map((subtitle, index) => {
    const descriptors = dataDescriptors(subtitle, `subtitles[${index}]`);
    const id = readData(descriptors, 'id');
    const subtitleId = readData(descriptors, 'subtitle_id');
    if (id !== undefined) assertSafeIdentifier(id, `subtitles[${index}].id`);
    if (subtitleId !== undefined) {
      assertSafeIdentifier(subtitleId, `subtitles[${index}].subtitle_id`);
    }
    const start = assertTime(readData(descriptors, 'start'), `subtitles[${index}].start`);
    const end = assertTime(readData(descriptors, 'end'), `subtitles[${index}].end`);
    if (end < start) {
      throw new TranslationDataError(
        'invalidTranslationSource',
        `subtitles[${index}].end must not precede its start`
      );
    }
    const text = assertBoundedString(
      readData(descriptors, 'text'),
      `subtitles[${index}].text`
    );
    const rawId = id ?? subtitleId;
    const originalId = canonicalIdentifier(rawId, index);
    if (stableIds.has(originalId)) {
      throw new TranslationDataError(
        'invalidTranslationSource',
        'Translation source IDs must be unique'
      );
    }
    stableIds.add(originalId);
    return Object.freeze({
      ...(id !== undefined ? { id } : {}),
      ...(subtitleId !== undefined ? { subtitle_id: subtitleId } : {}),
      start,
      end,
      text,
      originalId,
      sourceOrder: index,
    });
  });
  return Object.freeze(rows);
};

export const canonicalTranslationSourcePayload = (subtitles) => {
  const rows = snapshotTranslationSource(subtitles);
  const prefix = `{"schemaVersion":${TRANSLATION_SCHEMA_VERSION},"subtitles":[`;
  const suffix = ']}';
  let encodedBytes = textEncoder.encode(prefix).byteLength + textEncoder.encode(suffix).byteLength;
  const serializedRows = rows.map((row, index) => {
    const serialized = JSON.stringify({
      order: row.sourceOrder,
      originalId: row.originalId,
      start: row.start,
      end: row.end,
      text: row.text,
    });
    encodedBytes += textEncoder.encode(serialized).byteLength + (index === 0 ? 0 : 1);
    if (encodedBytes > MAX_TRANSLATION_AGGREGATE_BYTES) {
      throw new TranslationDataError(
        'translationTooLarge',
        'Translation source data is too large to fingerprint'
      );
    }
    return serialized;
  });
  return `${prefix}${serializedRows.join(',')}${suffix}`;
};

export const fingerprintTranslationSourcePayload = async (canonicalPayload) => {
  assertBoundedString(
    canonicalPayload,
    'canonicalTranslationSourcePayload',
    MAX_TRANSLATION_AGGREGATE_BYTES
  );
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new TranslationDataError(
      'translationFingerprintUnavailable',
      'SHA-256 is unavailable in this runtime'
    );
  }
  const digest = await subtle.digest('SHA-256', textEncoder.encode(canonicalPayload));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const fingerprintTranslationSource = async (subtitles) => (
  fingerprintTranslationSourcePayload(canonicalTranslationSourcePayload(subtitles))
);

const normalizeStyle = (style, field) => {
  if (style === undefined || style === null) return { open: '', close: '' };
  const descriptors = dataDescriptors(style, field);
  assertAllowedKeys(descriptors, new Set(['open', 'close']), field);
  return {
    open: assertBoundedString(readData(descriptors, 'open') ?? '', `${field}.open`, 32),
    close: assertBoundedString(readData(descriptors, 'close') ?? '', `${field}.close`, 32),
  };
};

/** Strict parser for the localStorage language-chain compatibility setting. */
export const normalizeLanguageChain = (
  value,
  { allowEmptyLanguage = true, requireRunnable = false } = {}
) => {
  let chainValues;
  try {
    chainValues = arrayDataValues(value, 'languageChain', {
      minimum: 1,
      maximum: MAX_LANGUAGE_CHAIN_ITEMS,
    });
  } catch {
    throw new TranslationDataError('invalidLanguageChain', 'The language chain is invalid');
  }
  let originalCount = 0;
  let languageCount = 0;
  let validTargetCount = 0;
  const ids = new Set();
  const normalized = chainValues.map((item, index) => {
    const field = `languageChain[${index}]`;
    const descriptors = dataDescriptors(item, field);
    const type = readData(descriptors, 'type');
    const id = assertSafeIdentifier(readData(descriptors, 'id'), `${field}.id`);
    const idKey = `${typeof id}:${id}`;
    if (ids.has(idKey)) {
      throw new TranslationDataError('invalidLanguageChain', 'Language-chain IDs must be unique');
    }
    ids.add(idKey);

    if (type === 'language') {
      assertAllowedKeys(descriptors, new Set(['id', 'type', 'value', 'isOriginal']), field);
      const isOriginal = readData(descriptors, 'isOriginal');
      if (typeof isOriginal !== 'boolean') {
        throw new TranslationDataError('invalidLanguageChain', `${field}.isOriginal must be boolean`);
      }
      const language = assertBoundedString(readData(descriptors, 'value'), `${field}.value`, 256);
      if (isOriginal) {
        originalCount += 1;
        if (language !== 'Original') {
          throw new TranslationDataError(
            'invalidLanguageChain',
            'The original language item must use the canonical Original label'
          );
        }
      } else if (!allowEmptyLanguage && language.trim().length === 0) {
        throw new TranslationDataError('invalidLanguageChain', 'A target language is required');
      } else if (language.trim().length > 0) {
        validTargetCount += 1;
      }
      languageCount += 1;
      return Object.freeze({ id, type, value: language, isOriginal });
    }

    if (type === 'delimiter') {
      assertAllowedKeys(descriptors, new Set(['id', 'type', 'value', 'style']), field);
      const delimiter = assertBoundedString(readData(descriptors, 'value'), `${field}.value`, 64);
      return Object.freeze({
        id,
        type,
        value: delimiter,
        style: Object.freeze(normalizeStyle(readData(descriptors, 'style'), `${field}.style`)),
      });
    }
    throw new TranslationDataError('invalidLanguageChain', `${field}.type is not supported`);
  });

  if (languageCount === 0 || originalCount > 1
      || (requireRunnable && validTargetCount === 0 && originalCount !== 1)) {
    throw new TranslationDataError('invalidLanguageChain', 'The language chain is invalid');
  }
  return Object.freeze(normalized);
};

const normalizeTranslatedSubtitle = (subtitle, index) => {
  const field = `baseSubtitles[${index}]`;
  const descriptors = dataDescriptors(subtitle, field);
  assertAllowedKeys(
    descriptors,
    new Set([
      'id', 'subtitle_id', 'start', 'end', 'startTime', 'endTime', 'text',
      'originalId', 'language', 'sourceOrder',
    ]),
    field
  );
  const id = readData(descriptors, 'id');
  const subtitleId = readData(descriptors, 'subtitle_id');
  const originalId = readData(descriptors, 'originalId');
  if (id !== undefined) assertSafeIdentifier(id, `${field}.id`);
  if (subtitleId !== undefined) assertSafeIdentifier(subtitleId, `${field}.subtitle_id`);
  const stableOriginalId = assertSafeIdentifier(originalId, `${field}.originalId`);
  const start = assertTime(readData(descriptors, 'start'), `${field}.start`);
  const end = assertTime(readData(descriptors, 'end'), `${field}.end`);
  if (end < start) {
    throw new TranslationDataError('invalidTranslationData', `${field}.end precedes start`);
  }
  const text = assertBoundedString(readData(descriptors, 'text'), `${field}.text`);
  const language = readData(descriptors, 'language');
  if (language !== undefined) assertBoundedString(language, `${field}.language`, 128);
  const sourceOrder = readData(descriptors, 'sourceOrder');
  if (sourceOrder !== undefined && (!Number.isSafeInteger(sourceOrder) || sourceOrder < 0)) {
    throw new TranslationDataError('invalidTranslationData', `${field}.sourceOrder is invalid`);
  }
  return Object.freeze({
    ...(id !== undefined ? { id } : {}),
    ...(subtitleId !== undefined ? { subtitle_id: subtitleId } : {}),
    start,
    end,
    ...(readData(descriptors, 'startTime') !== undefined
      ? { startTime: assertBoundedString(readData(descriptors, 'startTime'), `${field}.startTime`, 64) }
      : {}),
    ...(readData(descriptors, 'endTime') !== undefined
      ? { endTime: assertBoundedString(readData(descriptors, 'endTime'), `${field}.endTime`, 64) }
      : {}),
    text,
    originalId: stableOriginalId,
    ...(language !== undefined ? { language } : {}),
    ...(sourceOrder !== undefined ? { sourceOrder } : {}),
  });
};

const normalizeFailedChunk = (chunk, index) => {
  const field = `failedChunks[${index}]`;
  const descriptors = dataDescriptors(chunk, field);
  assertAllowedKeys(
    descriptors,
    new Set(['chunkIndex', 'startOrder', 'endOrder', 'errorCode']),
    field
  );
  const chunkIndex = readData(descriptors, 'chunkIndex');
  const startOrder = readData(descriptors, 'startOrder');
  const endOrder = readData(descriptors, 'endOrder');
  if (![chunkIndex, startOrder, endOrder].every((number) => (
    Number.isSafeInteger(number) && number >= 0
  )) || endOrder < startOrder) {
    throw new TranslationDataError('invalidTranslationData', `${field} has invalid bounds`);
  }
  const errorCode = assertBoundedString(
    readData(descriptors, 'errorCode') ?? 'translationChunkFailed',
    `${field}.errorCode`,
    128
  );
  if (!/^[A-Za-z][A-Za-z0-9]{0,127}$/.test(errorCode)) {
    throw new TranslationDataError('invalidTranslationData', `${field}.errorCode is invalid`);
  }
  return Object.freeze({ chunkIndex, startOrder, endOrder, errorCode });
};

export const normalizeTranslationRecord = (
  record,
  { allowNull = true, revisionOverride = undefined } = {}
) => {
  if (record === null && allowNull) return null;
  const descriptors = dataDescriptors(record, 'translation');
  assertAllowedKeys(
    descriptors,
    new Set([
      'schemaVersion', 'revision', 'sourceFingerprint', 'languageChain', 'model',
      'sourceEntryCount', 'status', 'baseSubtitles', 'failedChunks',
    ]),
    'translation'
  );
  const schemaVersion = revisionOverride === undefined
    ? readData(descriptors, 'schemaVersion')
    : TRANSLATION_SCHEMA_VERSION;
  if (schemaVersion !== TRANSLATION_SCHEMA_VERSION) {
    throw new TranslationDataError('invalidTranslationData', 'Unsupported translation schema');
  }
  const revision = revisionOverride === undefined
    ? readData(descriptors, 'revision')
    : revisionOverride;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new TranslationDataError('invalidTranslationData', 'Translation revision is invalid');
  }
  const sourceFingerprint = assertBoundedString(
    readData(descriptors, 'sourceFingerprint'),
    'translation.sourceFingerprint',
    128
  );
  if (!/^[a-f0-9]{64}$/.test(sourceFingerprint)) {
    throw new TranslationDataError('invalidTranslationData', 'Translation fingerprint is invalid');
  }
  const sourceEntryCount = readData(descriptors, 'sourceEntryCount');
  if (!Number.isSafeInteger(sourceEntryCount) || sourceEntryCount < 1
      || sourceEntryCount > MAX_TRANSLATION_ENTRIES) {
    throw new TranslationDataError(
      'invalidTranslationData',
      'Translation source entry count is invalid'
    );
  }
  const languageChain = normalizeLanguageChain(readData(descriptors, 'languageChain'), {
    // Empty UI placeholders may be preserved, but the chain still must have a real target or be
    // the explicit Original-only format mode.
    allowEmptyLanguage: true,
    requireRunnable: true,
  });
  const model = assertBoundedString(readData(descriptors, 'model'), 'translation.model', 256);
  if (model.trim().length === 0) {
    throw new TranslationDataError('invalidTranslationData', 'Translation model is required');
  }
  const status = readData(descriptors, 'status');
  if (status !== 'complete' && status !== 'partial') {
    throw new TranslationDataError('invalidTranslationData', 'Translation status is invalid');
  }
  let rawRows;
  try {
    rawRows = arrayDataValues(readData(descriptors, 'baseSubtitles'), 'baseSubtitles', {
      minimum: status === 'complete' ? 1 : 0,
      maximum: MAX_TRANSLATION_ENTRIES,
    });
  } catch {
    throw new TranslationDataError('invalidTranslationData', 'Translation rows are invalid');
  }
  let incrementalAggregateBytes = 0;
  const normalizedRows = [];
  for (let index = 0; index < rawRows.length; index += 1) {
    const row = normalizeTranslatedSubtitle(rawRows[index], index);
    incrementalAggregateBytes += textEncoder.encode(JSON.stringify(row)).byteLength;
    if (incrementalAggregateBytes > MAX_TRANSLATION_AGGREGATE_BYTES) {
      throw new TranslationDataError('translationTooLarge', 'Translation data is too large to persist');
    }
    normalizedRows.push(row);
  }
  const baseSubtitles = Object.freeze(normalizedRows);
  const originalIds = new Set();
  const sourceOrders = new Set();
  let previousSourceOrder = -1;
  for (const row of baseSubtitles) {
    const id = `${typeof row.originalId}:${row.originalId}`;
    if (originalIds.has(id)) {
      throw new TranslationDataError('invalidTranslationData', 'Translation original IDs must be unique');
    }
    originalIds.add(id);
    if (!Number.isSafeInteger(row.sourceOrder) || row.sourceOrder < 0
        || row.sourceOrder >= sourceEntryCount || sourceOrders.has(row.sourceOrder)
        || row.sourceOrder <= previousSourceOrder) {
      throw new TranslationDataError(
        'invalidTranslationData',
        'Translation source orders must be unique, ordered, and in range'
      );
    }
    sourceOrders.add(row.sourceOrder);
    previousSourceOrder = row.sourceOrder;
  }
  let rawFailures;
  try {
    rawFailures = arrayDataValues(
      readData(descriptors, 'failedChunks') ?? [],
      'failedChunks',
      { maximum: MAX_TRANSLATION_ENTRIES }
    );
  } catch {
    throw new TranslationDataError('invalidTranslationData', 'Failed chunk metadata is invalid');
  }
  const normalizedFailures = [];
  for (let index = 0; index < rawFailures.length; index += 1) {
    const failure = normalizeFailedChunk(rawFailures[index], index);
    incrementalAggregateBytes += textEncoder.encode(JSON.stringify(failure)).byteLength;
    if (incrementalAggregateBytes > MAX_TRANSLATION_AGGREGATE_BYTES) {
      throw new TranslationDataError('translationTooLarge', 'Translation data is too large to persist');
    }
    normalizedFailures.push(failure);
  }
  const failedChunks = Object.freeze(normalizedFailures);
  if ((status === 'complete' && failedChunks.length !== 0)
      || (status === 'partial' && failedChunks.length === 0)) {
    throw new TranslationDataError('invalidTranslationData', 'Translation terminal metadata is invalid');
  }
  let failedEntryCount = 0;
  let previousChunkIndex = -1;
  let previousFailedEnd = -1;
  for (const failure of failedChunks) {
    if (failure.chunkIndex <= previousChunkIndex
        || failure.startOrder <= previousFailedEnd
        || failure.endOrder >= sourceEntryCount) {
      throw new TranslationDataError(
        'invalidTranslationData',
        'Failed chunk ranges must be ordered, non-overlapping, and in range'
      );
    }
    for (let order = failure.startOrder; order <= failure.endOrder; order += 1) {
      if (sourceOrders.has(order)) {
        throw new TranslationDataError(
          'invalidTranslationData',
          'A translated source order cannot also belong to a failed chunk'
        );
      }
    }
    failedEntryCount += failure.endOrder - failure.startOrder + 1;
    previousChunkIndex = failure.chunkIndex;
    previousFailedEnd = failure.endOrder;
  }
  if (baseSubtitles.length + failedEntryCount !== sourceEntryCount
      || (status === 'complete' && baseSubtitles.length !== sourceEntryCount)) {
    throw new TranslationDataError(
      'invalidTranslationData',
      'Translation rows and failed chunks must cover the exact source cardinality'
    );
  }
  const normalized = {
    schemaVersion: TRANSLATION_SCHEMA_VERSION,
    revision,
    sourceFingerprint,
    sourceEntryCount,
    languageChain,
    model,
    status,
    baseSubtitles,
    failedChunks,
  };
  if (textEncoder.encode(JSON.stringify(normalized)).byteLength > MAX_TRANSLATION_AGGREGATE_BYTES) {
    throw new TranslationDataError('translationTooLarge', 'Translation data is too large to persist');
  }
  return Object.freeze(normalized);
};

export const cloneTranslationRecord = (record) => {
  const normalized = normalizeTranslationRecord(record, { allowNull: false });
  return {
    ...normalized,
    languageChain: normalized.languageChain.map((item) => (
      item.type === 'delimiter' ? { ...item, style: { ...item.style } } : { ...item }
    )),
    baseSubtitles: normalized.baseSubtitles.map((subtitle) => ({ ...subtitle })),
    failedChunks: normalized.failedChunks.map((failure) => ({ ...failure })),
  };
};

/** Validate a terminal record against the immutable source rows before any durable write. */
export const assertTranslationTerminalMatchesSource = (terminal, sourceSubtitles) => {
  const source = snapshotTranslationSource(sourceSubtitles);
  const record = normalizeTranslationRecord(terminal, {
    allowNull: false,
    // The caller's store assigns the real CAS revision; one is needed only for strict parsing.
    revisionOverride: 1,
  });
  if (record.sourceEntryCount !== source.length) {
    throw new TranslationDataError(
      'translationSourceMismatch',
      'Translation terminal cardinality does not match its captured source'
    );
  }
  for (const row of record.baseSubtitles) {
    const original = source[row.sourceOrder];
    if (!original || row.originalId !== original.originalId
        || row.start !== original.start || row.end !== original.end) {
      throw new TranslationDataError(
        'translationSourceMismatch',
        'Translation terminal identity or timing does not match its captured source'
      );
    }
  }
  return record;
};
