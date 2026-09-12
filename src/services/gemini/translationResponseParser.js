/**
 * Strict response parsing for Gemini translation.
 *
 * A provider response is untrusted data. The provider supplies only ordered translations and
 * zero-based ordinals; caller-owned source IDs and timing are rebound after exact cardinality,
 * ordering, shape, and non-blank checks. Asking a model to echo source IDs or source text does not
 * prove semantic alignment and wastes the output budget, so neither is part of the wire envelope.
 */

export class TranslationResponseError extends Error {
  constructor(reason = 'unknown') {
    super(`The translation provider returned an invalid identity envelope (${reason})`);
    this.name = 'TranslationResponseError';
    this.code = 'invalidTranslationResponse';
    this.reason = reason;
  }
}

const invalidResponse = (reason) => new TranslationResponseError(reason);

const isPlainRecord = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (value, keys) => {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => (
    Object.prototype.hasOwnProperty.call(value, key)
  ));
};

const extractJson = (responseData) => {
  const part = responseData?.candidates?.[0]?.content?.parts?.[0];
  if (isPlainRecord(part?.structuredJson)) return part.structuredJson;
  if (typeof part?.text !== 'string' || part.text.trim().length === 0) {
    throw invalidResponse('missing-json-text');
  }
  try {
    return JSON.parse(part.text);
  } catch {
    throw invalidResponse('malformed-json-text');
  }
};

const freezeProviderRows = (sourceRows, rows, languageIds) => Object.freeze(
  sourceRows.map((source, sourceIndex) => Object.freeze({
    sourceId: source.sourceId,
    translations: Object.freeze(languageIds.map((languageId, languageIndex) => Object.freeze({
      languageId,
      text: rows[sourceIndex].translations[languageIndex],
    }))),
  }))
);

/**
 * @param {Object} responseData Raw Gemini response wrapper
 * @param {{languageIds: string[], sourceRows: Array<{sourceId: string, text: string}>}} ctx
 * @returns {{schemaVersion: 2, languageIds: readonly string[], rows: readonly Object[]}}
 */
export const processTranslationResponse = (responseData, { languageIds, sourceRows }) => {
  const envelope = extractJson(responseData);
  if (!hasExactKeys(envelope, ['schemaVersion', 'rows'])
      || envelope.schemaVersion !== 2
      || !Array.isArray(envelope.rows)
      || envelope.rows.length !== sourceRows.length) {
    throw invalidResponse('envelope-shape');
  }

  const rows = envelope.rows.map((row, sourceIndex) => {
    if (!hasExactKeys(row, ['ordinal', 'translations'])
        || row.ordinal !== sourceIndex
        || !Array.isArray(row.translations)
        || row.translations.length !== languageIds.length
        || row.translations.some((text) => (
          typeof text !== 'string' || text.trim().length === 0
        ))) {
      const reason = !hasExactKeys(row, ['ordinal', 'translations'])
        ? 'row-shape'
        : row.ordinal !== sourceIndex
          ? 'source-order'
          : 'translation-shape';
      throw invalidResponse(`${reason}-${sourceIndex}`);
    }
    return Object.freeze({
      ordinal: row.ordinal,
      translations: Object.freeze([...row.translations]),
    });
  });

  return Object.freeze({
    schemaVersion: 2,
    languageIds: Object.freeze([...languageIds]),
    rows: freezeProviderRows(sourceRows, rows, languageIds),
  });
};
