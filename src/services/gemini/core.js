/**
 * Core functionality for Gemini API
 */

import { parseGeminiResponse } from '../../utils/subtitle';
import { convertAudioForGemini, isAudioFormatSupportedByGemini } from '../../utils/audioConverter';
import {
    createSubtitleSchema,
    addResponseSchema
} from '../../utils/schemaUtils';
import { getTranscriptionPrompt } from './promptManagement';
import { fileToBase64 } from './utils';
import {
    createRequestController,
    removeRequestController
} from './requestManagement';
import i18n from '../../i18n/i18n';
import { getNextAvailableKey, blacklistKey } from './keyManager';
import { addThinkingConfig } from '../../utils/thinkingBudgetUtils';
import { uploadFileToGemini, shouldUseFilesApi } from './filesApi';
import { streamGeminiContent, isStreamingSupported } from './streamingService';
import { coordinateParallelStreaming, shouldUseParallelProcessing } from './parallelStreamingCoordinator';

/**
 * Clear cached file URI for a specific file
 * @param {File} file - The file to clear cache for
 */
export const clearCachedFileUri = async (file) => {
    // Clear both file-based and URL-based cache keys
    const currentVideoUrl = localStorage.getItem('current_video_url');

    if (currentVideoUrl) {
        // Clear URL-based cache for downloaded video
        const { generateUrlBasedCacheId } = await import('../../hooks/useSubtitles');
        const urlBasedId = await generateUrlBasedCacheId(currentVideoUrl);
        const urlKey = `gemini_file_url_${urlBasedId}`;
        localStorage.removeItem(urlKey);
        console.log('[GeminiAPI] Cleared URL-based cached file URI for:', file.name);
    } else {
        // Clear file-based cache for uploaded file
        const lastModified = file.lastModified || Date.now();
        const fileKey = `gemini_file_${file.name}_${file.size}_${lastModified}`;
        localStorage.removeItem(fileKey);
        console.log('[GeminiAPI] Cleared file-based cached file URI for:', file.name);
    }
};

/**
 * Clear all cached file URIs (both file-based and URL-based)
 */
export const clearAllCachedFileUris = () => {
    const keys = Object.keys(localStorage);
    const fileKeys = keys.filter(key => key.startsWith('gemini_file_'));
    fileKeys.forEach(key => localStorage.removeItem(key));
    console.log('[GeminiAPI] Cleared all cached file URIs (file-based and URL-based):', fileKeys.length);
};

/**
 * Call the Gemini API using Files API for better performance and caching
 * @param {File} file - Input file
 * @param {Object} options - Additional options
 * @returns {Promise<Array>} - Array of subtitles
 */
/**
 * Stream content generation using Files API
 * @param {File} file - The media file
 * @param {Object} options - Generation options
 * @param {Function} onChunk - Callback for streaming chunks
 * @param {Function} onComplete - Callback when complete
 * @param {Function} onError - Callback for errors
 * @returns {Promise<void>}
 */
export const streamGeminiApiWithFilesApi = async (file, options = {}, onChunk, onComplete, onError, onProgress, retryCount = 0) => {
    const { userProvidedSubtitles, modelId, videoMetadata, mediaResolution, maxDurationPerRequest } = options;
    const MODEL = modelId || localStorage.getItem('gemini_model') || "gemini-2.5-flash";

    console.log(`[GeminiAPI] Using streaming Files API with model: ${MODEL}`);

    // Check if streaming is supported
    if (!isStreamingSupported(MODEL)) {
        console.warn('[GeminiAPI] Streaming not supported for model:', MODEL, '- falling back to regular API');
        try {
            const result = await callGeminiApiWithFilesApi(file, options);
            onComplete(result);
        } catch (error) {
            onError(error);
        }
        return;
    }

    try {
        // Check if we already have an uploaded file URI for this file
        // Use different caching strategies for uploaded vs downloaded videos
        let fileKey;
        const currentVideoUrl = localStorage.getItem('current_video_url');

        if (currentVideoUrl) {
            // This is a downloaded video - use URL-based caching for consistency
            const { generateUrlBasedCacheId } = await import('../../hooks/useSubtitles');
            const urlBasedId = await generateUrlBasedCacheId(currentVideoUrl);
            fileKey = `gemini_file_url_${urlBasedId}`;
            console.log('[GeminiAPI] Using URL-based cache key for downloaded video:', fileKey);
        } else {
            // This is an uploaded file - use file-based caching
            const lastModified = file.lastModified || Date.now();
            fileKey = `gemini_file_${file.name}_${file.size}_${lastModified}`;
            console.log('[GeminiAPI] Using file-based cache key for uploaded file:', fileKey);
        }

        let uploadedFile = JSON.parse(localStorage.getItem(fileKey) || 'null');
        const isYouTube = !!(currentVideoUrl && /(youtube\.com|youtu\.be)\//.test(currentVideoUrl));
        if (isYouTube) {
            // YouTube videos skip Files API upload; use the URL directly
            uploadedFile = { uri: currentVideoUrl, mimeType: file?.type };
        }
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

        // Start streaming with error handling wrapper
        const streamWithErrorHandling = async () => {
            // Check if we should use parallel processing
            const useParallel = shouldUseParallelProcessing(
                options.segmentInfo ? { start: options.segmentInfo.start, end: options.segmentInfo.end } : null,
                maxDurationPerRequest
            );

            const streamFunction = useParallel ? coordinateParallelStreaming : streamGeminiContent;
            
            console.log(`[GeminiAPI] Using ${useParallel ? 'parallel' : 'single'} streaming`);

            await streamFunction(
                file,
                uploadedFile.uri,
                {
                    userProvidedSubtitles,
                    modelId,
                    videoMetadata,
                    mediaResolution,
                    segmentInfo: options.segmentInfo,
                    maxDurationPerRequest,
                    autoSplitSubtitles: options.autoSplitSubtitles,
                    maxWordsPerSubtitle: options.maxWordsPerSubtitle
                },
                onChunk,
                onComplete,
                async (error) => {
                    // Check if this is a file permission error (expired or deleted file)
                    if (error && error.message && 
                        ((error.message.includes('403') && 
                         (error.message.includes('PERMISSION_DENIED') || 
                          error.message.includes('You do not have permission to access the File') ||
                          error.message.includes('it may not exist'))) ||
                        error.message.includes('FILE_URI_EXPIRED'))) {
                        
                        console.warn('[GeminiAPI] Cached file URI is no longer valid, clearing cache and retrying...');
                        
                        // Clear the invalid cached URI
                        localStorage.removeItem(fileKey);
                        
                        // Retry only once to avoid infinite loops
                        if (retryCount === 0) {
                            console.log('[GeminiAPI] Retrying with fresh file upload...');
                            // Retry the entire operation with fresh upload
                            await streamGeminiApiWithFilesApi(
                                file, 
                                options, 
                                onChunk, 
                                onComplete, 
                                onError, 
                                onProgress,
                                retryCount + 1
                            );
                        } else {
                            console.error('[GeminiAPI] Failed after retry, giving up');
                            onError(error);
                        }
                    } else {
                        // For other errors, just pass them through
                        onError(error);
                    }
                }
            );
        };

        await streamWithErrorHandling();

    } catch (error) {
        console.error('Error in streaming Files API:', error);
        onError(error);
    }
};

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
    const MODEL = modelId || localStorage.getItem('video_analysis_model') || "gemini-2.5-flash-lite";

    console.log(`[GeminiAPI] Using Files API for video analysis with model: ${MODEL}`);
    console.log(`[GeminiAPI] Analysis FPS setting: ${videoMetadata?.fps || 'default'}`);
    console.log(`[GeminiAPI] Analysis resolution setting: ${mediaResolution || 'default'}`);
    if (retryCount > 0) {
        console.log(`[GeminiAPI Analysis] Retry attempt ${retryCount} after file permission error`);
    }

    let fileKey;

    try {
        // Use the same caching mechanism as subtitle generation
        const currentVideoUrl = localStorage.getItem('current_video_url');

        if (currentVideoUrl) {
            // This is a downloaded video - use URL-based caching for consistency
            const { generateUrlBasedCacheId } = await import('../../hooks/useSubtitles');
            const urlBasedId = await generateUrlBasedCacheId(currentVideoUrl);
            fileKey = `gemini_file_url_${urlBasedId}`;
            console.log('[GeminiAPI Analysis] Using URL-based cache key for downloaded video:', fileKey);
        } else {
            // This is an uploaded file - use file-based caching
            const lastModified = file.lastModified || Date.now();
            fileKey = `gemini_file_${file.name}_${file.size}_${lastModified}`;
            console.log('[GeminiAPI Analysis] Using file-based cache key for uploaded file:', fileKey);
        }

        let uploadedFile = JSON.parse(localStorage.getItem(fileKey) || 'null');
        const isYouTube = !!(currentVideoUrl && /(youtube\.com|youtu\.be)\//.test(currentVideoUrl));
        if (isYouTube) {
            // YouTube videos skip Files API upload; use the URL directly
            uploadedFile = { uri: currentVideoUrl, mimeType: file?.type };
        }
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

            uploadedFile = await uploadFileToGemini(file, `${file.name}_${Date.now()}`);
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

        // Add generation config with media resolution if provided
        if (mediaResolution) {
            if (!requestData.generationConfig) {
                requestData.generationConfig = {};
            }
            requestData.generationConfig.mediaResolution = mediaResolution;
            console.log('[GeminiAPI Analysis] Using media resolution:', mediaResolution);
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

export const callGeminiApiWithFilesApi = async (file, options = {}, retryCount = 0) => {
    const { userProvidedSubtitles, modelId, videoMetadata, mediaResolution } = options;
    const MODEL = modelId || localStorage.getItem('gemini_model') || "gemini-2.5-flash";

    console.log(`[GeminiAPI] Using Files API with model: ${MODEL}`);

    let fileKey; // <-- Moved declaration to the function's scope

    try {
        // Check if we already have an uploaded file URI for this file
        // Use different caching strategies for uploaded vs downloaded videos
        // let fileKey; // <-- Removed original declaration from here
        const currentVideoUrl = localStorage.getItem('current_video_url');

        if (currentVideoUrl) {
            // This is a downloaded video - use URL-based caching for consistency
            const { generateUrlBasedCacheId } = await import('../../hooks/useSubtitles');
            const urlBasedId = await generateUrlBasedCacheId(currentVideoUrl);
            fileKey = `gemini_file_url_${urlBasedId}`;
            console.log('[GeminiAPI] Using URL-based cache key for downloaded video:', fileKey);
        } else {
            // This is an uploaded file - use file-based caching
            const lastModified = file.lastModified || Date.now();
            fileKey = `gemini_file_${file.name}_${file.size}_${lastModified}`;
            console.log('[GeminiAPI] Using file-based cache key for uploaded file:', fileKey);
        }

        let uploadedFile = JSON.parse(localStorage.getItem(fileKey) || 'null');
        const isYouTube = !!(currentVideoUrl && /(youtube\.com|youtu\.be)\//.test(currentVideoUrl));
        if (isYouTube) {
            // YouTube videos skip Files API upload; use the URL directly
            uploadedFile = { uri: currentVideoUrl, mimeType: file?.type };
        }
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

        // Add video metadata if provided
        if (videoMetadata && !isAudio) {
            console.log('[GeminiAPI] Adding video metadata to request:', JSON.stringify(videoMetadata, null, 2));
            // Add video metadata to the file_data part (now at index 0 since video is first)
            requestData.contents[0].parts[0].video_metadata = videoMetadata;
            console.log('[GeminiAPI] Request structure with video_metadata:', JSON.stringify(requestData.contents[0].parts[0], null, 2));
        }

        // Add response schema
        requestData = addResponseSchema(requestData, createSubtitleSchema(isUserProvided), isUserProvided);

        // Add thinking configuration if supported by the model
        requestData = addThinkingConfig(requestData, MODEL);

        // Add generation config with media resolution if provided
        if (mediaResolution) {
            if (!requestData.generationConfig) {
                requestData.generationConfig = {};
            }
            requestData.generationConfig.mediaResolution = mediaResolution;
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

/**
 * Call the Gemini API with various input types
 * @param {File|string} input - Input file or URL
 * @param {string} inputType - Type of input (youtube, video, audio, file-upload)
 * @param {Object} options - Additional options
 * @returns {Promise<Array>} - Array of subtitles
 */
export const callGeminiApi = async (input, inputType, options = {}) => {
    // Extract options
    const { userProvidedSubtitles, modelId } = options;
    // Use the passed modelId if available, otherwise fall back to localStorage
    const MODEL = modelId || localStorage.getItem('gemini_model') || "gemini-2.5-flash";

    if (modelId) {
        console.log(`[GeminiAPI] Using custom model: ${MODEL}`);
    }

    // Get the next available API key
    const geminiApiKey = getNextAvailableKey();
    if (!geminiApiKey) {
        throw new Error('No valid Gemini API key available. Please add at least one API key in Settings.');
    }

    let requestData = {
        model: MODEL,
        contents: []
    };

    // Always use structured output, but with different schema based on whether we have user-provided subtitles
    const isUserProvided = userProvidedSubtitles && userProvidedSubtitles.trim() !== '';
    requestData = addResponseSchema(requestData, createSubtitleSchema(isUserProvided), isUserProvided);

    // Add thinking configuration if supported by the model
    requestData = addThinkingConfig(requestData, MODEL);


    if (inputType === 'youtube') {
        requestData.contents = [
            {
                role: "user",
                parts: [
                    {
                        file_data: {
                            file_uri: input
                        }
                    },
                    { text: getTranscriptionPrompt('video') }
                ]
            }
        ];
    } else if (inputType === 'video' || inputType === 'audio' || inputType === 'file-upload') {
        // Check if we should use Files API for better performance and caching
        if (shouldUseFilesApi(input)) {
            console.log('[GeminiAPI] Using Files API for large file or better caching');
            return await callGeminiApiWithFilesApi(input, options);
        }

        console.log('[GeminiAPI] Using inline data for small file');

        // Determine if this is a video or audio file
        const isAudio = input.type.startsWith('audio/');
        const contentType = isAudio ? 'audio' : 'video';

        // For audio files, convert to a format supported by Gemini
        let processedInput = input;
        if (isAudio) {
            // Check if the audio format is supported by Gemini
            if (!isAudioFormatSupportedByGemini(input)) {
                console.warn('Audio format not directly supported by Gemini API, attempting conversion');
            }

            // Convert the audio file to a supported format
            processedInput = await convertAudioForGemini(input);
        }

        const base64Data = await fileToBase64(processedInput);

        // Use the MIME type from the processed input
        const mimeType = processedInput.type;



        // Check if we have user-provided subtitles
        const isUserProvided = userProvidedSubtitles && userProvidedSubtitles.trim() !== '';

        // Extract segment information if available
        const segmentInfo = options?.segmentInfo || {};

        // For audio files, we need to ensure the prompt is appropriate
        const promptText = getTranscriptionPrompt(contentType, userProvidedSubtitles, { segmentInfo });

        // Log the prompt being used


        // Log if we're using user-provided subtitles
        if (isUserProvided) {


            // When using user-provided subtitles, we want to use a very simple request
            // without any additional configuration or schema
            requestData = {
                model: MODEL,
                contents: [
                    {
                        role: "user",
                        parts: [
                            {
                                inlineData: {
                                    mimeType: mimeType,
                                    data: base64Data
                                }
                            },
                            { text: promptText }
                        ]
                    }
                ]
            };

            // Still add the structured output schema, but with the user-provided flag
            requestData = addResponseSchema(requestData, createSubtitleSchema(true), true);

            // Add thinking configuration if supported by the model
            requestData = addThinkingConfig(requestData, MODEL);


            // Count the number of subtitles for validation
            const subtitleLines = userProvidedSubtitles.trim().split('\n').filter(line => line.trim() !== '');
            const expectedSubtitleCount = subtitleLines.length;


            // Store user-provided subtitles in localStorage for the parser to access
            localStorage.setItem('user_provided_subtitles', userProvidedSubtitles);


            // Skip the rest of the function since we've already set up the request data


            // Log the MIME type being sent to the API


            // Return early to skip the rest of the function
            // Use the same API call logic as below but in a more direct way
            const { requestId, signal } = createRequestController();

            try {
                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiApiKey}`,
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
                    try {
                        const errorData = await response.json();

                        // Check for 503 status code in the early return path
                        if (errorData.error?.code === 503 || response.status === 503) {
                            blacklistKey(geminiApiKey);
                            const overloadError = new Error(i18n.t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)'));
                            overloadError.isOverloaded = true;
                            throw overloadError;
                        }

                        throw new Error(`API error: ${errorData.error?.message || response.statusText}`);
                    } catch (jsonError) {
                        // Check for 503 status code when JSON parsing fails
                        if (response.status === 503) {
                            blacklistKey(geminiApiKey);
                            const overloadError = new Error(i18n.t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)'));
                            overloadError.isOverloaded = true;
                            throw overloadError;
                        }

                        throw new Error(`API error: ${response.statusText}. Status code: ${response.status}`);
                    }
                }

                const data = await response.json();

                // For user-provided subtitles, validate the response
                if (isUserProvided && data?.candidates?.[0]?.content?.parts?.[0]?.structuredJson) {
                    const structuredJson = data.candidates[0].content.parts[0].structuredJson;
                    if (Array.isArray(structuredJson)) {


                        // For segments, we expect a variable number of entries
                        const isSegment = options?.segmentInfo?.isSegment || false;

                        if (!isSegment) {
                            // For full video processing, we expect entries for all subtitles
                            // But we'll be more flexible and just log a warning if the counts don't match
                            if (structuredJson.length !== expectedSubtitleCount) {
                                console.warn(`Warning: Expected ${expectedSubtitleCount} timing entries but got ${structuredJson.length}`);
                            }
                        }

                        // Validate that all entries have the required fields
                        for (const entry of structuredJson) {
                            if (!entry.index && entry.index !== 0) {
                                console.error('Missing index in timing entry:', entry);
                                throw new Error('Invalid timing entry: missing index');
                            }
                            if (!entry.startTime) {
                                console.error('Missing startTime in timing entry:', entry);
                                throw new Error('Invalid timing entry: missing startTime');
                            }
                            if (!entry.endTime) {
                                console.error('Missing endTime in timing entry:', entry);
                                throw new Error('Invalid timing entry: missing endTime');
                            }
                        }
                    }
                }

                // Remove this controller from the map after successful response
                removeRequestController(requestId);
                return parseGeminiResponse(data);
            } catch (error) {
                // Check if this is an AbortError
                if (error.name === 'AbortError') {

                    throw new Error(i18n.t('errors.requestAborted', 'Request was cancelled'));
                } else {
                    console.error('Error calling Gemini API:', error);
                    // Remove this controller from the map on error
                    removeRequestController(requestId);
                    throw error;
                }
            }
        }

        requestData.contents = [
            {
                role: "user",
                parts: [
                    {
                        inlineData: {
                            mimeType: mimeType,
                            data: base64Data
                        }
                    },
                    { text: promptText }
                ]
            }
        ];

        // Log the MIME type being sent to the API

    }

    // Create a unique ID for this request
    const { requestId, signal } = createRequestController();

    try {
        // Log request data for debugging (without the actual base64 data to keep logs clean)



        // Create a deep copy of the request data for logging
        const debugRequestData = JSON.parse(JSON.stringify(requestData));
        if (debugRequestData.contents && debugRequestData.contents[0] && debugRequestData.contents[0].parts) {
            for (let i = 0; i < debugRequestData.contents[0].parts.length; i++) {
                const part = debugRequestData.contents[0].parts[i];
                if (part.inlineData && part.inlineData.data) {
                    debugRequestData.contents[0].parts[i] = {
                        ...part,
                        inlineData: {
                            ...part.inlineData,
                            data: '[BASE64_DATA]'
                        }
                    };
                }
            }
        }


        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiApiKey}`,
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
            try {
                // Clone the response before reading it to avoid the "body stream already read" error
                const responseClone = response.clone();
                try {
                    const errorData = await response.json();
                    console.error('Gemini API error details:', errorData);

                    // Log more detailed information about the error
                    if (errorData.error) {
                        console.error('Error code:', errorData.error.code);
                        console.error('Error message:', errorData.error.message);
                        console.error('Error status:', errorData.error.status);

                        // Check for specific error messages related to audio/video processing
                        if (errorData.error.message.includes('invalid argument')) {
                            console.error('This may be due to an unsupported file format or MIME type');
                            console.error('Supported audio formats: audio/wav, audio/mp3, audio/aiff, audio/aac, audio/ogg, audio/flac');
                            console.error('File type used:', input.type);
                        }

                        // Check for overload errors (503 status code)
                        if (errorData.error.code === 503 ||
                            errorData.error.status === 'UNAVAILABLE' ||
                            errorData.error.message.includes('overloaded')) {
                            // Blacklist the current API key
                            blacklistKey(geminiApiKey);
                            const overloadError = new Error(i18n.t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)'));
                            overloadError.isOverloaded = true;
                            throw overloadError;
                        }

                        // Check for quota exceeded errors (429 status code)
                        if (errorData.error.code === 429 ||
                            errorData.error.status === 'RESOURCE_EXHAUSTED' ||
                            (errorData.error.message && errorData.error.message.includes('quota'))) {
                            // Blacklist the current API key
                            blacklistKey(geminiApiKey);
                            throw new Error(i18n.t('errors.apiQuotaExceeded', 'Current API key is overloaded, please use a key from another Gmail account, or wait for some time, or add billing at https://aistudio.google.com/usage?tab=billing'));
                        }
                    }

                    throw new Error(`API error: ${errorData.error?.message || response.statusText}`);
                } catch (jsonError) {
                    console.error('Error parsing Gemini API error response as JSON:', jsonError);
                    const errorText = await responseClone.text();
                    console.error('Raw error response:', errorText);

                    // Check for 503 status code directly
                    if (response.status === 503) {
                        // Blacklist the current API key
                        blacklistKey(geminiApiKey);
                        const overloadError = new Error(i18n.t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)'));
                        overloadError.isOverloaded = true;
                        throw overloadError;
                    }

                    // Check for 429 status code (quota exceeded)
                    if (response.status === 429) {
                        // Blacklist the current API key
                        blacklistKey(geminiApiKey);
                        throw new Error(i18n.t('errors.apiQuotaExceeded', 'Current API key is overloaded, please use a key from another Gmail account, or wait for some time, or add billing at https://aistudio.google.com/usage?tab=billing'));
                    }

                    // Check for 503 status code before throwing generic error
                    if (response.status === 503) {
                        blacklistKey(geminiApiKey);
                        const overloadError = new Error(i18n.t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)'));
                        overloadError.isOverloaded = true;
                        throw overloadError;
                    }

                    throw new Error(`API error: ${response.statusText}. Status code: ${response.status}`);
                }
            } catch (error) {
                console.error('Error handling Gemini API error response:', error);

                // Check for 503 status code directly
                if (response.status === 503) {
                    // Blacklist the current API key
                    blacklistKey(geminiApiKey);
                    const overloadError = new Error(i18n.t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)'));
                    overloadError.isOverloaded = true;
                    throw overloadError;
                }

                // Check for 429 status code (quota exceeded)
                if (response.status === 429) {
                    // Blacklist the current API key
                    blacklistKey(geminiApiKey);
                    throw new Error(i18n.t('errors.apiQuotaExceeded', 'Current API key is overloaded, please use a key from another Gmail account, or wait for some time, or add billing at https://aistudio.google.com/usage?tab=billing'));
                }

                // Check for 503 status code before throwing generic error
                if (response.status === 503) {
                    blacklistKey(geminiApiKey);
                    const overloadError = new Error(i18n.t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)'));
                    overloadError.isOverloaded = true;
                    throw overloadError;
                }

                throw new Error(`API error: ${response.statusText}. Status code: ${response.status}`);
            }
        }

        const data = await response.json();


        // Check if the response contains empty subtitles
        if (data?.candidates?.[0]?.content?.parts?.[0]?.structuredJson) {
            const structuredJson = data.candidates[0].content.parts[0].structuredJson;
            if (Array.isArray(structuredJson)) {
                let emptyCount = 0;
                for (const item of structuredJson) {
                    if (item.startTime === '00m00s000ms' &&
                        item.endTime === '00m00s000ms' &&
                        (!item.text || item.text.trim() === '')) {
                        emptyCount++;
                    }
                }

                if (emptyCount > 0 && emptyCount / structuredJson.length > 0.9) {
                    console.warn(`Found ${emptyCount} empty subtitles out of ${structuredJson.length}. The audio may not contain any speech or the model failed to transcribe it.`);

                    if (emptyCount === structuredJson.length) {
                        throw new Error('No speech detected in the audio. The model returned empty subtitles.');
                    }
                }
            }
        }

        // Print the raw response to the console for debugging
        console.log('Raw Gemini API response:', JSON.stringify(data, null, 2));

        // Check if content was blocked by Gemini
        if (data?.promptFeedback?.blockReason) {
            console.error('Content blocked by Gemini:', data.promptFeedback);
            // Remove this controller from the map
            removeRequestController(requestId);
            throw new Error(i18n.t('errors.contentBlocked', 'Video content is not safe and was blocked by Gemini'));
        }

        // Remove this controller from the map after successful response
        removeRequestController(requestId);
        return parseGeminiResponse(data);
    } catch (error) {
                    // Check if this is an AbortError
                    if (error.name === 'AbortError') {

                        throw new Error(i18n.t('errors.requestAborted', 'Request was cancelled'));
        } else {
            console.error('Error calling Gemini API:', error);

            // Check for overload errors in the error message
            if (error.message && (
                error.message.includes('503') ||
                error.message.includes('Service Unavailable') ||
                error.message.includes('overloaded') ||
                error.message.includes('UNAVAILABLE')
            )) {
                // Blacklist the current API key
                blacklistKey(geminiApiKey);

                if (!error.isOverloaded) {
                    error.isOverloaded = true;
                }

                // Replace the error message with a user-friendly localized message
                error = new Error(i18n.t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)'));
                error.isOverloaded = true;
            }

            // Check for quota exceeded errors in the error message
            if (error.message && (
                error.message.includes('429') ||
                error.message.includes('quota') ||
                error.message.includes('RESOURCE_EXHAUSTED')
            )) {
                // Blacklist the current API key
                blacklistKey(geminiApiKey);

                // Replace the error with a more specific user-friendly message
                error = new Error(i18n.t('errors.apiQuotaExceeded', 'Current API key is overloaded, please use a key from another Gmail account, or wait for some time, or add billing at https://aistudio.google.com/usage?tab=billing'));
            }

            // Remove this controller from the map on error
            if (requestId) {
                removeRequestController(requestId);
            }
            throw error;
        }
    }
};
