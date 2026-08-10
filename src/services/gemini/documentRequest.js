/**
 * Shared single-shot Gemini document request used by the consolidation and summarization
 * services, which previously duplicated this whole flow line-for-line (differing only in the
 * prompt, the response schema, and the log/abort labels).
 */

import { getThinkingBudget } from '../../utils/thinkingBudgetUtils';
import { runNativeGeminiText } from '../../platform/nativeGeminiText';
import { createRequestController, removeRequestController } from './requestManagement';
import { processStructuredJsonResponse, processTextResponse } from './responseProcessingService';

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
    let structured;
    try {
      structured = JSON.parse(result.text);
    } catch {
      structured = null;
    }
    const processed = structured === null
      ? processTextResponse(result.text)
      : processStructuredJsonResponse(structured, language);

    return processed;
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
