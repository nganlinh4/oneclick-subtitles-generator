/**
 * Shared single-shot Gemini document request used by the consolidation and summarization
 * services, which previously duplicated this whole flow line-for-line (differing only in the
 * prompt, the response schema, and the log/abort labels).
 */

import { addResponseSchema } from '../../utils/schemaUtils';
import { addThinkingConfig } from '../../utils/thinkingBudgetUtils';
import { createRequestController, removeRequestController } from './requestManagement';
import { processStructuredJsonResponse, processTextResponse } from './responseProcessingService';
import { fetchWithKeyRotation } from './withKeyRotation';

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
 * @returns {Promise<string>} processed document text
 */
export const runGeminiDocumentRequest = async ({
  subtitlesText,
  model,
  customPrompt,
  getDefaultPrompt,
  createSchema,
  errorLabel,
  abortMessage,
}) => {
  const { requestId, signal } = createRequestController();

  try {
    const language = resolveProcessingLanguage();

    const documentPrompt = customPrompt
      ? customPrompt.replace('{subtitlesText}', subtitlesText)
      : getDefaultPrompt(subtitlesText, language);

    let requestData = {
      contents: [{ role: 'user', parts: [{ text: documentPrompt }] }]
    };

    requestData = addResponseSchema(requestData, createSchema());
    requestData = addThinkingConfig(requestData, model);

    const response = await fetchWithKeyRotation((apiKey) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestData),
        signal,
      })
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Gemini API error: ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const part = data.candidates[0]?.content?.parts[0];

    const processed = part?.structuredJson
      ? processStructuredJsonResponse(part.structuredJson, language)
      : processTextResponse(part?.text);

    removeRequestController(requestId);
    return processed;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(abortMessage);
    }
    console.error(errorLabel, error);
    if (requestId) {
      removeRequestController(requestId);
    }
    throw error;
  }
};
