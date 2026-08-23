/**
 * Shared single-shot Gemini document request used by the consolidation and summarization
 * services, which previously duplicated this whole flow line-for-line (differing only in the
 * prompt, the response schema, and the log/abort labels).
 */

import { getThinkingBudget } from '../../utils/thinkingBudgetUtils';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';
import { createRequestController, removeRequestController } from './requestManagement';
import { processStructuredJsonResponse, processTextResponse } from './responseProcessingService';

const freezeDeliveries = (deliveries) => Object.freeze(deliveries.map((delivery) => (
  Object.freeze({ ...delivery })
)));

const validChunkId = (value) => Number.isSafeInteger(value) && value > 0;
const validResultCode = (value) => (
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(value)
);

const freezeCompletedChunks = (chunks) => {
  const seen = new Set();
  return Object.freeze(chunks.map((chunk) => {
    if (!validChunkId(chunk?.chunkId)
        || seen.has(chunk.chunkId)
        || typeof chunk.text !== 'string'
        || chunk.text.trim().length === 0) {
      throw new TypeError('Completed document chunks must be unique and contain text');
    }
    seen.add(chunk.chunkId);
    return Object.freeze({ chunkId: chunk.chunkId, text: chunk.text });
  }));
};

const freezeFailures = (failures) => {
  const seen = new Set();
  return Object.freeze(failures.map((failure) => {
    if (!validChunkId(failure?.chunkId)
        || seen.has(failure.chunkId)
        || !validResultCode(failure.code)) {
      throw new TypeError('Document failures must name unique chunks and bounded codes');
    }
    seen.add(failure.chunkId);
    return Object.freeze({ chunkId: failure.chunkId, code: failure.code });
  }));
};

export const nativeDocumentDelivery = (result) => {
  if (typeof result?.acknowledge !== 'function') return Object.freeze([]);
  return freezeDeliveries([{
    jobId: result.job?.id ?? null,
    deliveryId: result.deliveryId ?? null,
    acknowledge: result.acknowledge,
  }]);
};

export const createCompleteDocumentResult = ({ text, deliveries = [], completedChunks = null }) => {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new TypeError('A completed document must contain text');
  }
  const chunks = completedChunks ?? [{ chunkId: 1, text }];
  return Object.freeze({
    status: 'complete',
    text,
    retryable: false,
    completedChunks: freezeCompletedChunks(chunks),
    failedChunkIds: Object.freeze([]),
    failures: Object.freeze([]),
    deliveries: freezeDeliveries(deliveries),
  });
};

export const createIncompleteDocumentResult = ({
  status,
  code,
  completedChunks = [],
  failures,
  deliveries = [],
}) => {
  if (status !== 'partial' && status !== 'refused') {
    throw new TypeError('An incomplete document result must be partial or refused');
  }
  if (!Array.isArray(failures) || failures.length === 0) {
    throw new TypeError('An incomplete document result must name its failed chunks');
  }
  if (!validResultCode(code)) {
    throw new TypeError('An incomplete document result must have a bounded code');
  }
  if ((status === 'partial' && completedChunks.length === 0)
      || (status === 'refused' && completedChunks.length !== 0)) {
    throw new TypeError('Document result status must agree with completed chunks');
  }
  const normalizedChunks = freezeCompletedChunks(completedChunks);
  const normalizedFailures = freezeFailures(failures);
  const completedIds = new Set(normalizedChunks.map(({ chunkId }) => chunkId));
  if (normalizedFailures.some(({ chunkId }) => completedIds.has(chunkId))) {
    throw new TypeError('A document chunk cannot be both complete and failed');
  }
  return Object.freeze({
    status,
    code,
    text: null,
    retryable: true,
    completedChunks: normalizedChunks,
    failedChunkIds: Object.freeze(normalizedFailures.map(({ chunkId }) => chunkId)),
    failures: normalizedFailures,
    deliveries: freezeDeliveries(deliveries),
  });
};

export const documentResultError = (result) => {
  const error = new Error('Document processing did not produce a complete result');
  error.name = 'DocumentProcessingError';
  error.code = result?.code || 'documentProcessingIncomplete';
  Object.defineProperty(error, 'documentResult', { value: result });
  return error;
};

/**
 * Resolve the processing language from localStorage.
 * When the user is working from translated subtitles, the translation target language is used;
 * otherwise we let the prompt drive the language (returns null).
 * @returns {string|null}
 */
export const resolveProcessingLanguage = () => {
  const translatedLanguage = localStorage.getItem('translation_target_language');
  const source = localStorage.getItem('current_processing_source');
  return source === 'translated' && translatedLanguage ? translatedLanguage : null;
};

/**
 * Run one structured-output Gemini document request.
 * @param {object} opts
 * @param {string} opts.subtitlesText - plain text to process
 * @param {string} opts.model - Gemini model id
 * @param {string|null} opts.customPrompt - optional prompt template ({subtitlesText} placeholder)
 * @param {(text: string, language: string|null) => string} opts.getDefaultPrompt - default prompt builder
 * @param {() => object} opts.createSchema - response-schema factory
 * @param {string} opts.errorLabel - console.error label on failure
 * @param {string} opts.abortMessage - Error message thrown when the request is aborted
 * @param {(result: object) => boolean} [opts.validateProcessedText] - owner-specific output check
 * @returns {Promise<object>} a complete or refused document result with native deliveries retained
 */
export const runGeminiDocumentRequestResult = async ({
  subtitlesText,
  model,
  customPrompt,
  getDefaultPrompt,
  createSchema,
  errorLabel,
  abortMessage,
  validateProcessedText,
}) => {
  const { requestId, signal } = createRequestController();

  try {
    const language = resolveProcessingLanguage();

    const documentPrompt = customPrompt
      ? customPrompt.replace('{subtitlesText}', subtitlesText)
      : getDefaultPrompt(subtitlesText, language);

    const responseSchema = createSchema();
    const thinking = getThinkingBudget(model);
    const result = await runNativeGeminiText({
      task: 'analyzeSubtitles',
      model,
      prompt: documentPrompt,
      responseJsonSchema: responseSchema,
      ...(typeof thinking === 'string' ? { thinkingLevel: thinking } : {}),
      signal,
    });
    const deliveries = nativeDocumentDelivery(result);
    let structured;
    let structuredParsed = false;
    try {
      structured = JSON.parse(result.text);
      structuredParsed = true;
    } catch {
      structured = null;
    }
    let processed;
    try {
      processed = structuredParsed
        ? processStructuredJsonResponse(structured, language)
        : processTextResponse(result.text);
    } catch (error) {
      if (typeof result?.text !== 'string' || result.text.trim().length === 0) {
        return createIncompleteDocumentResult({
          status: 'refused',
          code: 'emptyDocumentResult',
          failures: [{ chunkId: 1, code: 'emptyDocumentResult' }],
          deliveries,
        });
      }
      throw error;
    }

    const accepted = typeof processed === 'string'
      && processed.trim().length > 0
      && (typeof validateProcessedText !== 'function' || validateProcessedText({
        processedText: processed,
        structured,
        structuredParsed,
        rawText: result.text,
      }) === true);
    if (!accepted) {
      return createIncompleteDocumentResult({
        status: 'refused',
        code: 'emptyDocumentResult',
        failures: [{ chunkId: 1, code: 'emptyDocumentResult' }],
        deliveries,
      });
    }

    return createCompleteDocumentResult({ text: processed, deliveries });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(abortMessage);
    }
    console.error(errorLabel, error);
    throw error;
  } finally {
    removeRequestController(requestId);
  }
};

export const runGeminiDocumentRequest = async (options) => {
  const result = await runGeminiDocumentRequestResult(options);
  if (result.status !== 'complete') throw documentResultError(result);
  return result.text;
};
