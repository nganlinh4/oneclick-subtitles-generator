/**
 * Combines a strictly validated provider identity envelope with captured subtitle timing.
 */

import { getLanguageCode } from '../../utils/languageUtils';
import { TranslationResponseError } from './translationResponseParser';

const invalidResult = () => new TranslationResponseError();

const translationsForRow = (providerRow, languageIds) => {
  if (!providerRow || !Array.isArray(providerRow.translations)
      || providerRow.translations.length !== languageIds.length) {
    throw invalidResult();
  }
  const translations = new Map();
  providerRow.translations.forEach((entry, index) => {
    if (entry?.languageId !== languageIds[index]
        || typeof entry.text !== 'string'
        || entry.text.trim().length === 0
        || translations.has(entry.languageId)) {
      throw invalidResult();
    }
    translations.set(entry.languageId, entry.text);
  });
  return translations;
};

const formatChain = ({ chainItems, originalText, translations }) => chainItems.map((item) => {
  if (item?.type === 'delimiter') return item.value ?? '';
  if (item?.type !== 'language') throw invalidResult();
  if (item.isOriginal) return originalText;
  if (!translations.has(item.value)) throw invalidResult();
  return translations.get(item.value);
}).join('');

const formatDefault = ({
  languageIds,
  translations,
  delimiter,
  useParentheses,
  bracketStyle,
}) => {
  const texts = languageIds.map((languageId) => translations.get(languageId));
  if (texts.length === 1) return texts[0];
  if (texts.length === 2 && useParentheses) {
    const open = bracketStyle?.open ?? bracketStyle?.[0] ?? '(';
    const close = bracketStyle?.close ?? bracketStyle?.[1] ?? ')';
    const separator = delimiter && delimiter !== ' ' ? '' : ' ';
    return `${texts[0]}${separator}${open}${texts[1]}${close}`;
  }
  if (typeof delimiter !== 'string') throw invalidResult();
  return texts.join(delimiter);
};

/**
 * @param {Object} params
 * @param {Array} params.subtitles Captured source subtitles
 * @param {Object} params.providerResult Strict provider envelope
 * @param {string[]} params.languageIds Exact requested language IDs
 * @param {Array|null} params.chainItems Optional presentation chain
 * @returns {readonly Object[]} Identity-preserving translated rows
 */
export const buildTranslatedSubtitles = ({
  subtitles,
  providerResult,
  languageIds,
  chainItems,
  delimiter = ' ',
  useParentheses = false,
  bracketStyle = null,
}) => {
  if (providerResult?.schemaVersion !== 2
      || !Array.isArray(providerResult.rows)
      || providerResult.rows.length !== subtitles.length
      || !Array.isArray(providerResult.languageIds)
      || providerResult.languageIds.length !== languageIds.length
      || providerResult.languageIds.some((languageId, index) => languageId !== languageIds[index])) {
    throw invalidResult();
  }

  return Object.freeze(subtitles.map((originalSub, index) => {
    const providerRow = providerResult.rows[index];
    const sourceId = originalSub.originalId;
    if (typeof sourceId !== 'string' || providerRow?.sourceId !== sourceId) {
      throw invalidResult();
    }
    const translations = translationsForRow(providerRow, languageIds);
    const text = Array.isArray(chainItems) && chainItems.length > 0
      ? formatChain({ chainItems, originalText: originalSub.text, translations })
      : formatDefault({
          languageIds,
          translations,
          delimiter,
          useParentheses,
          bracketStyle,
        });
    if (typeof text !== 'string' || text.trim().length === 0) throw invalidResult();

    return Object.freeze({
      id: originalSub.id ?? originalSub.subtitle_id ?? index + 1,
      start: originalSub.start,
      end: originalSub.end,
      startTime: originalSub.startTime,
      endTime: originalSub.endTime,
      text,
      originalId: sourceId,
      sourceOrder: originalSub.sourceOrder ?? index,
      language: getLanguageCode(languageIds[0]),
    });
  }));
};
