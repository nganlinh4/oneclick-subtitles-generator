/**
 * Consolidation service for document processing.
 *
 * A generated document is complete only when every planned chunk produced usable output. Partial
 * provider success remains a typed, retryable result and is never converted into document text.
 */

import i18n from '../../i18n/i18n';
import { createConsolidationSchema } from '../../utils/schemaUtils';
import { getDefaultConsolidatePrompt } from './promptManagement';
import {
  createCompleteDocumentResult,
  createIncompleteDocumentResult,
  documentResultError,
  runGeminiDocumentRequestResult,
} from './documentRequest';
import { DEFAULT_GEMINI_MODEL_ID } from '../../config/geminiModels';

const WORDS_PER_MINUTE = 150;

const dispatchStatus = (phase, message) => {
  globalThis.window?.dispatchEvent(new CustomEvent('consolidation-status', {
    detail: { phase, message },
  }));
};

const validConsolidationOutput = ({ processedText, structured, structuredParsed }) => {
  if (typeof processedText !== 'string' || processedText.trim().length === 0) return false;
  if (!structuredParsed) return true;
  return structured !== null
    && typeof structured === 'object'
    && !Array.isArray(structured)
    && typeof structured.content === 'string'
    && structured.content.trim().length > 0;
};

const requestConsolidation = (subtitlesText, model, customPrompt) => (
  runGeminiDocumentRequestResult({
    subtitlesText,
    model,
    customPrompt,
    getDefaultPrompt: getDefaultConsolidatePrompt,
    createSchema: createConsolidationSchema,
    errorLabel: 'Document completion error:',
    abortMessage: 'Document completion request was aborted',
    validateProcessedText: validConsolidationOutput,
  })
);

const splitIntoChunks = (subtitlesText, splitDuration) => {
  const wordsPerChunk = WORDS_PER_MINUTE * splitDuration;
  const words = subtitlesText.split(/\s+/);
  const chunks = [];
  let currentChunk = [];

  for (let index = 0; index < words.length; index += 1) {
    currentChunk.push(words[index]);
    if (currentChunk.length >= wordsPerChunk && index < words.length - 1) {
      chunks.push(currentChunk.join(' '));
      currentChunk = [];
    }
  }
  if (currentChunk.length > 0) chunks.push(currentChunk.join(' '));
  return chunks;
};

const boundedFailureCode = (error) => (
  typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9]{0,127}$/.test(error.code)
    ? error.code
    : 'documentChunkFailed'
);

const completeDocumentByChunks = async (
  subtitlesText,
  model,
  customPrompt,
  splitDuration,
) => {
  const chunks = splitIntoChunks(subtitlesText, splitDuration);
  dispatchStatus('split', i18n.t(
    'consolidation.splitComplete',
    'Split text into {{chunks}} chunks',
    { chunks: chunks.length },
  ));

  const completedChunks = [];
  const failures = [];
  const deliveries = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunkId = index + 1;
    dispatchStatus('processing', i18n.t(
      'consolidation.processingChunk',
      'Processing chunk {{current}}/{{total}}',
      { current: chunkId, total: chunks.length },
    ));

    try {
      const result = await requestConsolidation(chunks[index], model, customPrompt);
      deliveries.push(...result.deliveries);
      if (result.status === 'complete') {
        completedChunks.push({ chunkId, text: result.text });
      } else {
        failures.push({ chunkId, code: result.code });
      }
    } catch (error) {
      console.error(`Error processing document chunk ${chunkId}:`, error);
      failures.push({ chunkId, code: boundedFailureCode(error) });
    }
  }

  if (failures.length > 0) {
    dispatchStatus('error', i18n.t(
      'consolidation.error',
      'Error processing document: {{message}}',
      { message: `Incomplete chunks: ${failures.map(({ chunkId }) => chunkId).join(', ')}` },
    ));
    return createIncompleteDocumentResult({
      status: completedChunks.length > 0 ? 'partial' : 'refused',
      code: completedChunks.length > 0 ? 'documentChunksIncomplete' : 'documentNoValidOutput',
      completedChunks,
      failures,
      deliveries,
    });
  }

  const text = completedChunks.map((chunk) => chunk.text).join('\n\n');
  if (text.trim().length === 0) {
    return createIncompleteDocumentResult({
      status: 'refused',
      code: 'documentNoValidOutput',
      failures: chunks.map((_, index) => ({
        chunkId: index + 1,
        code: 'emptyDocumentResult',
      })),
      deliveries,
    });
  }

  dispatchStatus('complete', i18n.t(
    'consolidation.processingComplete',
    'Processing completed for all {{count}} chunks',
    { count: chunks.length },
  ));
  return createCompleteDocumentResult({ text, completedChunks, deliveries });
};

/**
 * Produce a closed document result. Incomplete results retain successful chunk deliveries and
 * failed chunk IDs so the owning UI can retry without presenting or saving synthetic output.
 */
export const completeDocumentWithResult = async (
  subtitlesText,
  model = DEFAULT_GEMINI_MODEL_ID,
  customPrompt = null,
  splitDuration = 0,
) => {
  if (!subtitlesText || subtitlesText.trim() === '') {
    throw new Error('No text to process');
  }
  if (!Number.isFinite(splitDuration) || splitDuration < 0) {
    throw new TypeError('Split duration must be a finite non-negative number');
  }

  if (splitDuration > 0) {
    dispatchStatus('splitting', i18n.t(
      'consolidation.splittingText',
      'Splitting text into chunks of {{duration}} minutes',
      { duration: splitDuration },
    ));
    return completeDocumentByChunks(subtitlesText, model, customPrompt, splitDuration);
  }

  return requestConsolidation(subtitlesText, model, customPrompt);
};

/**
 * Compatibility facade for callers that still consume document text. It can unwrap only a complete
 * result; partial/refused generation rejects instead of masquerading as a successful document.
 */
export const completeDocument = async (...args) => {
  const result = await completeDocumentWithResult(...args);
  if (result.status !== 'complete') throw documentResultError(result);
  return result.text;
};
