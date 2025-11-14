/**
 * Utility functions for creating response schemas for Gemini API
 */

import { createVideoAnalysisSchema } from './videoAnalysisSchema';

/**
 * Creates a schema for language detection
 * @returns {Object} Schema for language detection
 */
export const createLanguageDetectionSchema = () => {
    return {
        type: "object",
        properties: {
            languageCode: {
                type: "string",
                description: "ISO 639-1 language code (e.g., 'en', 'vi', 'ko', 'zh', etc.)"
            },
            languageName: {
                type: "string",
                description: "Full language name in English (e.g., 'English', 'Vietnamese', 'Korean', 'Chinese')"
            },
            isMultiLanguage: {
                type: "boolean",
                description: "Whether the text contains multiple languages"
            },
            secondaryLanguages: {
                type: "array",
                items: {
                    type: "string",
                    description: "ISO 639-1 language codes of secondary languages if multi-language"
                },
                description: "Secondary language codes if multi-language is true"
            }
        },
        required: ["languageCode", "languageName", "isMultiLanguage"],
        propertyOrdering: ["languageCode", "languageName", "isMultiLanguage", "secondaryLanguages"]
    };
};

/**
 * Creates a schema for subtitle transcription
 * @param {boolean} isUserProvided - Whether the subtitles are user-provided
 * @returns {Object} Schema for subtitle transcription
 */
export const createSubtitleSchema = (isUserProvided = false) => {
    if (isUserProvided) {
        // For user-provided subtitles, simple schema to avoid complexity errors
        return {
            type: "array",
            items: {
                type: "object",
                properties: {
                    index: {
                        type: "integer",
                        description: "Index from the provided list (0-based)"
                    },
                    startTime: {
                        type: "string",
                        description: "Start time in MMmSSsNNNms format"
                    },
                    endTime: {
                        type: "string",
                        description: "End time in MMmSSsNNNms format"
                    },
                    text: {
                        type: "string",
                        description: "Exact text from the provided list"
                    }
                },
                required: ["index", "startTime", "endTime", "text"],
                propertyOrdering: ["index", "startTime", "endTime", "text"]
            }
        };
    } else {
        // For normal transcription, we need the full schema
        return {
            type: "array",
            items: {
                type: "object",
                properties: {
                    startTime: {
                        type: "string",
                        description: "Start time in format MMmSSsNNNms (e.g., '00m00s500ms')"
                    },
                    endTime: {
                        type: "string",
                        description: "End time in format MMmSSsNNNms (e.g., '00m01s000ms')"
                    },
                    text: {
                        type: "string",
                        description: "Transcribed text content"
                    }
                },
                required: ["startTime", "endTime", "text"],
                propertyOrdering: ["startTime", "endTime", "text"]
            }
        };
    }
};

/**
 * Creates a schema for subtitle translation
 * @param {boolean} multiLanguage - Whether multiple languages are being translated
 * @returns {Object} Schema for subtitle translation
 */
export const createTranslationSchema = (multiLanguage = false) => {
    if (multiLanguage) {
        return {
            type: "object",
            properties: {
                translations: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            language: {
                                type: "string",
                                description: "Target language for this translation"
                            },
                            texts: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        original: {
                                            type: "string",
                                            description: "Original text of the subtitle"
                                        },
                                        translated: {
                                            type: "string",
                                            description: "Translated text for the subtitle"
                                        }
                                    },
                                    required: ["original", "translated"],
                                    propertyOrdering: ["original", "translated"]
                                }
                            }
                        },
                        required: ["language", "texts"],
                        propertyOrdering: ["language", "texts"]
                    }
                }
            },
            required: ["translations"],
            propertyOrdering: ["translations"]
        };
    } else {
        // Updated schema for single language translation to include original text
        return {
            type: "array",
            items: {
                type: "object",
                properties: {
                    original: {
                        type: "string",
                        description: "Original text of the subtitle"
                    },
                    translated: {
                        type: "string",
                        description: "Translated text for the subtitle"
                    }
                },
                required: ["original", "translated"],
                propertyOrdering: ["original", "translated"]
            }
        };
    }
};

/**
 * Creates a schema for document consolidation
 * @returns {Object} Schema for document consolidation
 */
export const createConsolidationSchema = () => {
    return {
        type: "object",
        properties: {
            title: {
                type: "string",
                description: "Document title"
            },
            content: {
                type: "string",
                description: "Consolidated document content"
            }
        },
        required: ["title", "content"],
        propertyOrdering: ["title", "content"]
    };
};

/**
 * Creates a schema for document summarization
 * @returns {Object} Schema for document summarization
 */
export const createSummarizationSchema = () => {
    return {
        type: "object",
        properties: {
            summary: {
                type: "string",
                description: "Document summary"
            },
            keyPoints: {
                type: "array",
                items: {
                    type: "string"
                },
                description: "Key points from the document"
            }
        },
        required: ["summary", "keyPoints"],
        propertyOrdering: ["summary", "keyPoints"]
    };
};

/**
 * Adds response schema configuration to a Gemini API request
 * @param {Object} requestData - The original request data
 * @param {Object} schema - The schema to apply
 * @returns {Object} Updated request data with schema
 */
export const addResponseSchema = (requestData, schema, isUserProvided = false) => {
    return {
        ...requestData,
        generationConfig: {
            ...(requestData.generationConfig || {}),
            topK: isUserProvided ? 1 : 32,
            topP: isUserProvided ? 0.5 : 0.95,
            maxOutputTokens: 65536,
            responseMimeType: 'application/json',
            responseSchema: schema
        }
    };
};

// Export the video analysis schema
export { createVideoAnalysisSchema };