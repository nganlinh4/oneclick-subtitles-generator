/**
 * Consolidation service for document processing
 * Handles document consolidation functionality
 */

import i18n from '../../i18n/i18n';
import { getLanguageCode } from '../../utils/languageUtils';
import { createConsolidationSchema, addResponseSchema } from '../../utils/schemaUtils';
import { addThinkingConfig } from '../../utils/thinkingBudgetUtils';
import { getDefaultConsolidatePrompt } from './promptManagement';
import { createRequestController, removeRequestController } from './requestManagement';
import { processStructuredJsonResponse, processTextResponse } from './responseProcessingService';

// Translation function shorthand
const t = (key, fallback) => i18n.t(key, fallback);

/**
 * Consolidate document from subtitles text
 * @param {string} subtitlesText - Plain text content from subtitles
 * @param {string} model - Gemini model to use
 * @param {string} customPrompt - Optional custom prompt to use
 * @param {number} splitDuration - Duration in minutes for each chunk (0 = no split)
 * @returns {Promise<string>} - Completed document text
 */
export const completeDocument = async (subtitlesText, model = 'gemini-2.0-flash', customPrompt = null, splitDuration = 0) => {
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

    // Create a unique ID for this request
    const { requestId, signal } = createRequestController();

    try {
        // Get API key from localStorage
        const apiKey = localStorage.getItem('gemini_api_key');
        if (!apiKey) {
            throw new Error(t('settings.geminiApiKeyRequired', 'Gemini API key not found'));
        }

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

        // Create the prompt for document completion
        let documentPrompt;

        // Try to detect the language of the subtitles
        // First check if we're using translated subtitles
        const translatedLanguage = localStorage.getItem('translation_target_language');

        // Get the source parameter indicating if we're using original or translated subtitles
        const source = localStorage.getItem('current_processing_source');

        // Determine the language based on the source
        let language = null;

        if (source === 'translated' && translatedLanguage) {
            // If we're using translated subtitles, use the target language of the translation
            language = translatedLanguage;

        } else {
            // For original subtitles, try to detect the language from the first few lines
            // This is a simple approach - in a production environment, you might want to use
            // a more sophisticated language detection library
            try {
                // In a future enhancement, we could get a sample of the text for language detection
                // const sampleText = subtitlesText.substring(0, 500);

                // For now, we'll rely on the language instruction in the prompt
                // A future enhancement could be to add actual language detection here
            } catch (error) {

            }
        }

        if (customPrompt) {
            // Replace variables in the custom prompt
            documentPrompt = customPrompt.replace('{subtitlesText}', subtitlesText);
        } else {
            documentPrompt = getDefaultConsolidatePrompt(subtitlesText, language);
        }

        // Create request data with structured output
        let requestData = {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: documentPrompt }
                    ]
                }
            ],
            generationConfig: {
                topK: 32,
                topP: 0.95,
                maxOutputTokens: 65536, // Increased to maximum allowed value (65536 per Gemini documentation)
            },
        };

        // Add language code to generation config if available
        if (language) {
            const languageCode = getLanguageCode(language);
            if (languageCode) {

                requestData.generationConfig.stopSequences = [];
                // Note: Gemini doesn't have a direct language parameter, but we can use this approach
                // to help guide the model to maintain the correct language
            }
        }

        // Always use structured output
        requestData = addResponseSchema(requestData, createConsolidationSchema());

        // Add thinking configuration if supported by the model
        requestData = addThinkingConfig(requestData, model);

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestData),
            signal: signal // Add the AbortController signal
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Gemini API error: ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();

        // Check if this is a structured JSON response
        if (data.candidates[0]?.content?.parts[0]?.structuredJson) {

            const structuredJson = data.candidates[0].content.parts[0].structuredJson;


            // Process the structured JSON response
            const processedResponse = processStructuredJsonResponse(structuredJson, language);

            // Remove this controller from the map after successful response
            removeRequestController(requestId);

            return processedResponse;
        }

        // Handle text response
        let completedText = data.candidates[0]?.content?.parts[0]?.text;

        // Process the text response
        const processedText = processTextResponse(completedText);

        // Remove this controller from the map after successful response
        removeRequestController(requestId);

        return processedText;
    } catch (error) {
        // Check if this is an AbortError
        if (error.name === 'AbortError') {

            throw new Error('Document completion request was aborted');
        } else {
            console.error('Document completion error:', error);
            // Remove this controller from the map on error
            if (requestId) {
                removeRequestController(requestId);
            }
            throw error;
        }
    }
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