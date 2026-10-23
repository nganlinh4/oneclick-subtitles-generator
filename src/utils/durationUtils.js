/**
 * Utility functions for handling media (video and audio) durations
 */

import { inspectMediaPipelineAsset } from '../platform/mediaPipelineService';
import { isNativeMediaDescriptor } from '../platform/mediaService';

/**
 * Get the duration of a media file (video or audio)
 * @param {File} mediaFile - The media file (video or audio)
 * @returns {Promise<number>} - The duration in seconds
 */
export const getVideoDuration = async (mediaFile) => {
    if (isNativeMediaDescriptor(mediaFile)) {
        const inspection = await inspectMediaPipelineAsset(mediaFile.assetId);
        if (!Number.isSafeInteger(inspection?.durationUs) || inspection.durationUs <= 0) {
            throw new Error('The native media duration is unavailable.');
        }
        return inspection.durationUs / 1_000_000;
    }

    return new Promise((resolve) => {
        if (!mediaFile) {
            console.error('No media file provided to getVideoDuration');
            // Use a fallback duration instead of failing
            return resolve(600); // 10 minutes fallback
        }

        // Check if the file has a valid type
        if (!mediaFile.type) {
            console.warn('Media file has no type, assuming video/mp4');
            mediaFile = new File([mediaFile], mediaFile.name || 'video.mp4', { type: 'video/mp4' });
        }

        // Determine if this is a video or audio file based on MIME type or name
        const isAudio = mediaFile.type.startsWith('audio/') ||
                       (mediaFile.name && /\.(mp3|wav|ogg|aac|flac)$/i.test(mediaFile.name));

        const isVideo = mediaFile.type.startsWith('video/') ||
                       (mediaFile.name && /\.(mp4|webm|mov|avi|mkv)$/i.test(mediaFile.name)) ||
                       (!isAudio); // Default to video if not explicitly audio

        if (isVideo) {
            // Use video element for video files
            const video = document.createElement('video');
            video.preload = 'metadata';

            video.onloadedmetadata = () => {
                window.URL.revokeObjectURL(video.src);
                resolve(video.duration);
            };

            video.onerror = (e) => {
                console.error('Error loading video metadata:', e);
                window.URL.revokeObjectURL(video.src);
                // Use a fallback duration instead of failing

                resolve(600); // 10 minutes fallback
            };

            try {
                video.src = URL.createObjectURL(mediaFile);
            } catch (error) {
                console.error('Error creating object URL:', error);
                // Use a fallback duration instead of failing

                resolve(600); // 10 minutes fallback
            }
        } else if (isAudio) {
            // Use audio element for audio files
            const audio = document.createElement('audio');
            audio.preload = 'metadata';

            audio.onloadedmetadata = () => {
                window.URL.revokeObjectURL(audio.src);
                resolve(audio.duration);
            };

            audio.onerror = (e) => {
                console.error('Error loading audio metadata:', e);
                window.URL.revokeObjectURL(audio.src);
                // Use a fallback duration instead of failing

                resolve(600); // 10 minutes fallback
            };

            try {
                audio.src = URL.createObjectURL(mediaFile);
            } catch (error) {
                console.error('Error creating object URL:', error);
                // Use a fallback duration instead of failing

                resolve(600); // 10 minutes fallback
            }
        } else {
            console.warn('Unsupported file type, using fallback duration');
            resolve(600); // 10 minutes fallback
        }
    });
};
