/**
 * Consolidation service for document processing
 * Handles document consolidation functionality
 */

import i18n from '../../i18n/i18n';
import { createConsolidationSchema } from '../../utils/schemaUtils';
import { getDefaultConsolidatePrompt } from './promptManagement';
import { runGeminiDocumentRequest } from './documentRequest';
import { DEFAULT_GEMINI_MODEL_ID } from '../../config/geminiModels';

/**
 * Consolidate document from subtitles text
 * @param {string} subtitlesText - Plain text content from subtitles
 * @param {string} model - Gemini model to use
 * @param {string} customPrompt - Optional custom prompt to use
 * @param {number} splitDuration - Duration in minutes for each chunk (0 = no split)
 * @returns {Promise<string>} - Completed document text
 */
export const completeDocument = async (subtitlesText, model = DEFAULT_GEMINI_MODEL_ID, customPrompt = null, splitDuration = 0) => {
    if (!subtitlesText || subtitlesText.trim() === '') {
        throw new Error('No text to process');
    }

    // If splitDuration is specified and not 0, split text into chunks
    if (splitDuration > 0) {
        // Dispatch event to update UI with status
        window.dispatchEvent(new CustomEvent('consolidation-status', {
            detail: { message: i18n.t('consolidation.splittingText', 'Splitting text into chunks of {{duration}} minutes', {
                duration: splitDuration
            }) }
        }));
        return await completeDocumentByChunks(subtitlesText, model, customPrompt, splitDuration);
    }

    return runGeminiDocumentRequest({
        subtitlesText,
        model,
        customPrompt,
        getDefaultPrompt: getDefaultConsolidatePrompt,
        createSchema: createConsolidationSchema,
        errorLabel: 'Document completion error:',
        abortMessage: 'Document completion request was aborted',
    });
};

/**
 * Split text into chunks based on approximate word count and process each chunk
 * @param {string} subtitlesText - Plain text content from subtitles
 * @param {string} model - Gemini model to use
 * @param {string} customPrompt - Optional custom prompt to use
 * @param {number} splitDuration - Duration in minutes for each chunk
 * @returns {Promise<string>} - Completed document text with all chunks combined
 */
const completeDocumentByChunks = async (subtitlesText, model, customPrompt, splitDuration) => {
    // Estimate words per minute for reading (average speaking rate)
    const WORDS_PER_MINUTE = 150;

    // Calculate approximate word count per chunk based on duration
    const wordsPerChunk = WORDS_PER_MINUTE * splitDuration;

    // Split text into words
    const words = subtitlesText.split(/\s+/);

    // Group words into chunks
    const chunks = [];
    let currentChunk = [];

    for (let i = 0; i < words.length; i++) {
        currentChunk.push(words[i]);

        // Start a new chunk when we reach the word limit
        if (currentChunk.length >= wordsPerChunk && i < words.length - 1) {
            chunks.push(currentChunk.join(' '));
            currentChunk = [];
        }
    }

    // Add the last chunk if it's not empty
    if (currentChunk.length > 0) {
        chunks.push(currentChunk.join(' '));
    }



    // Dispatch event to update UI with status
    const splitMessage = i18n.t('consolidation.splitComplete', 'Split text into {{chunks}} chunks', {
        chunks: chunks.length
    });
    window.dispatchEvent(new CustomEvent('consolidation-status', {
        detail: { message: splitMessage }
    }));

    // Process each chunk
    const processedChunks = [];

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Dispatch event to update UI with status
        const chunkMessage = i18n.t('consolidation.processingChunk', 'Processing chunk {{current}}/{{total}}', {
            current: i + 1,
            total: chunks.length
        });
        window.dispatchEvent(new CustomEvent('consolidation-status', {
            detail: { message: chunkMessage }
        }));

        try {
            // Call completeDocument with the current chunk, but with splitDuration=0 to avoid infinite recursion
            const processedChunk = await completeDocument(chunk, model, customPrompt, 0);
            processedChunks.push(processedChunk);
        } catch (error) {
            console.error(`Error processing chunk ${i + 1}:`, error);
            // If a chunk fails, add the original text to maintain the structure
            processedChunks.push(`[Processing failed] ${chunk.substring(0, 100)}...`);
        }
    }

    // Dispatch event to update UI with completion status
    const completionMessage = i18n.t('consolidation.processingComplete', 'Processing completed for all {{count}} chunks', {
        count: chunks.length
    });
    window.dispatchEvent(new CustomEvent('consolidation-status', {
        detail: { message: completionMessage }
    }));

    // Combine all processed chunks


    // Check if any chunks are empty or very short
    const validChunks = processedChunks.filter(chunk => chunk && chunk.trim().length > 10);
    if (validChunks.length < processedChunks.length) {

    }

    // If we have no valid chunks, return a message
    if (validChunks.length === 0) {
        return 'The consolidation process did not produce any valid output. Please try again with different settings.';
    }

    // Process each chunk to extract content
    const processedTextChunks = validChunks.map(chunk => {


        // Check if the chunk looks like JSON
        if (chunk.trim().startsWith('{') && chunk.trim().endsWith('}')) {
            try {
                // Try to parse as JSON
                const jsonData = JSON.parse(chunk);


                // Extract content field if it exists
                if (jsonData.content) {

                    return jsonData.content;
                } else if (jsonData.text) {

                    return jsonData.text;
                } else if (jsonData.document) {

                    return jsonData.document;
                } else {
                    // If no content field, stringify the entire object

                    return JSON.stringify(jsonData);
                }
            } catch (error) {

                // If parsing fails, return the original chunk
                return chunk;
            }
        }

        // Check for JSON code blocks
        const jsonBlockMatch = chunk.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonBlockMatch && jsonBlockMatch[1]) {
            try {
                const jsonData = JSON.parse(jsonBlockMatch[1].trim());


                // Extract content field if it exists
                if (jsonData.content) {

                    return jsonData.content;
                } else if (jsonData.text) {

                    return jsonData.text;
                } else if (jsonData.document) {

                    return jsonData.document;
                } else {
                    // If no content field, use the entire JSON block content
                    return jsonBlockMatch[1].trim();
                }
            } catch (error) {

                // If parsing fails, remove the code block markers
                return jsonBlockMatch[1].trim();
            }
        }

        // If not JSON, return the original chunk
        return chunk;
    });

    // Filter out any empty chunks after processing
    const nonEmptyChunks = processedTextChunks.filter(chunk => chunk && chunk.trim().length > 0);
    if (nonEmptyChunks.length === 0) {

        return validChunks.join('\n\n');
    }

    // Join the processed chunks into a single text

    return nonEmptyChunks.join('\n\n');
};
