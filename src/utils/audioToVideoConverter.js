/**
 * Utility for immediately converting audio files to video files
 */

/**
 * Generate a hash for an audio file to use for caching
 * @param {File} audioFile - The audio file to hash
 * @returns {Promise<string>} - A promise that resolves to the hash
 */
const generateAudioHash = async (audioFile) => {
    try {
        // Read the first 1MB of the file for hashing
        const maxBytes = 1024 * 1024; // 1MB
        const chunk = audioFile.slice(0, Math.min(maxBytes, audioFile.size));
        const arrayBuffer = await chunk.arrayBuffer();

        // Create a hash of the chunk + file metadata
        const hashBuffer = await crypto.subtle.digest(
            'SHA-256',
            new Uint8Array([...new Uint8Array(arrayBuffer), ...new TextEncoder().encode(`${audioFile.name}_${audioFile.size}`)])
        );

        // Convert hash to hex string
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        // Return first 10 characters of hash for brevity
        return hashHex.substring(0, 10);
    } catch (error) {
        console.error('Error generating audio hash:', error);
        // Fallback to a simple hash based on file properties
        return `${audioFile.name.replace(/[^a-z0-9]/gi, '')}_${audioFile.size}`.substring(0, 10);
    }
};

/**
 * Convert an audio file to video by sending it to the server for conversion
 * @param {File} audioFile - The audio file to convert
 * @param {Function} onStatusUpdate - Optional callback for status updates
 * @returns {Promise<File>} - A new File object with the converted video
 */
export const convertAudioToVideo = async (audioFile, onStatusUpdate = null) => {
    // Check if this is an audio file
    // Include WebM files as they can be audio-only
    if (!audioFile.type.startsWith('audio/') && !audioFile.name.toLowerCase().endsWith('.webm')) {

        return audioFile;
    }

    if (onStatusUpdate) {
        onStatusUpdate({
            message: 'Processing audio...',
            type: 'loading'
        });
    }

    try {



        // Generate a hash for the audio file
        const audioHash = await generateAudioHash(audioFile);


        // Check if we already have a converted version of this audio file
        const checkResponse = await fetch(`http://localhost:3031/api/converted-audio-exists/${audioHash}`);
        const checkResult = await checkResponse.json();

        if (checkResult.exists) {


            // Fetch the existing converted video
            const videoUrl = `http://localhost:3031${checkResult.video}`;
            const videoResponse = await fetch(videoUrl);
            const videoBlob = await videoResponse.blob();

            // Create a File object from the blob
            const videoFile = new File(
                [videoBlob],
                audioFile.name.replace(/\.(mp3|wav|ogg|aac|aiff|flac|mpeg|m4a|wma|opus|amr|au|caf|dts|ac3|ape|mka|ra|webm)$/i, '.mp4'),
                { type: 'video/mp4' }
            );




            return videoFile;
        }

        // No cached version found, proceed with conversion


        // Call the server endpoint to convert audio to video - using unified port configuration
        const formData = new FormData();
        formData.append('file', audioFile);

        const response = await fetch('http://localhost:3031/api/convert-audio-to-video', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Failed to convert audio to video: ${response.status} ${response.statusText}`);
        }

        const result = await response.json();


        // Fetch the converted video as a blob
        const videoUrl = `http://localhost:3031${result.video}`;
        const videoResponse = await fetch(videoUrl);
        const videoBlob = await videoResponse.blob();

        // Create a File object from the blob
        // We'll use a video extension internally, but keep the original name for display
        const videoFile = new File(
            [videoBlob],
            audioFile.name.replace(/\.(mp3|wav|ogg|aac|aiff|flac|mpeg|m4a|wma|opus|amr|au|caf|dts|ac3|ape|mka|ra|webm)$/i, '.mp4'),
            { type: 'video/mp4' }
        );




        return videoFile;
    } catch (error) {
        console.error('Error converting audio to video:', error);
        throw error;
    }
};
