import { extractYoutubeVideoId, downloadYoutubeVideo } from '../../utils/videoDownloader';
import { extractDouyinVideoId, downloadDouyinVideo } from '../../utils/douyinDownloader';
import { downloadGenericVideo } from '../../utils/allSitesDownloader';

// Function to ensure video compatibility
// eslint-disable-next-line no-unused-vars
const ensureVideoCompatibility = async (videoFile) => {
  try {
    // Check if we need to convert the video for compatibility
    const response = await fetch('/api/video/ensure-compatibility', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        videoPath: videoFile.name || 'uploaded-video.mp4'
      })
    });

    if (response.ok) {
      const result = await response.json();
      if (result.converted) {
        console.log('[VideoProcessing] Video was converted for compatibility');
        // Return a new file object pointing to the converted video
        const convertedResponse = await fetch(result.path);
        const convertedBlob = await convertedResponse.blob();
        return new File([convertedBlob], result.filename, { type: 'video/mp4' });
      }
    }

    // Return original file if no conversion needed or conversion failed
    return videoFile;
  } catch (error) {
    console.warn('[VideoProcessing] Compatibility check failed, using original video:', error);
    return videoFile;
  }
};

/**
 * Prepare video for segment processing by optimizing and splitting
 * @param {File} videoFile - The video file to prepare
 * @param {Function} setStatus - Function to update status
 * @param {Function} setVideoSegments - Function to update video segments
 * @param {Function} setSegmentsStatus - Function to update segments status
 * @param {Function} t - Translation function
 * @returns {Promise<Object>} - Object containing segment information
 */
// eslint-disable-next-line no-unused-vars
export const prepareVideoForSegments = async (videoFile, setStatus, setVideoSegments, setSegmentsStatus, t = (key, defaultValue) => defaultValue) => {
  // Legacy function - parameters kept for compatibility but not used
  try {
    if (!videoFile) {
      throw new Error('No video file provided');
    }

    // Log the video file details


    // Check if the file size is reasonable
    if (videoFile.size < 100 * 1024) { // Less than 100KB
      console.error(`Video file is too small (${videoFile.size} bytes), likely not a valid video`);
      throw new Error(`Video file is too small (${videoFile.size} bytes), likely not a valid video`);
    }

    // Get video optimization settings from localStorage
    const optimizeVideos = localStorage.getItem('optimize_videos') === 'true';
    const optimizedResolution = localStorage.getItem('optimized_resolution') || '360p'; // Default to 360p

    // Set status to loading
    setStatus({ message: t('output.preparingVideo', 'Preparing video for segment processing...'), type: 'loading' });

    // Get video duration (for future use)
    // await getVideoDuration(videoFile);


    // Calculate number of segments (for future use)
    // Math.ceil(duration / getMaxSegmentDurationSeconds());


    // For downloaded videos, ensure we have a proper file name and type
    let processedVideoFile = videoFile;

    // If the file doesn't have a proper name or type, create a new File object
    if (!videoFile.name || !videoFile.type) {


      // Create a new File object with proper metadata
      processedVideoFile = new File(
        [videoFile],
        videoFile.name || `video_${Date.now()}.mp4`,
        { type: videoFile.type || 'video/mp4' }
      );


    }

    // Legacy video splitting is no longer supported
    throw new Error('Video splitting is deprecated. Please enable "Use Simplified Processing" in settings for better performance.');
  } catch (error) {
    console.error('Error preparing video for segments:', error);
    setStatus({
      message: t('errors.videoPreparationFailed', 'Video preparation failed: {{message}}', { message: error.message }),
      type: 'error'
    });
    throw error;
  }
};

/**
 * Download a YouTube or Douyin video and prepare it for segment processing
 * This is used when subtitles are loaded from cache for a video
 */
export const downloadAndPrepareYouTubeVideo = async (
  selectedVideo,
  setIsDownloading,
  setDownloadProgress,
  setStatus,
  setCurrentDownloadId,
  handleTabChange,
  setUploadedFile,
  setIsSrtOnlyMode,
  t = (key, defaultValue) => defaultValue
) => {
  if (!selectedVideo) {
    console.error('No video selected');
    return;
  }

  try {
    // Set downloading state to true to disable the generate button
    setIsDownloading(true);
    setDownloadProgress(0);
    setStatus({ message: t('output.downloadingVideo', 'Downloading video...'), type: 'loading' });

    let videoId;
    let videoUrl;

    // Check the source of the video
    if (selectedVideo.source === 'douyin') {
      // Extract Douyin video ID and set it as current download
      videoId = extractDouyinVideoId(selectedVideo.url);
      setCurrentDownloadId(videoId);

      videoUrl = await downloadDouyinVideo(
        selectedVideo.url,
        (progress) => {
          setDownloadProgress(progress);
        }
      );
    } else if (selectedVideo.source === 'all-sites') {
      // For generic URLs using yt-dlp
      videoId = selectedVideo.id;
      setCurrentDownloadId(videoId);

      try {


        // downloadGenericVideo now returns a File object directly
        const videoFile = await downloadGenericVideo(
          selectedVideo.url,
          (progress) => {
            setDownloadProgress(progress);
          }
        );

        // Validate the file
        if (!videoFile || !(videoFile instanceof File)) {
          console.error('Invalid video file returned from downloadGenericVideo');
          throw new Error('Invalid video file returned');
        }



        // Create an object URL for the file
        videoUrl = URL.createObjectURL(videoFile);
        
        // Store blob URL and file in proper places for waveform processing
        localStorage.setItem('current_file_url', videoUrl);
        if (!window.__videoBlobMap) window.__videoBlobMap = {};
        window.__videoBlobMap[videoUrl] = videoFile;
        console.log('[VideoProcessingHandlers] Created and stored blob URL for all-sites video:', videoUrl);

        // Store the file for later use
        window.downloadedVideoFile = videoFile;
      } catch (error) {
        console.error('Error downloading video from all-sites:', error);

        // Try to fetch the video directly as a fallback


        try {
          // The videoId might have changed during the download process
          // Try to get the latest videoId from the error message or use the original one
          let latestVideoId = videoId;
          if (error.message && error.message.includes('site_')) {
            const match = error.message.match(/site_[a-zA-Z0-9_]+/);
            if (match) {
              latestVideoId = match[0];

            }
          }

          const response = await fetch(`/videos/${latestVideoId}.mp4`);

          if (!response.ok) {
            throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);
          }

          const blob = await response.blob();

          // Check if the blob has a reasonable size
          if (blob.size < 1000) { // Less than 1KB
            throw new Error(`Video file is too small (${blob.size} bytes), likely not a valid video`);
          }

          const videoFile = new File([blob], `${latestVideoId}.mp4`, { type: 'video/mp4' });



          // Create an object URL for the file
          videoUrl = URL.createObjectURL(videoFile);
          
          // Store blob URL and file in proper places for waveform processing
          localStorage.setItem('current_file_url', videoUrl);
          if (!window.__videoBlobMap) window.__videoBlobMap = {};
          window.__videoBlobMap[videoUrl] = videoFile;
          console.log('[VideoProcessingHandlers] Created and stored blob URL for fallback video:', videoUrl);

          // Store the file for later use
          window.downloadedVideoFile = videoFile;
        } catch (fallbackError) {
          console.error('Fallback method failed:', fallbackError);
          throw new Error(`Failed to download video: ${error.message}. Fallback also failed: ${fallbackError.message}`);
        }
      }
    } else {
      // Default to YouTube
      // Extract video ID and set it as current download
      videoId = extractYoutubeVideoId(selectedVideo.url);
      setCurrentDownloadId(videoId);

      videoUrl = await downloadYoutubeVideo(
        selectedVideo.url,
        (progress) => {
          setDownloadProgress(progress);
        },
        false, // forceRefresh
        localStorage.getItem('use_cookies_for_download') === 'true' // useCookies
      );
    }

    // Clear the current download ID when done
    setCurrentDownloadId(null);

    // Check if download was cancelled (videoUrl will be null)
    if (!videoUrl) {
      console.log('[downloadAndPrepareYouTubeVideo] Download was cancelled, stopping processing');
      setIsDownloading(false);
      setStatus({ message: t('download.downloadOnly.cancelled', 'Download cancelled'), type: 'warning' });
      return;
    }

    try {
      // Initialize blob variable
      let blob;

      // Check if we already have a downloaded file
      if (selectedVideo.source === 'all-sites' && window.downloadedVideoFile) {

        blob = window.downloadedVideoFile;

      } else {
        // For blob URLs, we need to handle them differently
        if (videoUrl.startsWith('blob:')) {


          // If we have a downloaded file, use it directly
          if (window.downloadedVideoFile) {

            blob = window.downloadedVideoFile;

            // Check if the blob has a reasonable size
            if (blob.size < 100 * 1024) { // Less than 100KB
              console.error(`Downloaded file is too small (${blob.size} bytes), likely not a valid video`);
              throw new Error(`Downloaded file is too small (${blob.size} bytes), likely not a valid video`);
            }
          } else {
            // If we don't have a downloaded file, try to fetch the video ID from the server


            // Extract the video ID from the selectedVideo
            const videoId = selectedVideo.id;

            if (!videoId) {
              throw new Error('No video ID available to fetch from server');
            }

            // Fetch the video directly from the server
            const serverUrl = 'http://localhost:3031';
            const directResponse = await fetch(`${serverUrl}/videos/${videoId}.mp4?t=${Date.now()}`, {
              method: 'GET',
              cache: 'no-cache'
            });

            if (!directResponse.ok) {
              throw new Error(`Failed to fetch video from server: ${directResponse.status} ${directResponse.statusText}`);
            }


            const directBlob = await directResponse.blob();


            // Check if the blob has a reasonable size
            if (directBlob.size < 100 * 1024) { // Less than 100KB
              throw new Error(`Downloaded blob is too small (${directBlob.size} bytes), likely not a valid video`);
            }

            // Create a File object from the blob
            const file = new File([directBlob], `${videoId}.mp4`, { type: 'video/mp4' });
            window.downloadedVideoFile = file;
            blob = file;
          }
        } else {
          // Check if this is an external URL that might cause CORS issues
          const isExternalUrl = videoUrl.startsWith('http://') || videoUrl.startsWith('https://') && 
                              !videoUrl.startsWith('http://localhost') && 
                              !videoUrl.startsWith('http://127.0.0.1');
          
          // For all-sites videos with external URLs, skip direct fetch and go straight to server fallback
          if (selectedVideo.source === 'all-sites' && isExternalUrl) {
            console.log('[VideoProcessingHandlers] Skipping direct fetch of external URL to avoid CORS, using server fallback');
            
            // Extract the video ID from the URL or use the selectedVideo.id
            const videoId = selectedVideo.id;

            // Fetch the video directly from the server - using unified port configuration
            const serverUrl = 'http://localhost:3031';
            const serverResponse = await fetch(`${serverUrl}/videos/${videoId}.mp4?t=${Date.now()}`, {
              method: 'GET',
              cache: 'no-cache'
            });

            if (!serverResponse.ok) {
              throw new Error(`Failed to fetch video from server: ${serverResponse.status} ${serverResponse.statusText}`);
            }

            const serverBlob = await serverResponse.blob();

            // Check if the blob has a reasonable size
            if (serverBlob.size < 100 * 1024) { // Less than 100KB
              throw new Error(`Downloaded blob is too small (${serverBlob.size} bytes), likely not a valid video`);
            }

            // Create a File object from the blob
            const file = new File([serverBlob], `${videoId}.mp4`, { type: 'video/mp4' });
            window.downloadedVideoFile = file;
            blob = file;
          } else {
            // For local URLs or non-all-sites videos, fetch as normal
            // Add a timestamp to avoid caching issues
            const fetchUrl = videoUrl.includes('?')
              ? `${videoUrl}&t=${Date.now()}`
              : `${videoUrl}?t=${Date.now()}`;

            try {
              const response = await fetch(fetchUrl, {
                method: 'GET',
                cache: 'no-cache' // Ensure we don't get a cached response
              });

              // Check if the response is ok
              if (!response.ok) {
                throw new Error(`Failed to fetch video: ${response.status} ${response.statusText}`);
              }

              blob = await response.blob();

            } catch (error) {
              console.error('Error fetching video:', error);

              // If this is an all-sites video, try to fetch it directly from the server
              if (selectedVideo.source === 'all-sites') {
                // Extract the video ID from the URL or use the selectedVideo.id
                const videoId = selectedVideo.id;

                // Fetch the video directly from the server - using unified port configuration
                const serverUrl = 'http://localhost:3031';
                const retryResponse = await fetch(`${serverUrl}/videos/${videoId}.mp4?t=${Date.now()}`, {
                  method: 'GET',
                  cache: 'no-cache'
                });

                if (!retryResponse.ok) {
                  throw new Error(`Failed to fetch video from server: ${retryResponse.status} ${retryResponse.statusText}`);
                }

                const retryBlob = await retryResponse.blob();

                // Check if the blob has a reasonable size
                if (retryBlob.size < 100 * 1024) { // Less than 100KB
                  throw new Error(`Downloaded blob is too small (${retryBlob.size} bytes), likely not a valid video`);
                }

                // Create a File object from the blob
                const file = new File([retryBlob], `${videoId}.mp4`, { type: 'video/mp4' });
                window.downloadedVideoFile = file;
                blob = file;
              } else {
                throw error;
              }
            }
          }
        }
      }

      // Check if the blob has content (not empty)
      if (blob.size === 0) {
        throw new Error('Downloaded video is empty. The file may have been deleted from the server.');
      }

      // Check if the blob has a reasonable size
      if (blob.size < 100 * 1024) { // Less than 100KB
        console.error(`Downloaded blob is too small (${blob.size} bytes), likely not a valid video`);

        // If this is an all-sites video, try to fetch it directly from the server
        if (selectedVideo.source === 'all-sites') {


          // Extract the video ID from the URL or use the selectedVideo.id
          const videoId = selectedVideo.id;

          // Fetch the video directly from the server
          const serverUrl = 'http://localhost:3031';
          const retryResponse = await fetch(`${serverUrl}/videos/${videoId}.mp4?t=${Date.now()}`, {
            method: 'GET',
            cache: 'no-cache'
          });

          if (retryResponse.ok) {

            const retryBlob = await retryResponse.blob();


            // Check if the retry blob has a reasonable size
            if (retryBlob.size < 100 * 1024) { // Less than 100KB
              throw new Error(`Retry blob is too small (${retryBlob.size} bytes), likely not a valid video`);
            }

            // Use the retry blob instead
            blob = retryBlob;
          } else {
            console.error(`Error fetching video file on retry: ${retryResponse.status} ${retryResponse.statusText}`);
          }
        }

        throw new Error(`Downloaded blob is too small (${blob.size} bytes), likely not a valid video`);
      }

      // Create a File object from the blob
      let file;
      if (selectedVideo.source === 'all-sites' && window.downloadedVideoFile) {
        // Use the already downloaded file
        file = window.downloadedVideoFile;

        // Log the file details


        // Check if the file size is reasonable
        if (file.size < 100 * 1024) { // Less than 100KB
          console.error(`Downloaded file is too small (${file.size} bytes), likely not a valid video`);
          throw new Error(`Downloaded file is too small (${file.size} bytes), likely not a valid video`);
        }

        // Clear the reference
        window.downloadedVideoFile = null;
      } else {
        // Create a new file from the blob
        const filename = `${selectedVideo.title || 'video'}.mp4`;
        file = new File([blob], filename, { type: 'video/mp4' });

        // Mark the file as already being on the server to prevent duplicate uploads
        // This is crucial to avoid creating duplicate videos during splitting
        file.isCopiedToServer = true;
        file.serverPath = `/videos/${videoId}.mp4`;

        // Log the file details


        // Check if the file size is reasonable
        if (file.size < 100 * 1024) { // Less than 100KB
          console.error(`Created file is too small (${file.size} bytes), likely not a valid video`);
          throw new Error(`Created file is too small (${file.size} bytes), likely not a valid video`);
        }
      }

      // Preserve the original video URL before tab change
      const originalVideoUrl = localStorage.getItem('current_video_url');

      // Switch to the upload tab without resetting state (system-initiated, don't update user preference)
      handleTabChange('file-upload', false);

      // Restore the original video URL after tab change (so we can redownload later)
      if (originalVideoUrl) {
        localStorage.setItem('current_video_url', originalVideoUrl);
      }

      // Process the file as if it was uploaded
      const objectUrl = URL.createObjectURL(file);
      localStorage.setItem('current_file_url', objectUrl);

      // Set the uploaded file
      setUploadedFile(file);

      // If we're in SRT-only mode, switch to normal mode since we now have a video
      if (setIsSrtOnlyMode) {
        setIsSrtOnlyMode(false);
      }

      // Reset downloading state
      setIsDownloading(false);
      setDownloadProgress(100);

      // Skip segment preparation here - let the main subtitle generation process handle it
      // This prevents duplicate splitting when generateSubtitles() is called later

      // Update status to show that video is ready
      const isAudio = file?.type?.startsWith('audio/');
      setStatus({ message: isAudio ? t('output.audioReady', 'Audio is ready for processing!') : t('output.videoReady', 'Video is ready for processing!'), type: 'success' });

      // Return the file for further processing
      return file;
    } catch (error) {
      console.error('Error processing downloaded video:', error);
      // Reset downloading state
      setIsDownloading(false);
      setDownloadProgress(0);
      setStatus({
        message: t('errors.videoProcessingFailed', 'Video processing failed: {{message}}', { message: error.message }),
        type: 'error'
      });
    }
  } catch (error) {
    console.error('Error downloading video:', error);
    // Reset downloading state
    setIsDownloading(false);
    setDownloadProgress(0);
    setStatus({ message: `${t('errors.videoDownloadFailed', 'Video download failed')}: ${error.message}`, type: 'error' });
  }
};
