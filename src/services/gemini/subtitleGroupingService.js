import { DEFAULT_FAST_TEXT_MODEL_ID } from '../../config/geminiModels';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';
import { getThinkingBudget } from '../../utils/thinkingBudgetUtils';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

export const GROUPING_INTENSITIES = Object.freeze([
  'minimal', 'light', 'balanced', 'moderate', 'enhanced', 'aggressive',
]);
export const MAX_GROUPING_SUBTITLES = 100_000;
export const MAX_GROUPING_SOURCE_BYTES = 700 * 1024;

const textEncoder = new TextEncoder();
const intensitySet = new Set(GROUPING_INTENSITIES);

const isUuidV7 = (value) => {
  if (typeof value !== 'string' || !validateUuid(value)) return false;
  try { return uuidVersion(value) === 7; } catch { return false; }
};

export class SubtitleGroupingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SubtitleGroupingError';
    this.code = code;
    Object.assign(this, details);
  }
}

const invalid = (message, details) => new SubtitleGroupingError(
  'invalidSubtitleGroupingData', message, details
);

const dataDescriptors = (value, field) => {
  let descriptors = null;
  try {
    descriptors = value !== null && typeof value === 'object'
      && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
      ? Object.getOwnPropertyDescriptors(value)
      : null;
  } catch {
    descriptors = null;
  }
  if (!descriptors || Reflect.ownKeys(descriptors).some((key) => (
    typeof key !== 'string'
    || !Object.prototype.hasOwnProperty.call(descriptors[key], 'value')
  ))) throw invalid(`${field} must be a plain data object`);
  return descriptors;
};

const arrayValues = (value, field, { minimum = 0, maximum } = {}) => {
  let descriptors = null;
  try {
    descriptors = Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
      ? Object.getOwnPropertyDescriptors(value)
      : null;
  } catch {
    descriptors = null;
  }
  const length = descriptors?.length?.value;
  if (!descriptors || !Number.isSafeInteger(length) || length < minimum || length > maximum) {
    throw invalid(`${field} must be a bounded plain array`);
  }
  const allowed = new Set(['length']);
  const rows = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    allowed.add(key);
    const descriptor = descriptors[key];
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw invalid(`${field}[${index}] must be an own data value`);
    }
    rows.push(descriptor.value);
  }
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw invalid(`${field} has unsupported properties`);
  }
  return rows;
};

const assertExactKeys = (descriptors, expected, field) => {
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || expected.some((key) => !descriptors[key])) {
    throw invalid(`${field} has an invalid shape`);
  }
};

const isWellFormedUnicode = (value) => {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

const assertIdentifier = (value, field) => {
  if (Number.isSafeInteger(value)) return value;
  if (isWellFormedUnicode(value) && value.length > 0
      && textEncoder.encode(value).byteLength <= 1_024) return value;
  throw invalid(`${field} must be a bounded string or safe integer`);
};

export const normalizeGroupingIntensity = (value) => {
  if (!intensitySet.has(value)) throw invalid('Grouping intensity is invalid');
  return value;
};

/** Provider positions are 1..N; application IDs are lineage only and are never parsed. */
export const snapshotGroupingSource = (subtitles) => {
  const values = arrayValues(subtitles, 'subtitles', {
    minimum: 1, maximum: MAX_GROUPING_SUBTITLES,
  });
  let encodedBytes = 0;
  let previousStart = -1;
  const seenIds = new Set();
  const rows = values.map((subtitle, index) => {
    const descriptors = dataDescriptors(subtitle, `subtitles[${index}]`);
    const rawId = descriptors.sourceId?.value
      ?? descriptors.id?.value
      ?? descriptors.subtitle_id?.value
      ?? index + 1;
    const id = assertIdentifier(rawId, `subtitles[${index}].id`);
    const idKey = `${typeof id}:${id}`;
    if (seenIds.has(idKey)) throw invalid('Subtitle source IDs must be unique');
    seenIds.add(idKey);
    const start = descriptors.start?.value;
    const end = descriptors.end?.value;
    const text = descriptors.text?.value;
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(end) || end <= start
        || start < previousStart) {
      throw invalid(`subtitles[${index}] has invalid or unordered timing`);
    }
    if (!isWellFormedUnicode(text) || text.trim().length === 0) {
      throw invalid(`subtitles[${index}].text must be nonblank well-formed Unicode`);
    }
    const row = Object.freeze({ sourcePosition: index + 1, sourceId: id, start, end, text });
    encodedBytes += textEncoder.encode(JSON.stringify(row)).byteLength;
    if (encodedBytes > MAX_GROUPING_SOURCE_BYTES) {
      throw new SubtitleGroupingError(
        'subtitleGroupingSourceTooLarge', 'Subtitle grouping source is too large'
      );
    }
    previousStart = start;
    return row;
  });
  return Object.freeze(rows);
};

export const canonicalGroupingSource = (sourceType, subtitles) => {
  if (sourceType !== 'original' && sourceType !== 'translated') {
    throw invalid('Grouping source type is invalid');
  }
  return JSON.stringify({ schemaVersion: 1, sourceType, rows: snapshotGroupingSource(subtitles) });
};

export const fingerprintGroupingSource = async (sourceType, subtitles) => {
  const canonical = canonicalGroupingSource(sourceType, subtitles);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new SubtitleGroupingError(
      'subtitleGroupingFingerprintUnavailable', 'SHA-256 is unavailable for subtitle grouping'
    );
  }
  const digest = await subtle.digest('SHA-256', textEncoder.encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

const parseExactPartition = (text, sourceLength) => {
  if (!isWellFormedUnicode(text) || text.length === 0
      || textEncoder.encode(text).byteLength > MAX_GROUPING_SOURCE_BYTES) {
    throw new SubtitleGroupingError('invalidSubtitleGroupingResponse', 'Grouping response is invalid');
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    throw new SubtitleGroupingError(
      'invalidSubtitleGroupingResponse', 'Grouping response must be one complete JSON value'
    );
  }
  const descriptors = dataDescriptors(parsed, 'groupingResponse');
  assertExactKeys(descriptors, ['groups'], 'groupingResponse');
  const groups = arrayValues(descriptors.groups.value, 'groupingResponse.groups', {
    minimum: 1, maximum: sourceLength,
  });
  let expectedPosition = 1;
  const normalized = groups.map((group, groupIndex) => {
    const positions = arrayValues(group, `groupingResponse.groups[${groupIndex}]`, {
      minimum: 1, maximum: sourceLength,
    });
    for (const position of positions) {
      if (!Number.isSafeInteger(position) || position !== expectedPosition) {
        throw new SubtitleGroupingError(
          'invalidSubtitleGroupingPartition',
          'Grouping response must be an exact contiguous ordered partition'
        );
      }
      expectedPosition += 1;
    }
    return Object.freeze([...positions]);
  });
  if (expectedPosition !== sourceLength + 1) {
    throw new SubtitleGroupingError(
      'invalidSubtitleGroupingPartition', 'Grouping response omitted source subtitles'
    );
  }
  return Object.freeze(normalized);
};

export const createGroupedSubtitles = (sourceRows, partition) => Object.freeze(
  partition.map((positions, index) => {
    const rows = positions.map((position) => sourceRows[position - 1]);
    return Object.freeze({
      subtitle_id: index + 1,
      id: index + 1,
      start: rows[0].start,
      end: rows[rows.length - 1].end,
      text: rows.map((row) => row.text.trim()).join(' '),
      original_ids: Object.freeze(rows.map((row) => row.sourceId)),
      source_positions: Object.freeze([...positions]),
    });
  })
);

const guidelines = Object.freeze({
  minimal: 'Only join clearly incomplete sentences; usually keep groups to 1-2 positions.',
  light: 'Join only clear sentence fragments; usually keep groups to 2-3 positions.',
  balanced: 'Balance natural thoughts and frequent breaks; usually use 2-4 positions.',
  moderate: 'Join complete thoughts naturally; usually use 3-4 positions.',
  enhanced: 'Actively join related thoughts; usually use 4-5 positions.',
  aggressive: 'Join broadly related thoughts; usually use 5-7 positions.',
});

export const groupSubtitlesForNarration = async (
  subtitles,
  language = 'en',
  model = DEFAULT_FAST_TEXT_MODEL_ID,
  intensity = 'moderate',
  { signal, projectId, expectedProjectStateVersion } = {}
) => {
  const normalizedIntensity = normalizeGroupingIntensity(intensity);
  const sourceRows = snapshotGroupingSource(subtitles);
  if (!isWellFormedUnicode(language) || language.trim().length === 0 || language.length > 128) {
    throw invalid('Grouping language is invalid');
  }
  const promptRows = sourceRows.map((row) => `${row.sourcePosition}: ${JSON.stringify(row.text)}`)
    .join('\n');
  const prompt = `Group these ${language} subtitle positions for narration.\n${guidelines[normalizedIntensity]}\n\n`
    + '{"groups":[[1,2],[3]]} is the only allowed response shape. '
    + `The arrays must form an exact contiguous ordered partition of every integer from 1 through ${sourceRows.length}. `
    + 'Do not repeat, omit, reorder, coerce, or invent a position. Return no prose or markdown.\n\n'
    + promptRows;
  const thinking = getThinkingBudget(model);
  const delivery = await runNativeGeminiText({
    task: 'analyzeSubtitles', model, prompt,
    responseJsonSchema: {
      type: 'object', additionalProperties: false, required: ['groups'],
      properties: {
        groups: {
          type: 'array', minItems: 1, maxItems: sourceRows.length,
          items: {
            type: 'array', minItems: 1, maxItems: sourceRows.length,
            items: { type: 'integer', minimum: 1, maximum: sourceRows.length },
          },
        },
      },
    },
    ...(typeof thinking === 'string' ? { thinkingLevel: thinking } : {}),
    ...(projectId === undefined ? {} : { projectId }),
    ...(expectedProjectStateVersion === undefined ? {} : { expectedProjectStateVersion }),
    signal,
  });
  if (!isUuidV7(delivery?.job?.id) || !isUuidV7(delivery.deliveryId)
      || typeof delivery.acknowledge !== 'function') {
    throw new SubtitleGroupingError(
      'invalidSubtitleGroupingDelivery', 'Grouping result has no durable native delivery identity'
    );
  }
  const partition = parseExactPartition(delivery.text, sourceRows.length);
  return Object.freeze({
    success: true,
    groupedSubtitles: createGroupedSubtitles(sourceRows, partition),
    groupMapping: Object.freeze(Object.fromEntries(
      partition.map((positions, index) => [String(index + 1), Object.freeze([...positions])])
    )),
    sourceRows,
    providerJobId: delivery.job.id,
    deliveryId: delivery.deliveryId,
    acknowledge: delivery.acknowledge,
  });
};
