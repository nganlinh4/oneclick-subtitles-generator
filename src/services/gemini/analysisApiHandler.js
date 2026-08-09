/**
 * Dedicated Gemini Files-API request path for video analysis.
 * Split out of core.js for maintainability.
 */

import { addResponseSchema } from '../../utils/schemaUtils';
import { resolveGeminiFileCache } from './fileCache';
import { addThinkingConfig } from '../../utils/thinkingBudgetUtils';
import { uploadFileToGemini } from './filesApi';
import { supportsMediaResolution } from './modelCapabilities';
import { DEFAULT_ANALYSIS_MODEL_ID, normalizeMediaModelId } from '../../config/geminiModels';

/**
 * Special version of callGeminiApiWithFilesApi for video analysis
 * Uses the same caching mechanism but with custom analysis prompt
 * @param {File} file - The video file to analyze
 * @param {Object} options - Analysis options including analysisPrompt
 * @param {AbortSignal} abortSignal - Optional abort signal for cancellation
 * @returns {Promise<Object>} - Analysis result
 */
export const callGeminiApiWithFilesApiForAnalysis = async (file, options = {}, abortSignal = null, retryCount = 0) => {
    const { modelId, videoMetadata, analysisPrompt, mediaResolution } = options;
    const MODEL = normalizeMediaModelId(
        modelId || localStorage.getItem('video_analysis_model'),
        DEFAULT_ANALYSIS_MODEL_ID
    );

    console.log(`[GeminiAPI] Using Files API for video analysis with model: ${MODEL}`);
    console.log(`[GeminiAPI] Analysis FPS setting: ${videoMetadata?.fps || 'default'}`);
    console.log(`[GeminiAPI] Analysis resolution setting: ${mediaResolution || 'default'}`);
    if (retryCount > 0) {
        console.log(`[GeminiAPI Analysis] Retry attempt ${retryCount} after file permission error`);
    }

    let fileKey;

    try {
        // Use the same caching mechanism as subtitle generation
        const __cache = await resolveGeminiFileCache(file, '[GeminiAPI Analysis]');
        fileKey = __cache.fileKey;
        let uploadedFile = __cache.uploadedFile;
        let shouldUpload = !uploadedFile || !uploadedFile.uri;

        if (uploadedFile && uploadedFile.uri) {
            console.log('[GeminiAPI Analysis] Reusing existing uploaded file URI from subtitle generation cache:', uploadedFile.uri);
            window.dispatchEvent(new CustomEvent('gemini-file-reused', {
                detail: { fileName: file.name, uri: uploadedFile.uri, purpose: 'analysis' }
            }));
        }

        if (shouldUpload) {
            // Upload file to Gemini Files API
            console.log('[GeminiAPI Analysis] Uploading file to Gemini Files API for analysis...');
            window.dispatchEvent(new CustomEvent('gemini-file-uploading', {
                detail: { fileName: file.name, purpose: 'analysis' }
            }));

            uploadedFile = await uploadFileToGemini(file, `${file.name}_${Date.now()}`, { runId: options && options.runId ? options.runId : undefined });
            console.log('[GeminiAPI Analysis] File uploaded successfully:', uploadedFile.uri);

            // Cache the uploaded file info for reuse by both analysis and subtitle generation
            localStorage.setItem(fileKey, JSON.stringify(uploadedFile));

            window.dispatchEvent(new CustomEvent('gemini-file-uploaded', {
                detail: { fileName: file.name, uri: uploadedFile.uri, purpose: 'analysis' }
            }));
        }

        // Create request data with analysis prompt and video metadata
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
                        { text: analysisPrompt }
                    ]
                }
            ]
        };

        // Add video metadata with low FPS for analysis
        if (videoMetadata) {
            console.log('[GeminiAPI Analysis] Adding video metadata for analysis:', JSON.stringify(videoMetadata, null, 2));
            requestData.contents[0].parts[0].video_metadata = videoMetadata;
        }

        // Add response schema for structured analysis output
        const { createVideoAnalysisSchema } = await import('../../utils/schemaUtils');
        requestData = addResponseSchema(requestData, createVideoAnalysisSchema());

        // Add thinking configuration if supported by the model
        requestData = addThinkingConfig(requestData, MODEL, { enableThinking: false });

        // Add generation config with media resolution if provided (only for supported models)
        if (mediaResolution && supportsMediaResolution(MODEL)) {
            if (!requestData.generationConfig) {
                requestData.generationConfig = {};
            }
            requestData.generationConfig.mediaResolution = mediaResolution;
            console.log('[GeminiAPI Analysis] Using media resolution:', mediaResolution);
        } else if (mediaResolution && !supportsMediaResolution(MODEL)) {
            console.log('[GeminiAPI Analysis] Skipping media resolution for unsupported model:', MODEL);
        }

        // Make the API request with optional abort signal
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${uploadedFile.apiKey || localStorage.getItem('gemini_api_key')}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestData),
                signal: abortSignal
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

                console.warn('[GeminiAPI Analysis] Cached file URI is no longer valid (403 error), clearing cache...');

                // Clear the invalid cached URI
                localStorage.removeItem(fileKey);

                // Retry only once to avoid infinite loops
                if (retryCount === 0) {
                    console.log('[GeminiAPI Analysis] Retrying with fresh file upload...');
                    // Retry the entire operation with fresh upload
                    return await callGeminiApiWithFilesApiForAnalysis(file, options, abortSignal, retryCount + 1);
                } else {
                    console.error('[GeminiAPI Analysis] Failed after retry, giving up');
                    throw new Error(`API error: ${errorMessage}`);
                }
            }

            throw new Error(`Gemini API error: ${errorMessage}`);
        }

        const data = await response.json();

        // Check if content was blocked by Gemini
        if (data?.promptFeedback?.blockReason) {
            console.error('Content blocked by Gemini:', data.promptFeedback);
            throw new Error('Video content is not safe and was blocked by Gemini');
        }

        // Check if this is a structured JSON response
        if (data.candidates?.[0]?.content?.parts?.[0]?.structuredJson) {
            return data.candidates[0].content.parts[0].structuredJson;
        } else if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
            // Return the text response for parsing
            return [{ text: data.candidates[0].content.parts[0].text }];
        } else {
            throw new Error('No analysis returned from Gemini');
        }

    } catch (error) {
        console.error('[GeminiAPI Analysis] Error:', error);

        // Check again at the outer level for file permission errors
        if (error && error.message &&
            (error.message.includes('403') &&
             (error.message.includes('PERMISSION_DENIED') ||
              error.message.includes('You do not have permission to access the File') ||
              error.message.includes('it may not exist'))) &&
            retryCount === 0) {

            console.warn('[GeminiAPI Analysis] Detected permission error in outer catch, clearing cache and retrying...');

            // Clear the invalid cached URI
            if (fileKey) {
                localStorage.removeItem(fileKey);
            }

            // Retry the entire operation with fresh upload
            return await callGeminiApiWithFilesApiForAnalysis(file, options, abortSignal, retryCount + 1);
        }

        if (error.name === 'AbortError') {
            throw new Error('Video analysis was cancelled');
        }

        throw error;
    }
};
