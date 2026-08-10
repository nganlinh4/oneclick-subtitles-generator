/**
 * Utility functions for handling media (video and audio) durations
 */

/**
 * Get the segment duration in minutes from localStorage
 * @returns {number} - Segment duration in minutes
 */
export const getSegmentDurationMinutes = () => {
    const savedDuration = parseInt(localStorage.getItem('segment_duration') || '5');
    // Ensure the value is within the allowed range: 1 to 45 minutes
    if (savedDuration >= 1 && savedDuration <= 45) {
        return savedDuration;
    }
    return 5; // Default to 5 minutes if out of range
};

/**
 * Calculate the segment duration in seconds
 * @returns {number} - Segment duration in seconds
 */
export const getMaxSegmentDurationSeconds = () => getSegmentDurationMinutes() * 60;

/**
 * Get the duration of a media file (video or audio)
 * @param {File} mediaFile - The media file (video or audio)
 * @returns {Promise<number>} - The duration in seconds
 */
export const getVideoDuration = (mediaFile) => {
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

/**
 * Alias for getVideoDuration to maintain backward compatibility
 * @param {File} mediaFile - The media file (video or audio)
 * @returns {Promise<number>} - The duration in seconds
 */
export const getMediaDuration = getVideoDuration;

/**
 * Create a media segment from the original file
 * @param {File} originalFile - The original media file (video or audio)
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @param {number} segmentIndex - Index of the segment
 * @returns {File} - A new File object representing the segment
 */
export const createVideoSegment = (originalFile, startTime, endTime, segmentIndex) => {
    // Since we can't actually split the media in the browser,
    // we'll create a reference to the original file with metadata
    // about the segment's time range
    const isAudio = originalFile.type.startsWith('audio/');
    const extension = isAudio ? 'mp3' : 'mp4';

    const segmentFile = new File([originalFile], `segment_${segmentIndex}.${extension}`, {
        type: originalFile.type,
        lastModified: originalFile.lastModified
    });

    // Attach metadata to the file object
    segmentFile.segmentStartTime = startTime;
    segmentFile.segmentEndTime = endTime;
    segmentFile.segmentIndex = segmentIndex;
    segmentFile.originalFileName = originalFile.name;

    return segmentFile;
};
