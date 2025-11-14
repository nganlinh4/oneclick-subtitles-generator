/**
 * Language detection functionality for Gemini API
 */

import { createLanguageDetectionSchema, addResponseSchema } from '../../utils/schemaUtils';
import i18n from '../../i18n/i18n';

// Translation function shorthand
const t = (key, fallback) => i18n.t(key, fallback);

/**
 * Detect language of text using Gemini API
 * @param {Array} subtitles - Array of subtitles to detect language from
 * @param {string} source - Source of subtitles ('original' or 'translated')
 * @param {string} model - Gemini model to use
 * @returns {Promise<Object>} - Language detection result
 */
export const detectSubtitleLanguage = async (subtitles, source = 'original', model = 'gemini-flash-lite-latest') => {
    if (!subtitles || subtitles.length === 0) {

        return {
            languageCode: 'en',
            languageName: 'English',
            isMultiLanguage: false,
            secondaryLanguages: []
        };
    }

    try {
        // Get API key from localStorage
        const apiKey = localStorage.getItem('gemini_api_key');
        if (!apiKey) {
            throw new Error(t('settings.geminiApiKeyRequired', 'Gemini API key not found'));
        }

        // Take the first 3 subtitles for language detection
        const sampleSubtitles = subtitles.slice(0, 3);
        const sampleText = sampleSubtitles.map(subtitle => subtitle.text).join('\n');

        // Create the prompt for language detection
        const detectionPrompt = `Analyze the following text and determine its language. Identify the primary language and any secondary languages if present.

Text to analyze:
"""
${sampleText}
"""`;

        // Create request data with structured output
        let requestData = {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: detectionPrompt }
                    ]
                }
            ],
            generationConfig: {
                topK: 16,
                topP: 0.8,
                maxOutputTokens: 1024,
            },
        };

        // Add response schema
        requestData = addResponseSchema(requestData, createLanguageDetectionSchema());


        // Dispatch event to update UI with status
        window.dispatchEvent(new CustomEvent('language-detection-status', {
            detail: {
                message: i18n.t('narration.detectingLanguage', 'Detecting language...'),
                source: source
            }
        }));

        // Call the Gemini API
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestData)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`Gemini API error: ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();


        // Extract the language detection result
        let result;
        try {
            // Parse the structured output
            if (data.candidates && data.candidates[0] && data.candidates[0].content) {
                const parts = data.candidates[0].content.parts;
                if (parts && parts.length > 0 && parts[0].functionCall) {
                    result = parts[0].functionCall.args;

                } else if (parts && parts.length > 0 && parts[0].text) {
                    // Try to parse JSON from text response
                    try {
                        const jsonMatch = parts[0].text.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            result = JSON.parse(jsonMatch[0]);

                        }
                    } catch (e) {
                        console.error('Error parsing JSON from text response:', e);
                    }
                }
            }

            // If we couldn't parse the result, use a default
            if (!result) {
                console.warn('Could not parse language detection result, using default');
                result = {
                    languageCode: 'en',
                    languageName: 'English',
                    isMultiLanguage: false,
                    secondaryLanguages: []
                };
            }
        } catch (error) {
            console.error('Error extracting language detection result:', error);
            throw error;
        }

        // Dispatch event to update UI with result
        window.dispatchEvent(new CustomEvent('language-detection-complete', {
            detail: {
                result,
                source: source
            }
        }));

        return result;
    } catch (error) {
        console.error('Error detecting language:', error);

        // Dispatch event to update UI with error
        window.dispatchEvent(new CustomEvent('language-detection-error', {
            detail: {
                error: error.message,
                source: source
            }
        }));

        // Return a default result
        return {
            languageCode: 'en',
            languageName: 'English',
            isMultiLanguage: false,
            secondaryLanguages: []
        };
    }
};

/**
 * Get appropriate narration model for a language
 * This is a synchronous fallback function that doesn't check actual availability
 * @param {string|Array} languageCode - ISO 639-1 language code or array of codes
 * @returns {string} - Model ID for the language
 */
export const getNarrationModelForLanguage = (languageCode) => {
    // Default to base model
    let modelId = 'f5tts-v1-base';

    // If we have an array of language codes, use the first one that has a specific model
    if (Array.isArray(languageCode) && languageCode.length > 0) {
        // Priority languages that have specific models
        const priorityLanguages = ['vi', 'zh', 'en', 'ko', 'ja'];

        // Try to find a priority language in the array
        for (const lang of priorityLanguages) {
            if (languageCode.includes(lang)) {
                return getNarrationModelForLanguage(lang);
            }
        }

        // If no priority language found, use the first language in the array
        return getNarrationModelForLanguage(languageCode[0]);
    }

    // Map language codes to appropriate models
    // This is a simplified mapping that doesn't check actual availability
    switch (languageCode) {
        case 'zh':
            modelId = 'f5tts-v1-base'; // Chinese is well-supported by base model
            break;
        case 'en':
            modelId = 'f5tts-v1-base'; // English is well-supported by base model
            break;
        case 'vi':
            modelId = 'erax-smile-unixsex-f5'; // Vietnamese model
            break;
        case 'ko':
            modelId = 'f5tts-v1-base'; // Korean - fallback to base model
            break;
        case 'ja':
            modelId = 'f5tts-v1-base'; // Japanese - fallback to base model
            break;
        default:
            // For other languages, use the base model
            modelId = 'f5tts-v1-base';
    }

    return modelId;
};
