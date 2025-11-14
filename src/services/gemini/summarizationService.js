/**
 * Summarization service for document processing
 * Handles document summarization functionality
 */

import i18n from '../../i18n/i18n';
import { getLanguageCode } from '../../utils/languageUtils';
import { createSummarizationSchema, addResponseSchema } from '../../utils/schemaUtils';
import { addThinkingConfig } from '../../utils/thinkingBudgetUtils';
import { getDefaultSummarizePrompt } from './promptManagement';
import { createRequestController, removeRequestController } from './requestManagement';
import { processStructuredJsonResponse, processTextResponse } from './responseProcessingService';

// Translation function shorthand
const t = (key, fallback) => i18n.t(key, fallback);

/**
 * Summarize document from subtitles text
 * @param {string} subtitlesText - Plain text content from subtitles
 * @param {string} model - Gemini model to use
 * @param {string} customPrompt - Optional custom prompt to use
 * @returns {Promise<string>} - Summarized document text
 */
export const summarizeDocument = async (subtitlesText, model = 'gemini-2.0-flash', customPrompt = null) => {
    if (!subtitlesText || subtitlesText.trim() === '') {
        throw new Error('No text to process');
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

        // Create the prompt for document summarization
        let summaryPrompt;

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
            summaryPrompt = customPrompt.replace('{subtitlesText}', subtitlesText);
        } else {
            summaryPrompt = getDefaultSummarizePrompt(subtitlesText, language);
        }

        // Create request data with structured output
        let requestData = {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: summaryPrompt }
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
        requestData = addResponseSchema(requestData, createSummarizationSchema());

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
        let summarizedText = data.candidates[0]?.content?.parts[0]?.text;
        
        // Process the text response
        const processedText = processTextResponse(summarizedText);
        
        // Remove this controller from the map after successful response
        removeRequestController(requestId);

        return processedText;
    } catch (error) {
        // Check if this is an AbortError
        if (error.name === 'AbortError') {

            throw new Error('Summary request was aborted');
        } else {
            console.error('Summary error:', error);
            // Remove this controller from the map on error
            if (requestId) {
                removeRequestController(requestId);
            }
            throw error;
        }
    }
};
