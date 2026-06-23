import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { showErrorToast } from '../utils/toastUtils';
import { getNextAvailableKey } from '../services/gemini/keyManager';
import { supportsTokenCounting } from '../services/engines/transcriptionEngineRegistry';

/**
 * Encapsulates real + estimated token counting for the video processing modal.
 *
 * Real counting uses the Gemini countTokens API against an already-uploaded file
 * (falls back to estimation when no cached upload exists). Estimation follows the
 * official per-frame/per-second token math. Both account for parallel splitting.
 *
 * @param {object} params
 * @returns {{
 *   realTokenCount: number|null,
 *   estimatedTokens: number,
 *   displayTokens: number,
 *   isCountingTokens: boolean,
 *   tokenCountError: string|null
 * }}
 */
const useTokenCounting = ({
    isOpen,
    videoFile,
    selectedSegment,
    fps,
    mediaResolution,
    selectedModel,
    selectedPromptPreset,
    customLanguage,
    useTranscriptionRules,
    method,
    maxDurationPerRequest,
    resolutionOptions,
    buildOutsideContextText,
    getSelectedPromptText,
}) => {
    const { t } = useTranslation();
    // Token counting is a Gemini-only concern. Local ASR engines have no API token cost, so the whole
    // hook short-circuits for them (no API calls, displayTokens 0 -> always within limit).
    const tokenCountingEnabled = supportsTokenCounting(method);
    const [isCountingTokens, setIsCountingTokens] = useState(false);
    const [realTokenCount, setRealTokenCount] = useState(null);
    const [tokenCountError, setTokenCountError] = useState(null);

    // Real token counting using Gemini API with Files API (only if file already uploaded)
    const countTokensWithGeminiAPI = async (videoFile) => {
        if (!videoFile || !selectedSegment) return null;

        const geminiApiKey = getNextAvailableKey();
        if (!geminiApiKey) {
            console.warn('No Gemini API key available for token counting');
            return null;
        }

        try {
            setIsCountingTokens(true);
            setTokenCountError(null);

            // Check if we already have an uploaded file URI for this file
            // Use different caching strategies for uploaded vs downloaded videos
            let fileKey;
            const currentVideoUrl = localStorage.getItem('current_video_url');

            if (currentVideoUrl) {
                // This is a downloaded video - use URL-based caching for consistency
                const { generateUrlBasedCacheId } = await import('../services/subtitleCache');
                const urlBasedId = await generateUrlBasedCacheId(currentVideoUrl);
                fileKey = `gemini_file_url_${urlBasedId}`;
                console.log('[TokenCounting] Using URL-based cache key for downloaded video:', fileKey);
            } else {
                // This is an uploaded file - use file-based caching
                const lastModified = videoFile.lastModified || Date.now();
                fileKey = `gemini_file_${videoFile.name}_${videoFile.size}_${lastModified}`;
                console.log('[TokenCounting] Using file-based cache key for uploaded file:', fileKey);
            }

            let uploadedFile = JSON.parse(localStorage.getItem(fileKey) || 'null');

            // Only use real token counting if file is already uploaded, otherwise use estimation
            if (!uploadedFile || !uploadedFile.uri) {
                console.log('[TokenCounting] No cached file found, using estimation instead of uploading');
                return null; // This will cause the UI to show estimation
            } else {
                console.log('[TokenCounting] Using cached uploaded file for real token counting:', uploadedFile.uri);
            }

            // Create the request data using the uploaded file URI (matching countTokens API format)
            // Note: countTokens API doesn't support offset parameters, so we count the whole video
            const filePart = {
                file_data: {
                    file_uri: uploadedFile.uri,
                    mime_type: uploadedFile.mimeType || videoFile.type || "video/mp4"
                }
            };

            // If user-provided subtitles mode is active, append outside-context directly to the prompt
            const ctxText = buildOutsideContextText();
            const promptWithCtx = ctxText
                ? `${getSelectedPromptText()}\n\nContextual subtitles outside the selected range (for consistency):${ctxText}`
                : getSelectedPromptText();

            const requestData = {
                contents: [{
                    role: "user",
                    parts: [
                        { text: promptWithCtx },
                        filePart
                    ]
                }]
            };

            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:countTokens?key=${geminiApiKey}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(requestData)
                }
            );

            if (!response.ok) {
                const errorData = await response.json();
                console.error('Token counting API error:', errorData);
                return null;
            }

            const data = await response.json();
            console.log('[TokenCounting] Whole video token count:', data.totalTokens);

            // Since countTokens API doesn't support offset, it returns tokens for the entire video.
            // We need to calculate the proportion for the selected segment.
            const wholeVideoTokens = data.totalTokens;

            // Calculate segment proportion based on duration
            const segmentDuration = selectedSegment.end - selectedSegment.start;

            // Account for parallel processing splitting
            const numRequests = Math.ceil(segmentDuration / (maxDurationPerRequest * 60));

            // Try to get total duration from video file or use segment duration as fallback
            let totalDuration = segmentDuration; // Conservative fallback

            if (videoFile) {
                try {
                    // Try to get duration from video file metadata
                    const videoDuration = await new Promise((resolve) => {
                        const video = document.createElement('video');
                        video.preload = 'metadata';
                        video.onloadedmetadata = () => resolve(video.duration || 0);
                        video.onerror = () => resolve(0);
                        setTimeout(() => resolve(0), 2000); // 2 second timeout
                        video.src = URL.createObjectURL(videoFile);
                    });

                    if (videoDuration > 0) {
                        totalDuration = videoDuration;
                    }
                } catch (error) {
                    console.warn('[TokenCounting] Could not get video duration, using segment duration as fallback');
                }
            }

            const segmentProportion = segmentDuration / totalDuration;

            console.log('[TokenCounting] Segment duration:', segmentDuration, 'Total duration:', totalDuration, 'Proportion:', segmentProportion);

            // Calculate base tokens for the selected segment
            const baseSegmentTokens = Math.round(wholeVideoTokens * segmentProportion);

            // Apply FPS and resolution adjustments to the segment tokens
            // The API returns tokens for default FPS (likely 1 FPS) and default resolution (likely medium)
            const baseFps = 1; // Assumed baseline FPS used by the API
            const fpsAdjustmentFactor = fps / baseFps;

            // Adjust for media resolution based on official token counts
            let resolutionAdjustmentFactor = 1;
            if (mediaResolution === 'low') {
                resolutionAdjustmentFactor = 64 / 256; // low vs medium ratio
            } else if (mediaResolution === 'high') {
                resolutionAdjustmentFactor = 256 / 256; // high vs medium ratio (same)
            }

            // Apply all adjustments to the segment tokens
            const segmentTokensAdjusted = Math.round(baseSegmentTokens * fpsAdjustmentFactor * resolutionAdjustmentFactor);

            // For display, show the maximum tokens per request when splitting
            const tokensPerRequest = numRequests > 1
                ? Math.round(segmentTokensAdjusted / numRequests)
                : segmentTokensAdjusted;

            console.log('[TokenCounting] Final calculation:');
            console.log('  - Whole video tokens:', wholeVideoTokens);
            console.log('  - Segment proportion:', segmentProportion.toFixed(3));
            console.log('  - Base segment tokens:', baseSegmentTokens);
            console.log('  - FPS adjustment (', fps, 'fps):', fpsAdjustmentFactor);
            console.log('  - Resolution adjustment (', mediaResolution, '):', resolutionAdjustmentFactor);
            console.log('  - Total segment tokens:', segmentTokensAdjusted);
            if (numRequests > 1) {
                console.log('  - Will split into', numRequests, 'requests');
                console.log('  - Tokens per request:', tokensPerRequest);
            }

            return tokensPerRequest;
        } catch (error) {
            console.error('Error counting tokens with Gemini API:', error);
            setTokenCountError(error.message);
            return null;
        } finally {
            setIsCountingTokens(false);
        }
    };

    // Calculate estimated token usage based on official Gemini API documentation
    const calculateEstimatedTokens = () => {
        if (!tokenCountingEnabled || !selectedSegment) return 0;

        const segmentDuration = selectedSegment.end - selectedSegment.start;
        const resolution = resolutionOptions.find(r => r.value === mediaResolution);
        const frameTokens = resolution ? resolution.tokens : 256; // Default to medium resolution
        const audioTokens = 32; // tokens per second for audio (official documentation)

        // Calculate total tokens for the segment
        const totalSegmentTokens = Math.round(segmentDuration * (fps * frameTokens + audioTokens));

        // Account for parallel processing splitting (same logic as real token counting)
        const numRequests = Math.ceil(segmentDuration / (maxDurationPerRequest * 60));

        // Return tokens per request when splitting, otherwise total
        return numRequests > 1
            ? Math.round(totalSegmentTokens / numRequests)
            : totalSegmentTokens;
    };

    // Automatic token counting when modal opens or settings change - throttled to prevent excessive API calls
    useEffect(() => {
        if (tokenCountingEnabled && isOpen && videoFile && selectedSegment) {
            // Create a 1 second delay before making the API call
            const timeoutId = setTimeout(() => {
                console.log('[TokenCounting] Auto-counting tokens after throttle delay');
                const performTokenCount = async () => {
                    const count = await countTokensWithGeminiAPI(videoFile);
                    if (count !== null) {
                        setRealTokenCount(count);
                    }
                };
                performTokenCount();
            }, 1000); // 1 second throttle delay

            // Cleanup function to cancel pending API calls when dependencies change
            return () => {
                console.log('[TokenCounting] Canceling pending token count due to settings change');
                clearTimeout(timeoutId);
            };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tokenCountingEnabled, isOpen, videoFile, selectedSegment, fps, mediaResolution, selectedModel, selectedPromptPreset, customLanguage, useTranscriptionRules, maxDurationPerRequest, method]);

    // Dispatch toast notifications for token count errors
    useEffect(() => {
        if (tokenCountError) {
            showErrorToast(`${t('processing.tokenCountError', 'Error counting tokens')}: ${tokenCountError}`);
        }
    }, [tokenCountError, t]);

    const estimatedTokens = calculateEstimatedTokens();
    const displayTokens = realTokenCount !== null ? realTokenCount : estimatedTokens;

    return { realTokenCount, estimatedTokens, displayTokens, isCountingTokens, tokenCountError };
};

export default useTokenCounting;
