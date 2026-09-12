import { TranslationResponseError } from './translationResponseParser';

const invalidRow = (reason) => new TranslationResponseError(`stream-${reason}`);

const isExactRow = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes('ordinal') && keys.includes('translations');
};

const validateRow = (row, expectedOrdinal, languageIds, sourceId) => {
  if (!isExactRow(row) || row.ordinal !== expectedOrdinal
      || !Array.isArray(row.translations) || row.translations.length !== languageIds.length
      || row.translations.some((text) => typeof text !== 'string' || text.trim().length === 0)) {
    throw invalidRow('row-shape');
  }
  return Object.freeze({
    sourceId,
    translations: Object.freeze(row.translations.map((text, index) => Object.freeze({
      languageId: languageIds[index],
      text,
    }))),
  });
};

/**
 * Observes Gemini's concatenable structured-output text deltas and publishes only complete,
 * locally validated row objects. Terminal parsing remains authoritative; this observer is an
 * advisory UI path and never persists or acknowledges provider output.
 */
export const createTranslationStreamObserver = ({ languageIds, sourceRows, onRows }) => {
  if (!Array.isArray(languageIds) || languageIds.length === 0
      || !Array.isArray(sourceRows) || sourceRows.length === 0
      || typeof onRows !== 'function') {
    throw new TypeError('A bounded translation stream contract is required');
  }

  let buffer = '';
  let cursor = null;
  let objectStart = -1;
  let objectDepth = 0;
  let inString = false;
  let escaped = false;
  let emitted = 0;
  let refused = false;

  const feed = (chunk) => {
    if (refused || typeof chunk !== 'string' || chunk.length === 0) return;
    buffer += chunk;
    if (cursor === null) {
      const match = /"rows"\s*:\s*\[/u.exec(buffer);
      if (!match) return;
      cursor = match.index + match[0].length;
    }

    try {
      for (; cursor < buffer.length; cursor += 1) {
        const character = buffer[cursor];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') {
          inString = true;
          continue;
        }
        if (character === '{') {
          if (objectDepth === 0) objectStart = cursor;
          objectDepth += 1;
          continue;
        }
        if (character === '}') {
          if (objectDepth === 0) throw invalidRow('brace-order');
          objectDepth -= 1;
          if (objectDepth !== 0) continue;
          const raw = buffer.slice(objectStart, cursor + 1);
          const parsed = JSON.parse(raw);
          if (emitted >= sourceRows.length) throw invalidRow('extra-row');
          const row = validateRow(
            parsed,
            emitted,
            languageIds,
            sourceRows[emitted].sourceId
          );
          emitted += 1;
          onRows(Object.freeze([row]));
          objectStart = -1;
          continue;
        }
        if (character === ']' && objectDepth === 0) return;
      }
    } catch {
      // A malformed advisory stream must never publish further data. The complete response still
      // goes through the strict terminal parser, which owns retries and user-visible failure.
      refused = true;
    }
  };

  return Object.freeze({ feed });
};
