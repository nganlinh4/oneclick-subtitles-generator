/**
 * Summarization service for document processing
 * Handles document summarization functionality
 */

import { createSummarizationSchema } from '../../utils/schemaUtils';
import { getDefaultSummarizePrompt } from './promptManagement';
import { runGeminiDocumentRequest } from './documentRequest';
import { DEFAULT_GEMINI_MODEL_ID } from '../../config/geminiModels';

/**
 * Summarize document from subtitles text
 * @param {string} subtitlesText - Plain text content from subtitles
 * @param {string} model - Gemini model to use
 * @param {string} customPrompt - Optional custom prompt to use
 * @returns {Promise<string>} - Summarized document text
 */
export const summarizeDocument = async (subtitlesText, model = DEFAULT_GEMINI_MODEL_ID, customPrompt = null) => {
    if (!subtitlesText || subtitlesText.trim() === '') {
        throw new Error('No text to process');
    }

    return runGeminiDocumentRequest({
        subtitlesText,
        model,
        customPrompt,
        getDefaultPrompt: getDefaultSummarizePrompt,
        createSchema: createSummarizationSchema,
        errorLabel: 'Summary error:',
        abortMessage: 'Summary request was aborted',
    });
};
