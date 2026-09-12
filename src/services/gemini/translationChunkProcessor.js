/**
 * Owned, seek-independent chunk orchestration for subtitle translation.
 * A failed chunk is terminal metadata, never a fabricated translation row.
 */

import i18n from '../../i18n/i18n';
import { createTranslationAbortError } from '../../utils/translationOwnership';

export class PartialTranslationError extends Error {
  constructor(completedSubtitles, failedChunks) {
    super('Translation completed only partially');
    this.name = 'PartialTranslationError';
    this.code = 'translationPartial';
    this.completedSubtitles = Object.freeze(completedSubtitles.map((row) => Object.freeze({ ...row })));
    this.failedChunks = Object.freeze(failedChunks.map((failure) => Object.freeze({ ...failure })));
  }
}

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw createTranslationAbortError();
};

export const abortableTranslationDelay = (milliseconds, signal) => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError('A non-negative translation delay is required');
  }
  throwIfAborted(signal);
  if (milliseconds === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        signal?.removeEventListener?.('abort', handleAbort);
      } catch {
        // Cleanup cannot change the already-owned terminal result.
      }
      callback();
    };
    const handleAbort = () => finish(() => reject(createTranslationAbortError()));
    const timeout = setTimeout(() => finish(resolve), milliseconds);
    try {
      signal?.addEventListener?.('abort', handleAbort, { once: true });
    } catch {
      clearTimeout(timeout);
      reject(createTranslationAbortError());
    }
  });
};

const splitIntoDurationChunks = (subtitles, splitDuration) => {
  const splitDurationSeconds = splitDuration * 60;
  const chunks = [];
  let currentChunk = [];
  let chunkStartTime = subtitles[0]?.start ?? 0;
  subtitles.forEach((subtitle) => {
    if (subtitle.start - chunkStartTime > splitDurationSeconds && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      chunkStartTime = subtitle.start;
    }
    currentChunk.push(subtitle);
  });
  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
};

const errorCodeForChunk = (error) => {
  const candidate = typeof error?.code === 'string' ? error.code : 'translationChunkFailed';
  return /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(candidate)
    ? candidate
    : 'translationChunkFailed';
};

/**
 * @param {Array} subtitles
 * @param {string|Array} targetLanguage
 * @param {string} model
 * @param {string|null} customPrompt
 * @param {number} splitDuration
 * @param {boolean} includeRules
 * @param {string|null} delimiter
 * @param {boolean} useParentheses
 * @param {Object|null} bracketStyle
 * @param {Array|null} chainItems
 * @param {number} restTime
 * @param {string|null} fileContext
 * @param {Function} translateChunk
 * @param {{signal?: AbortSignal, assertOwned?: Function, publishStatus?: Function}} ownership
 */
const translateSubtitlesByChunks = async (
  subtitles,
  targetLanguage,
  model,
  customPrompt,
  splitDuration,
  includeRules = false,
  delimiter = ' ',
  useParentheses = false,
  bracketStyle = null,
  chainItems = null,
  restTime = 0,
  fileContext = null,
  translateChunk,
  ownership = {}
) => {
  if (typeof translateChunk !== 'function') {
    throw new TypeError('translateSubtitlesByChunks requires a translateChunk callback');
  }
  const { signal, assertOwned = async () => {}, publishStatus = async () => {} } = ownership;
  const assertBoundary = async () => {
    throwIfAborted(signal);
    await assertOwned();
    throwIfAborted(signal);
  };
  await assertBoundary();
  const chunks = splitIntoDurationChunks(subtitles, splitDuration);
  const splitMessage = i18n.t(
    'translation.splitComplete',
    'Split {{count}} subtitles into {{chunks}} chunks',
    { count: subtitles.length, chunks: chunks.length }
  );
  await publishStatus(fileContext ? `[${fileContext}] ${splitMessage}` : splitMessage);

  // Chunks are independent provider requests. Launch every customer-requested chunk rather than
  // silently imposing a one-request throttle; credential admission and provider cooldowns remain
  // the authoritative limits. `restTime` is a start stagger, not a global serialization switch.
  const outcomes = await Promise.all(chunks.map(async (chunk, index) => {
    if (restTime > 0 && index > 0) {
      await abortableTranslationDelay(index * restTime * 1_000, signal);
    }
    await assertBoundary();
    const chunkMessage = i18n.t(
      'translation.translatingChunk',
      'Translating chunk {{current}}/{{total}} with {{count}} subtitles',
      { current: index + 1, total: chunks.length, count: chunk.length }
    );
    await publishStatus(fileContext ? `[${fileContext}] ${chunkMessage}` : chunkMessage);
    try {
      await assertBoundary();
      const translated = await translateChunk(
        chunk,
        targetLanguage,
        model,
        customPrompt,
        0,
        includeRules,
        delimiter,
        useParentheses,
        bracketStyle,
        chainItems
      );
      await assertBoundary();
      if (!Array.isArray(translated) || translated.length !== chunk.length) {
        const mismatch = new Error('Translation chunk result count did not match its source');
        mismatch.code = 'translationChunkCountMismatch';
        throw mismatch;
      }
      return { index, translated, failure: null };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'translationAborted') {
        throw createTranslationAbortError();
      }
      const sourceOrders = chunk.map((subtitle) => subtitle.sourceOrder)
        .filter((order) => Number.isSafeInteger(order) && order >= 0);
      return {
        index,
        translated: [],
        failure: {
          chunkIndex: index,
          startOrder: sourceOrders.length > 0 ? Math.min(...sourceOrders) : index,
          endOrder: sourceOrders.length > 0 ? Math.max(...sourceOrders) : index,
          errorCode: errorCodeForChunk(error),
        },
      };
    }
  }));

  await assertBoundary();
  outcomes.sort((left, right) => left.index - right.index);
  const completed = outcomes.flatMap(({ translated }) => translated);
  const failedChunks = outcomes.flatMap(({ failure }) => failure === null ? [] : [failure]);
  if (failedChunks.length > 0) throw new PartialTranslationError(completed, failedChunks);
  const completionMessage = i18n.t(
    'translation.translationComplete',
    'Translation completed for all {{count}} chunks',
    { count: chunks.length }
  );
  await publishStatus(fileContext ? `[${fileContext}] ${completionMessage}` : completionMessage);
  return completed;
};

export { translateSubtitlesByChunks };
