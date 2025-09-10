import { useState, useEffect } from 'react';

/**
 * Custom hook to track current video information and available versions
 * @param {Object} selectedVideo - Currently selected video object
 * @param {Object} uploadedFile - Currently uploaded file object
 * @param {string} actualVideoUrl - Actual video URL being played
 * @returns {Object} Video information and available versions
 */
export const useVideoInfo = (selectedVideo, uploadedFile, actualVideoUrl) => {
  const [videoInfo, setVideoInfo] = useState(null);
  const [availableVersions, setAvailableVersions] = useState([]);
  const [actualDimensions, setActualDimensions] = useState(null);

  useEffect(() => {
    const updateVideoInfo = () => {
      let info = null;
      let versions = [];



      // Priority 1: Check if we have a selectedVideo (downloaded video) - this is the original source
      if (selectedVideo) {
        // Check if optimization is enabled
        const optimizeVideos = localStorage.getItem('optimize_videos') === 'true';
        // Use actual dimensions if available, otherwise fall back to localStorage
        const currentQuality = actualDimensions?.quality || localStorage.getItem('optimized_resolution') || '360p';

        info = {
          source: selectedVideo.source, // This preserves the original source (youtube, douyin, all-sites)
          title: selectedVideo.title,
          quality: optimizeVideos ? currentQuality : 'Original',
          isOptimized: optimizeVideos, // Only optimized if optimization is enabled
          url: selectedVideo.url, // Original URL for redownloading
          id: selectedVideo.id
        };

        // For downloaded videos, we don't show version options since they can redownload
        // The split_result versions are just processing artifacts
      }
      // Priority 2: Check if we have an uploaded file
      else if (uploadedFile) {
        // Check if this "uploaded" file is actually a downloaded video
        // This happens when videos are downloaded and then processed as uploads
        const storedVideoUrl = localStorage.getItem('current_video_url');

        console.log('[useVideoInfo] Uploaded file detection:', {
          fileName: uploadedFile.name,
          storedVideoUrl,
          includesYouTube: uploadedFile.name.includes('YouTube Video'),
          includesDouyin: uploadedFile.name.includes('Douyin Video'),
          includesVideoFrom: uploadedFile.name.includes('Video from'),
          endsWithMp4: uploadedFile.name.endsWith('.mp4'),
          hasStoredUrl: !!storedVideoUrl
        });

        // More robust detection - if we have a stored video URL, it's likely a downloaded video
        // regardless of the filename (since filenames can be changed during processing)
        const isDownloadedVideo = !!storedVideoUrl || (
          uploadedFile.name.includes('YouTube Video') ||
          uploadedFile.name.includes('Douyin Video') ||
          uploadedFile.name.includes('Video from') ||
          uploadedFile.name.includes('youtube.com') ||
          uploadedFile.name.includes('youtu.be') ||
          uploadedFile.name.includes('douyin.com')
        );

        console.log('[useVideoInfo] Is downloaded video?', isDownloadedVideo);

        if (isDownloadedVideo) {
          // This is actually a downloaded video, treat it as such
          let source = 'unknown';
          let title = 'Downloaded Video';

          if (storedVideoUrl) {
            // We have the original URL, determine source from it
            if (storedVideoUrl.includes('youtube.com') || storedVideoUrl.includes('youtu.be')) {
              source = 'youtube';
              title = 'YouTube Video';
            } else if (storedVideoUrl.includes('douyin.com')) {
              source = 'douyin';
              title = 'Douyin Video';
            } else {
              source = 'all-sites';
              try {
                const hostname = new URL(storedVideoUrl).hostname;
                const siteName = hostname.replace(/^www\./, '');
                title = `Video from ${siteName}`;
              } catch (e) {
                title = 'Web Video';
              }
            }
          } else {
            // No stored URL, determine from filename
            if (uploadedFile.name.includes('YouTube Video')) {
              source = 'youtube';
              title = 'YouTube Video';
            } else if (uploadedFile.name.includes('Douyin Video')) {
              source = 'douyin';
              title = 'Douyin Video';
            } else if (uploadedFile.name.includes('Video from')) {
              source = 'all-sites';
              title = uploadedFile.name.replace('.mp4', '');
            }
          }

          // Check if optimization is enabled
          const optimizeVideos = localStorage.getItem('optimize_videos') === 'true';
          // Use actual dimensions if available, otherwise fall back to localStorage
          const currentQuality = actualDimensions?.quality || localStorage.getItem('optimized_resolution') || '360p';

          info = {
            source,
            title,
            quality: optimizeVideos ? currentQuality : 'Original',
            isOptimized: optimizeVideos, // Only optimized if optimization is enabled
            url: storedVideoUrl || null // Original URL for redownloading (may be null)
          };


        } else {
          // This is an actual uploaded file
          info = {
            source: 'upload',
            title: uploadedFile.name,
            quality: 'original',
            isOptimized: false,
            url: actualVideoUrl
          };

          // Check for available versions from localStorage (only for actual uploads)
          const splitResult = localStorage.getItem('split_result');
          if (splitResult) {
            try {
              const result = JSON.parse(splitResult);

              // Add original version
              if (result.originalMedia) {
                versions.push({
                  type: 'original',
                  path: result.originalMedia,
                  quality: 'original',
                  title: 'Original Quality'
                });
              }

              // Add optimized version
              if (result.optimized && result.optimized.video) {
                versions.push({
                  type: 'optimized',
                  path: result.optimized.video,
                  quality: result.optimized.resolution || '360p',
                  resolution: result.optimized.resolution,
                  fps: result.optimized.fps,
                  width: result.optimized.width,
                  height: result.optimized.height,
                  title: `Optimized (${result.optimized.resolution || '360p'})`
                });

                // Update info if currently using optimized version
                if (actualVideoUrl && actualVideoUrl.includes(result.optimized.video)) {
                  info.isOptimized = true;
                  info.quality = result.optimized.resolution || '360p';
                }
              }
            } catch (error) {
              console.error('Error parsing split result:', error);
            }
          }
        }
      }
      // Priority 3: Check if we have a video URL in localStorage but no selectedVideo (after processing)
      else {
        const storedVideoUrl = localStorage.getItem('current_video_url');
        if (storedVideoUrl) {
          // Try to determine source from stored URL
          let source = 'unknown';
          let title = 'Downloaded Video';

          if (storedVideoUrl.includes('youtube.com') || storedVideoUrl.includes('youtu.be')) {
            source = 'youtube';
            title = 'YouTube Video';
          } else if (storedVideoUrl.includes('douyin.com')) {
            source = 'douyin';
            title = 'Douyin Video';
          } else {
            source = 'all-sites';
            try {
              const hostname = new URL(storedVideoUrl).hostname;
              const siteName = hostname.replace(/^www\./, '');
              title = `Video from ${siteName}`;
            } catch (e) {
              title = 'Web Video';
            }
          }

          // Check if optimization is enabled
          const optimizeVideos = localStorage.getItem('optimize_videos') === 'true';
          // Use actual dimensions if available, otherwise fall back to localStorage
          const currentQuality = actualDimensions?.quality || localStorage.getItem('optimized_resolution') || '360p';

          info = {
            source,
            title,
            quality: optimizeVideos ? currentQuality : 'Original',
            isOptimized: optimizeVideos, // Only optimized if optimization is enabled
            url: storedVideoUrl // Original URL for redownloading
          };


        }
        // Priority 4: Check if we have a video URL without selectedVideo (edge case)
        else if (actualVideoUrl) {
          // Try to determine source from URL
          let source = 'unknown';
          if (actualVideoUrl.includes('youtube.com') || actualVideoUrl.includes('youtu.be')) {
            source = 'youtube';
          } else if (actualVideoUrl.includes('douyin.com')) {
            source = 'douyin';
          } else if (actualVideoUrl.startsWith('blob:')) {
            source = 'upload';
          }

          info = {
            source,
            title: 'Unknown Video',
            quality: 'unknown',
            isOptimized: false,
            url: actualVideoUrl
          };
        }
      }

      setVideoInfo(info);
      setAvailableVersions(versions);
    };

    updateVideoInfo();
  }, [selectedVideo, uploadedFile, actualVideoUrl]);

  // Separate useEffect for fetching dimensions to avoid infinite loops
  useEffect(() => {
    let videoIdToFetch = null;

    // Determine which video ID we should fetch dimensions for
    if (selectedVideo && selectedVideo.id) {
      videoIdToFetch = selectedVideo.id;
    } else if (uploadedFile) {
      const videoId = uploadedFile.name.replace('.mp4', '');
      videoIdToFetch = videoId;
    } else if (actualVideoUrl && !actualVideoUrl.startsWith('blob:')) {
      // Try to extract video ID from the file path or URL
      if (actualVideoUrl.includes('/videos/')) {
        let fullVideoId = actualVideoUrl.split('/videos/')[1].replace('.mp4', '');
        // Remove timestamp suffix if present (e.g., _1757126832233)
        const timestampMatch = fullVideoId.match(/(.+)_\d{13}$/);
        if (timestampMatch) {
          videoIdToFetch = timestampMatch[1];
        } else {
          videoIdToFetch = fullVideoId;
        }
      }
    }

    // Only fetch if we don't already have dimensions for this video ID
    if (videoIdToFetch && (!actualDimensions || actualDimensions.videoId !== videoIdToFetch)) {
      fetchActualDimensions(`http://localhost:3031/videos/${videoIdToFetch}.mp4`);
    }
  }, [selectedVideo?.id, uploadedFile?.name, actualVideoUrl]);

  // Update video info when actual dimensions are fetched
  useEffect(() => {
    if (actualDimensions) {
      setVideoInfo(prev => {
        // Only update if we have previous videoInfo and the quality is different
        if (prev && prev.quality !== actualDimensions.quality) {
          return {
            ...prev,
            quality: actualDimensions.quality
          };
        }
        return prev;
      });
    }
  }, [actualDimensions]);

  /**
   * Fetch actual video dimensions from the server
   */
  const fetchActualDimensions = async (videoUrl) => {
    // Extract video ID from URL
    let videoId = null;

    if (videoUrl && videoUrl.includes('/videos/')) {
      const urlParts = videoUrl.split('/videos/');
      if (urlParts.length > 1) {
        let fullVideoId = urlParts[1].replace('.mp4', '');
        // Remove timestamp suffix if present (e.g., _1757126832233)
        const timestampMatch = fullVideoId.match(/(.+)_\d{13}$/);
        if (timestampMatch) {
          videoId = timestampMatch[1];
        } else {
          videoId = fullVideoId;
        }
      }
    }

    if (!videoId) {
      return null;
    }

    // Check if we already have dimensions for this video ID
    if (actualDimensions && actualDimensions.videoId === videoId) {
      return actualDimensions;
    }

    try {
      const response = await fetch(`http://localhost:3031/api/video-dimensions/${videoId}`);
      const data = await response.json();

      if (data.success) {
        setActualDimensions(data);
        return data;
      } else {
        return null;
      }
    } catch (error) {
      return null;
    }
  };

  /**
   * Get video information for quality modal
   */
  const getVideoInfoForModal = () => {
    // Use actual dimensions if available, otherwise fall back to stored quality
    const currentQuality = actualDimensions?.quality || videoInfo?.quality || '360p';



    return {
      videoInfo: {
        ...videoInfo,
        quality: currentQuality // Override with actual quality
      },
      availableVersions,
      hasMultipleVersions: availableVersions.length > 1,
      canRedownload: videoInfo?.source && ['youtube', 'douyin', 'all-sites'].includes(videoInfo.source),
      actualDimensions
    };
  };

  /**
   * Redownload video with specific quality
   */
  const redownloadWithQuality = async (quality, url, videoId = null) => {
    if (!url) {
      throw new Error('No video URL to redownload');
    }

    try {
      // If videoId is provided, the download was already started by the modal
      // Just construct the URL from the existing download
      if (videoId) {
        const videoUrl = `http://localhost:3031/videos/${videoId}_${quality}.mp4`;
        console.log('[useVideoInfo] Using pre-downloaded video URL:', videoUrl);
        return videoUrl;
      }

      // Fallback: start a new download (shouldn't happen with the new flow)
      const response = await fetch('http://localhost:3031/api/download-video-quality', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          url: url,
          quality: quality,
          videoId: `quality_${Date.now()}`,
          useCookies: localStorage.getItem('use_cookies_for_download') === 'true'
        }),
      });

      if (!response.ok) {
        let bodyText = '';
        try {
          bodyText = await response.text();
        } catch (_) {}
        throw new Error(`[download-video-quality] HTTP ${response.status} ${response.statusText}${bodyText ? ` - ${bodyText.slice(0, 300)}` : ''}`);
      }

      let data;
      try {
        data = await response.json();
      } catch (e) {
        throw new Error(`[download-video-quality] Failed to parse JSON response: ${e?.message || e}`);
      }
      console.log('[useVideoInfo] Redownload response:', data);

      if (data.success) {
        // Return the server URL for the downloaded video
        const videoUrl = `http://localhost:3031${data.videoPath}`;
        console.log('[useVideoInfo] Redownloaded video URL:', videoUrl);
        return videoUrl;
      } else {
        throw new Error(data.error || 'Failed to download video');
      }
    } catch (error) {
      console.error('Error downloading video with quality:', error);
      throw error;
    }
  };

  /**
   * Get video file for rendering based on selected version
   */
  const getVideoFileForRendering = async (option, data = {}) => {
    if (option === 'current') {
      // Prefer using the original uploaded file when available (most robust)
      if (uploadedFile && typeof uploadedFile === 'object' && typeof uploadedFile.arrayBuffer === 'function') {
        return uploadedFile;
      }

      // Use current video URL
      if (actualVideoUrl) {
        if (actualVideoUrl.startsWith('blob:')) {
          // Try to reuse the blob from the global map (created in VideoPreview) to avoid fetching a revoked blob URL
          try {
            if (typeof window !== 'undefined' && window.__videoBlobMap && window.__videoBlobMap[actualVideoUrl]) {
              const blob = window.__videoBlobMap[actualVideoUrl];
              return new File([blob], videoInfo?.title || 'video.mp4', { type: blob.type || 'video/mp4' });
            }
          } catch {}

          // Fallback: attempt to fetch the blob URL (may fail if revoked)
          try {
            const response = await fetch(actualVideoUrl);
            if (!response.ok) {
              const txt = await response.text().catch(() => '');
              throw new Error(`Fetching blob video failed with HTTP ${response.status} ${response.statusText}${txt ? ` - ${txt.slice(0, 300)}` : ''}`);
            }
            const blob = await response.blob();
            return new File([blob], videoInfo?.title || 'video.mp4', { type: 'video/mp4' });
          } catch (err) {
            throw new Error(`Failed to fetch current blob video for rendering. The temporary blob URL may have been revoked/expired. Try re-adding the video. Original error: ${err?.message || err}`);
          }
        } else {
          // Return URL object for server-hosted videos
          return {
            url: actualVideoUrl,
            isActualVideo: true,
            name: videoInfo?.title || 'video.mp4'
          };
        }
      }
      throw new Error('No current video available');
    } else if (option === 'redownload') {
      // Redownload with specific quality
      const newVideoUrl = await redownloadWithQuality(data.quality, data.url, data.videoId);
      return {
        url: newVideoUrl,
        isActualVideo: true,
        name: `${videoInfo?.title || 'video'}_${data.quality}.mp4`
      };
    } else if (option === 'version' && data.version) {
      // Use specific version
      const version = data.version;
      const serverUrl = 'http://localhost:3031'; // Using unified port configuration
      const fullUrl = version.path.startsWith('http') ? version.path : `${serverUrl}${version.path}`;
      
      return {
        url: fullUrl,
        isActualVideo: true,
        name: version.title || videoInfo?.title || 'video.mp4'
      };
    }
    
    throw new Error('Invalid option for video file selection');
  };

  return {
    videoInfo,
    availableVersions,
    actualDimensions,
    getVideoInfoForModal,
    redownloadWithQuality,
    getVideoFileForRendering,
    fetchActualDimensions
  };
};
