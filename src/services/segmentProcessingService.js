/**
 * Service for processing video and audio segments
 */

import { callGeminiApi, getProcessingForceStopped } from './geminiService';
import { fetchSegment } from '../utils/videoSplitter';
import { parseRawTextManually } from '../utils/subtitle';
import { getTranscriptionRules } from '../utils/transcriptionRulesStore';
import { API_BASE_URL } from '../config';
import { getMaxSegmentDurationSeconds } from '../utils/durationUtils';
import { formatTime } from '../utils/timeFormatter';
import { DEFAULT_TRANSCRIPTION_MODEL_ID, normalizeMediaModelId } from '../config/geminiModels';

/**
 * Process a single media segment (video or audio)
 * @param {Object} segment - The segment object with URL
 * @param {number} segmentIndex - The index of the segment
 * @param {number} startTime - The start time offset for this segment
 * @param {string} segmentCacheId - The cache ID for this segment
 * @param {Function} onStatusUpdate - Callback for status updates
 * @param {Function} t - Translation function
 * @param {string} mediaType - Type of media ('video' or 'audio')
 * @returns {Promise<Array>} - Array of subtitle objects with adjusted timestamps
 */
export async function processSegment(segment, segmentIndex, startTime, segmentCacheId, onStatusUpdate, t, mediaType = 'video', options = {}) {
    // Extract options
    const { userProvidedSubtitles, modelId } = options;
    const mediaModel = normalizeMediaModelId(
        modelId || localStorage.getItem('gemini_model'),
        DEFAULT_TRANSCRIPTION_MODEL_ID
    );
    let retryCount = 0;
    const maxRetries = 3;
    let success = false;
    let segmentSubtitles = null;

    // Update status to show we're processing in parallel
    onStatusUpdate({
        message: t('output.processingInParallel', 'Processing in parallel...'),
        type: 'loading'
    });

    while (!success && retryCount < maxRetries) {
        // Check if processing has been force stopped
        if (getProcessingForceStopped()) {

            throw new Error('Processing was force stopped');
        }
        try {
            // Fetch the segment file from the server
            const segmentFile = await fetchSegment(segment.url, segmentIndex, mediaType);

            // Log the segment file details


            // Only get transcription rules if we're not using user-provided subtitles
            if (!userProvidedSubtitles) {
                // Get transcription rules from localStorage
                const transcriptionRules = getTranscriptionRules();
                if (transcriptionRules) {

                } else {

                }
            } else {

            }

            // Process the segment with Gemini
            console.log(`[SegmentRetry] Using verified media model for segment ${segmentIndex + 1}: ${mediaModel}`);

            // Get the total duration from the parent if available
            const totalDuration = options.totalDuration || null;

            // Create segment info for the prompt
            const segmentInfo = {
                isSegment: true,
                segmentIndex,
                startTime,
                duration: segment.duration,
                totalDuration
            };

            // Pass segment info to callGeminiApi
            segmentSubtitles = await callGeminiApi(segmentFile, 'file-upload', {
                userProvidedSubtitles,
                segmentInfo,
                modelId: mediaModel
            });
            success = true;
        } catch (error) {
            console.error(`Error processing segment ${segmentIndex+1}, attempt ${retryCount+1}:`, error);

            // Log the error message and status code for debugging



            // More aggressive detection of overload errors
            const isOverloadError =
                error.isOverloaded ||
                (error.message && (
                    error.message.includes('503') ||
                    error.message.includes('Service Unavailable') ||
                    error.message.includes('overloaded') ||
                    error.message.includes('UNAVAILABLE') ||
                    error.message.includes('Status code: 503')
                ));

            if (isOverloadError) {


                // Update segment status to show "Quá tải" instead of "Thất bại"
                // Get the time range for this segment
                const startTime = segment.startTime !== undefined ? segment.startTime : segmentIndex * getMaxSegmentDurationSeconds();
                const segmentDuration = segment.duration !== undefined ? segment.duration : getMaxSegmentDurationSeconds();
                const endTime = startTime + segmentDuration;

                // Format time range for display
                const timeRange = `${formatTime(startTime, 'hms')} - ${formatTime(endTime, 'hms')}`;

                // Check if this is specifically a 503 error for more specific messaging
                const is503Error = error.message && (
                    error.message.includes('503') ||
                    error.message.includes('Status code: 503')
                );

                const errorMessage = is503Error
                    ? t('errors.geminiServiceUnavailable', 'Gemini is currently overloaded, please wait and try again later (error code 503)')
                    : t('errors.geminiOverloaded', 'Mô hình đang quá tải. Vui lòng thử lại sau.');

                // Update segment status with the time range
                updateSegmentStatus(
                    segmentIndex,
                    'overloaded',
                    errorMessage,
                    t,
                    timeRange
                );

                // If we hit an overload error, stop retrying and throw the error
                const overloadError = new Error(`Segment ${segmentIndex+1}: ${errorMessage}`);
                overloadError.isOverloaded = true;
                throw overloadError;
            }

            // Check if this is an empty response (empty JSON array)
            if (error.message && error.message.includes('Unrecognized subtitle format') &&
                error.message.includes('rawText":"[]"')) {

                // Return empty array instead of retrying
                return [];
            }

            // Check for token limit error
            if (error.message && error.message.includes('token') && error.message.includes('exceeds the maximum')) {
                // If we hit token limit, we need to use smaller segments
                throw new Error(`Token limit exceeded for segment ${segmentIndex+1}. Please try with a shorter video segment or lower video quality.`);
            }

            // Check for unrecognized format error or empty subtitles
            try {
                const errorData = JSON.parse(error.message);

                if (errorData.type === 'unrecognized_format') {
                    // Extract the raw text from the error
                    const rawText = errorData.rawText;

                    // Try to parse the raw text manually
                    const manualSubtitles = parseRawTextManually(rawText, startTime);

                    if (manualSubtitles && manualSubtitles.length > 0) {

                        segmentSubtitles = manualSubtitles;
                        success = true;
                        break; // Exit the retry loop, we've handled it
                    }
                }

                // Handle the case where all subtitles are empty
                if (errorData.type === 'empty_subtitles') {

                    // Return an empty array for this segment
                    segmentSubtitles = [];
                    success = true;
                    break; // Exit the retry loop, we've handled it
                }
            } catch (parseError) {
                console.error('Error parsing error message:', parseError);
            }

            // Increment retry count
            retryCount++;

            if (retryCount >= maxRetries) {
                throw new Error(`Failed to process segment ${segmentIndex+1} after ${maxRetries} attempts`);
            }

            // Update status for retry - keep using the parallel processing message
            onStatusUpdate({
                message: t('output.processingInParallel', 'Processing in parallel...'),
                type: 'loading'
            });

            // Wait a bit before retrying
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }

    // Cache the segment results
    if (success && segmentSubtitles) {
        try {
            await fetch(`${API_BASE_URL}/save-subtitles`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    cacheId: segmentCacheId,
                    subtitles: segmentSubtitles
                })
            });
        } catch (error) {
            console.error('Error caching segment subtitles:', error);
            // Continue even if caching fails
        }
    }

    // If we got here without subtitles, something went wrong
    if (!segmentSubtitles) {
        throw new Error(`Failed to process segment ${segmentIndex+1}`);
    }

    // Handle the case where the API returned an empty array (no speech in segment)
    if (Array.isArray(segmentSubtitles) && segmentSubtitles.length === 0) {

        // Continue processing with an empty array
    }

    // Get the actual segment duration and start time if available
    const segmentDuration = segment.duration !== undefined ? segment.duration : null;

    // Log detailed information about this segment


    if (segmentDuration) {


    }



    // Debug: Log original subtitle timestamps before adjustment
    console.log(`[SEGMENT-${segmentIndex}] Original subtitles from Gemini:`, segmentSubtitles.map(s => `${s.start}-${s.end}: ${s.text.substring(0, 30)}...`));

    // Adjust timestamps based on segment start time
    const adjustedSubtitles = segmentSubtitles.map(subtitle => {
        // Apply the offset based on actual segment start time
        const adjustedStart = subtitle.start + startTime;
        const adjustedEnd = subtitle.end + startTime;

        return {
            ...subtitle,
            start: adjustedStart,
            end: adjustedEnd
        };
    });

    // Debug: Log adjusted subtitle timestamps
    console.log(`[SEGMENT-${segmentIndex}] Adjusted subtitles (startTime offset: ${startTime}):`, adjustedSubtitles.map(s => `${s.start}-${s.end}: ${s.text.substring(0, 30)}...`));



    return adjustedSubtitles;
}

/**
 * Update segment status in the UI
 * @param {number} index - Segment index
 * @param {string} status - Status type
 * @param {string} message - Status message
 * @param {Function} t - Translation function
 * @param {string} timeRange - Time range for the segment (optional)
 */
export const updateSegmentStatus = (index, status, message, t, timeRange = null) => {
    // Make sure we have a valid translation function
    const translate = typeof t === 'function' ? t : (_, defaultValue) => defaultValue;

    // Log the status update for debugging


    // Remove debug translation logs to prevent console spam

    // Create the status object
    const segmentStatus = {
        index,
        status,
        message,
        timeRange,
        shortMessage: status === 'loading' ? translate('output.processing', 'Processing') :
                     status === 'success' ? translate('output.done', 'Done') :
                     status === 'error' ? translate('output.failed', 'Failed') :
                     status === 'overloaded' ? translate('output.overloaded', 'Overloaded') :
                     status === 'cached' ? translate('output.cached', 'Cached') :
                     status === 'pending' ? translate('output.pending', 'Pending') :
                     status === 'retrying' ? translate('output.retrying', 'Retrying...') : ''
    };

    // Dispatch event to update UI
    const event = new CustomEvent('segmentStatusUpdate', {
        detail: [segmentStatus]
    });
    window.dispatchEvent(event);
};
