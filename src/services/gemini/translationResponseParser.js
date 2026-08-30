/**
 * Strict response parsing for Gemini translation.
 *
 * A provider response is untrusted data. It is accepted only when it reproduces the exact
 * requested language order and the exact source-row identity, order, cardinality, and text for
 * every language. There are intentionally no line-oriented, fuzzy-language, or source-text
 * fallback formats here: those formats cannot prove which source-language pair a string belongs
 * to.
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

const freezeProviderRows = (sourceRows, translationsByLanguage) => Object.freeze(
  sourceRows.map((source, sourceIndex) => Object.freeze({
    sourceId: source.sourceId,
    translations: Object.freeze(translationsByLanguage.map((language) => Object.freeze({
      languageId: language.languageId,
      text: language.rows[sourceIndex].translated,
    }))),
  }))
);

/**
 * @param {Object} responseData Raw Gemini response wrapper
 * @param {{languageIds: string[], sourceRows: Array<{sourceId: string, text: string}>}} ctx
 * @returns {{schemaVersion: 1, languageIds: readonly string[], rows: readonly Object[]}}
 */
export const processTranslationResponse = (responseData, { languageIds, sourceRows }) => {
  const envelope = extractJson(responseData);
  if (!hasExactKeys(envelope, ['schemaVersion', 'translations'])
      || envelope.schemaVersion !== 1
      || !Array.isArray(envelope.translations)
      || envelope.translations.length !== languageIds.length) {
    throw invalidResponse('envelope-shape');
  }

  const seenLanguages = new Set();
  const translationsByLanguage = envelope.translations.map((language, languageIndex) => {
    const expectedLanguageId = languageIds[languageIndex];
    if (!hasExactKeys(language, ['languageId', 'rows'])
        || language.languageId !== expectedLanguageId
        || seenLanguages.has(language.languageId)
        || !Array.isArray(language.rows)
        || language.rows.length !== sourceRows.length) {
      throw invalidResponse(`language-shape-${languageIndex}`);
    }
    seenLanguages.add(language.languageId);

    const seenSources = new Set();
    const rows = language.rows.map((row, sourceIndex) => {
      const expected = sourceRows[sourceIndex];
      if (!hasExactKeys(row, ['sourceId', 'original', 'translated'])
          || row.sourceId !== expected.sourceId
          || seenSources.has(row.sourceId)
          || row.original !== expected.text
          || typeof row.translated !== 'string'
          || row.translated.trim().length === 0) {
        const reason = !hasExactKeys(row, ['sourceId', 'original', 'translated'])
          ? 'row-shape'
          : row.sourceId !== expected.sourceId
            ? 'source-id'
            : seenSources.has(row.sourceId)
              ? 'duplicate-source-id'
              : row.original !== expected.text
                ? 'original-text'
                : 'blank-translation';
        throw invalidResponse(`${reason}-${languageIndex}-${sourceIndex}`);
      }
      seenSources.add(row.sourceId);
      return Object.freeze({
        sourceId: row.sourceId,
        original: row.original,
        translated: row.translated,
      });
    });
    return Object.freeze({ languageId: language.languageId, rows: Object.freeze(rows) });
  });

  return Object.freeze({
    schemaVersion: 1,
    languageIds: Object.freeze([...languageIds]),
    rows: freezeProviderRows(sourceRows, translationsByLanguage),
  });
};
