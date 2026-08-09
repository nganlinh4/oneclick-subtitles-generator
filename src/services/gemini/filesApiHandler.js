/**
 * Non-streaming Gemini Files-API request path for subtitle transcription.
 * Split out of core.js for maintainability. Behavior preserved verbatim.
 */

import { parseGeminiResponse } from '../../utils/subtitle';
import {
    createSubtitleSchema,
    addResponseSchema
} from '../../utils/schemaUtils';
import { getTranscriptionPrompt } from './promptManagement';
import { resolveGeminiFileCache } from './fileCache';
import {
    createRequestController,
    removeRequestController
} from './requestManagement';
import i18n from '../../i18n/i18n';
import { addThinkingConfig } from '../../utils/thinkingBudgetUtils';
import { uploadFileToGemini } from './filesApi';
import { supportsMediaResolution } from './modelCapabilities';
import { DEFAULT_TRANSCRIPTION_MODEL_ID, normalizeMediaModelId } from '../../config/geminiModels';

/**
 * Call the Gemini API using Files API for better performance and caching
 * @param {File} file - Input file
 * @param {Object} options - Additional options
 * @returns {Promise<Array>} - Array of subtitles
 */
export const callGeminiApiWithFilesApi = async (file, options = {}, retryCount = 0) => {
    const { userProvidedSubtitles, modelId, videoMetadata, mediaResolution } = options;
    const MODEL = normalizeMediaModelId(
        modelId || localStorage.getItem('gemini_model'),
        DEFAULT_TRANSCRIPTION_MODEL_ID
    );

    console.log(`[GeminiAPI] Using Files API with model: ${MODEL}`);

    let fileKey; // <-- Moved declaration to the function's scope

    try {
        // Check if we already have an uploaded file URI for this file
        // Use different caching strategies for uploaded vs downloaded videos
        // let fileKey; // <-- Removed original declaration from here
        const __cache = await resolveGeminiFileCache(file, '[GeminiAPI]');
        fileKey = __cache.fileKey;
        let uploadedFile = __cache.uploadedFile;
        let shouldUpload = !uploadedFile || !uploadedFile.uri || retryCount > 0;

        if (uploadedFile && uploadedFile.uri && retryCount === 0) {
            console.log('Reusing existing uploaded file URI:', uploadedFile.uri);
            // Dispatch event to update status if needed
            window.dispatchEvent(new CustomEvent('gemini-file-reused', {
                detail: { fileName: file.name, uri: uploadedFile.uri }
            }));
        }

        if (shouldUpload) {
            // Upload file to Gemini Files API
            console.log(retryCount > 0 ? 'Re-uploading expired file to Gemini Files API...' : 'Uploading file to Gemini Files API...');
            // Dispatch event to update status if needed
            window.dispatchEvent(new CustomEvent('gemini-file-uploading', {
                detail: { fileName: file.name, isRetry: retryCount > 0 }
            }));

            uploadedFile = await uploadFileToGemini(file, `${file.name}_${Date.now()}`);
            console.log('File uploaded successfully:', uploadedFile.uri);

            // Cache the uploaded file info for reuse
            localStorage.setItem(fileKey, JSON.stringify(uploadedFile));

            // Dispatch event to update status
            window.dispatchEvent(new CustomEvent('gemini-file-uploaded', {
                detail: { fileName: file.name, uri: uploadedFile.uri, isRetry: retryCount > 0 }
            }));
        }

        // Determine content type
        const isAudio = file.type.startsWith('audio/');
        const contentType = isAudio ? 'audio' : 'video';

        // Check if we have user-provided subtitles
        const isUserProvided = userProvidedSubtitles && userProvidedSubtitles.trim() !== '';

        // Get the transcription prompt
        const segmentInfo = options?.segmentInfo || {};
        const promptText = getTranscriptionPrompt(contentType, userProvidedSubtitles, { segmentInfo });

        // Create request data
        let requestData = {
            model: MODEL,
            contents: [
                {
                    role: "user",
                    parts: [
                        {
                            file_data: {
                                file_uri: uploadedFile.uri,
                                mime_type: uploadedFile.mimeType
                            }
                        },
                        { text: promptText }
                    ]
                }
            ]
        };

        // Add video metadata if provided (ONLY for video files, NOT for audio files)
        if (videoMetadata && !isAudio) {
            console.log('[GeminiAPI] Adding video metadata to request:', JSON.stringify(videoMetadata, null, 2));
            // Add video metadata to the file_data part (now at index 0 since video is first)
            requestData.contents[0].parts[0].video_metadata = videoMetadata;
            console.log('[GeminiAPI] Request structure with video_metadata:', JSON.stringify(requestData.contents[0].parts[0], null, 2));
        } else if (isAudio && videoMetadata) {
            console.log('[GeminiAPI] Skipping video metadata for audio file to prevent 500 errors');
        }

        // Add response schema
        requestData = addResponseSchema(requestData, createSubtitleSchema(isUserProvided), isUserProvided);

        // Add thinking configuration if supported by the model
        requestData = addThinkingConfig(requestData, MODEL);

        // Add generation config with media resolution if provided (only for supported models)
        if (mediaResolution && supportsMediaResolution(MODEL)) {
            if (!requestData.generationConfig) {
                requestData.generationConfig = {};
            }
            requestData.generationConfig.mediaResolution = mediaResolution;
        } else if (mediaResolution && !supportsMediaResolution(MODEL)) {
            console.log('[GeminiAPI] Skipping media resolution for unsupported model:', MODEL);
        }

        // Store user-provided subtitles if needed
        if (isUserProvided) {
            localStorage.setItem('user_provided_subtitles', userProvidedSubtitles);
        }

        // Create request controller
        const { requestId, signal } = createRequestController();

        try {
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${uploadedFile.apiKey || localStorage.getItem('gemini_api_key')}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestData),
                    signal: signal
                }
            );

            if (!response.ok) {
                const errorData = await response.json();
                const errorMessage = errorData.error?.message || response.statusText;

                // Check if this is a file permission error (expired or deleted file)
                if (response.status === 403 &&
                    (errorMessage.includes('PERMISSION_DENIED') ||
                     errorMessage.includes('You do not have permission to access the File') ||
                     errorMessage.includes('it may not exist'))) {

                    console.warn('[GeminiAPI] Cached file URI is no longer valid (403 error), clearing cache...');

                    // Clear the invalid cached URI
                    localStorage.removeItem(fileKey);

                    // Retry only once to avoid infinite loops
                    if (retryCount === 0) {
                        console.log('[GeminiAPI] Retrying with fresh file upload...');
                        removeRequestController(requestId);
                        // Retry the entire operation with fresh upload
                        return await callGeminiApiWithFilesApi(file, options, retryCount + 1);
                    } else {
                        console.error('[GeminiAPI] Failed after retry, giving up');
                        throw new Error(`API error: ${errorMessage}`);
                    }
                }

                throw new Error(`API error: ${errorMessage}`);
            }

            const data = await response.json();
            removeRequestController(requestId);
            return parseGeminiResponse(data);

        } catch (error) {
            removeRequestController(requestId);
            if (error.name === 'AbortError') {
                throw new Error(i18n.t('errors.requestAborted', 'Request was cancelled'));
            }
            throw error;
        }

    } catch (error) {
        console.error('Error with Files API:', error);

        // Check again at the outer level for file permission errors
        if (error && error.message &&
            (error.message.includes('403') &&
             (error.message.includes('PERMISSION_DENIED') ||
              error.message.includes('You do not have permission to access the File') ||
              error.message.includes('it may not exist'))) &&
            retryCount === 0) {

            console.warn('[GeminiAPI] Detected permission error in outer catch, clearing cache and retrying...');

            // Clear the invalid cached URI
            if (fileKey) { // <-- Now accessible here
                localStorage.removeItem(fileKey); // <-- And here
            }

            // Retry the entire operation with fresh upload
            return await callGeminiApiWithFilesApi(file, options, retryCount + 1);
        }

        throw error;
    }
};
