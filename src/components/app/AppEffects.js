import { useEffect } from 'react';
import { initGeminiButtonEffects, resetAllGeminiButtonEffects, disableGeminiButtonEffects } from '../../utils/geminiEffects';
import { syncLocalStorageToServer } from '../../services/localStorageService';
import initTabPillAnimation from '../../utils/tabPillAnimation';
import { getThemeWithFallback } from '../../utils/systemDetection';

/**
 * Hook for managing application side effects
 */
export const useAppEffects = (props) => {
  const {
    setSegmentsStatus,
    setVideoSegments,
    setShowVideoAnalysis,
    setVideoAnalysisResult,
    setStatus,
    setTheme,
    setShowWaveformLongVideos,
    setTimeFormat,
    setOptimizeVideos,
    setOptimizedResolution,
    setUseOptimizedPreview,
    subtitlesData,
    status,
    handleDownloadAndPrepareYouTubeVideo,
    uploadedFile,
    t
  } = props;

  // Initialize UI effects after component mounts
  useEffect(() => {
    // Small delay to ensure DOM is fully rendered
    const timer = setTimeout(() => {
      const effectsEnabled = localStorage.getItem('enable_gemini_effects') !== 'false';
      if (effectsEnabled) {
        // Initialize Gemini button effects
        initGeminiButtonEffects();
      } else {
        // Ensure any residual effects are disabled
        disableGeminiButtonEffects();
      }

      // Initialize tab pill sliding animation
      initTabPillAnimation();
    }, 500);

    return () => clearTimeout(timer);
  }, []);

  // Sync localStorage to server on startup
  useEffect(() => {
    // Sync localStorage to server for use by narration service
    syncLocalStorageToServer()

      .catch(error => console.error('Error syncing localStorage to server:', error));
  }, []);

  // Re-initialize Gemini button effects when subtitles data changes
  useEffect(() => {
    if (subtitlesData && subtitlesData.length > 0) {
      // Use a small delay to ensure the DOM is updated
      const timer = setTimeout(() => {
        const effectsEnabled = localStorage.getItem('enable_gemini_effects') !== 'false';
        if (effectsEnabled) initGeminiButtonEffects();
      }, 500);

      return () => clearTimeout(timer);
    }
  }, [subtitlesData]);

  // Reset all Gemini button effects when status changes
  useEffect(() => {
    if (status && (status.type === 'success' || status.type === 'error')) {
      // Use a small delay to ensure the DOM is updated
      const timer = setTimeout(() => {
        resetAllGeminiButtonEffects();
      }, 500);

      return () => clearTimeout(timer);
    }
  }, [status]);

  // Listen for segment status updates
  useEffect(() => {
    // Set up event listener for segment status updates
    const handleSegmentStatusUpdate = (event) => {
      if (event.detail && Array.isArray(event.detail)) {
        // If this is a full update (all segments), replace the array
        if (event.detail.length > 1) {
          setSegmentsStatus(event.detail);
        } else {
          // If this is a single segment update, update just that segment
          const updatedSegment = event.detail[0];
          setSegmentsStatus(prevStatus => {
            const newStatus = [...prevStatus];
            const index = newStatus.findIndex(s => s.index === updatedSegment.index);
            if (index !== -1) {
              newStatus[index] = updatedSegment;
            }
            return newStatus;
          });
        }
      }
    };

    // Add event listener
    window.addEventListener('segmentStatusUpdate', handleSegmentStatusUpdate);

    // Clean up
    return () => {
      window.removeEventListener('segmentStatusUpdate', handleSegmentStatusUpdate);
    };
  }, [setSegmentsStatus]);

  // Listen for video segments update
  useEffect(() => {
    // Set up event listener for video segments
    const handleVideoSegmentsUpdate = (event) => {
      if (event.detail && Array.isArray(event.detail)) {
        setVideoSegments(event.detail);
      }
    };

    // Add event listener
    window.addEventListener('videoSegmentsUpdate', handleVideoSegmentsUpdate);

    // Clean up
    return () => {
      window.removeEventListener('videoSegmentsUpdate', handleVideoSegmentsUpdate);
    };
  }, [setVideoSegments]);

  // Listen for video analysis events
  useEffect(() => {
    // Handle video analysis started
    const handleVideoAnalysisStarted = () => {
      // Video analysis is always enabled
      if (localStorage.getItem('show_video_analysis') === 'true') {
        setShowVideoAnalysis(true);
      }
    };

    // Handle show video analysis modal event (new event from analysisUtils)
    const handleShowVideoAnalysisModal = (event) => {
      // This event is dispatched after analysis completes with the result
      if (event.detail && event.detail.analysisResult) {
        setVideoAnalysisResult(event.detail.analysisResult);
        setShowVideoAnalysis(true);
      }
    };

    // Handle video analysis complete
    const handleVideoAnalysisComplete = (event) => {
      // Video analysis is always enabled
      if (event.detail && localStorage.getItem('show_video_analysis') === 'true') {
        setVideoAnalysisResult(event.detail);
        // Store current timestamp to allow for stale data detection
        localStorage.setItem('video_analysis_timestamp', Date.now().toString());
      }
    };

    // Add event listeners
    window.addEventListener('videoAnalysisStarted', handleVideoAnalysisStarted);
    window.addEventListener('showVideoAnalysisModal', handleShowVideoAnalysisModal);
    window.addEventListener('videoAnalysisComplete', handleVideoAnalysisComplete);

    // Clean up
    return () => {
      window.removeEventListener('videoAnalysisStarted', handleVideoAnalysisStarted);
      window.removeEventListener('showVideoAnalysisModal', handleShowVideoAnalysisModal);
      window.removeEventListener('videoAnalysisComplete', handleVideoAnalysisComplete);
    };
  }, [setShowVideoAnalysis, setVideoAnalysisResult]);

  // Listen for theme and settings changes from other components
  useEffect(() => {
    const handleStorageChange = (event) => {
      if (event.key === 'theme' || !event.key) {
        const newTheme = getThemeWithFallback();
        setTheme(newTheme);
      }

      if (event.key === 'show_waveform_long_videos' || !event.key) {
        const newShowWaveformLongVideos = localStorage.getItem('show_waveform_long_videos') === 'true';
        setShowWaveformLongVideos(newShowWaveformLongVideos);
      }

      if (event.key === 'time_format' || !event.key) {
        const newTimeFormat = localStorage.getItem('time_format') || 'hms';
        setTimeFormat(newTimeFormat);
      }

      // Respond to Gemini effects setting changes
      if (event.key === 'enable_gemini_effects') {
        const enabled = localStorage.getItem('enable_gemini_effects') !== 'false';
        if (enabled) {
          initGeminiButtonEffects();
        } else {
          disableGeminiButtonEffects();
        }
      }

      if (event.key === 'optimize_videos' || !event.key) {
        // Read the user's optimization setting from localStorage
        const newOptimizeVideos = localStorage.getItem('optimize_videos') === 'true';
        setOptimizeVideos(newOptimizeVideos);
      }

      if (event.key === 'optimized_resolution' || !event.key) {
        const newOptimizedResolution = localStorage.getItem('optimized_resolution') || '360p';
        setOptimizedResolution(newOptimizedResolution);
      }

      if (event.key === 'use_optimized_preview' || !event.key) {
        const newUseOptimizedPreview = localStorage.getItem('use_optimized_preview') === 'true';
        setUseOptimizedPreview(newUseOptimizedPreview);
      }

      // Sync localStorage to server when API keys change
      if (event.key === 'gemini_api_key' || event.key === 'gemini_model') {
        syncLocalStorageToServer()

          .catch(error => console.error('Error syncing localStorage to server:', error));
      }

      // Check for video analysis changes
      if (event.key === 'show_video_analysis' || event.key === 'video_analysis_timestamp' || !event.key) {
        const showAnalysis = localStorage.getItem('show_video_analysis') === 'true';
        const timestamp = localStorage.getItem('video_analysis_timestamp');
        const isProcessing = localStorage.getItem('video_processing_in_progress') === 'true';

        // Check if the analysis is stale (older than 5 minutes)
        const isStale = timestamp && (Date.now() - parseInt(timestamp, 10) > 5 * 60 * 1000);

        if (isStale) {
          // Clear stale analysis data
          localStorage.removeItem('show_video_analysis');
          localStorage.removeItem('video_analysis_timestamp');
          localStorage.removeItem('video_analysis_result');
          setShowVideoAnalysis(false);
          setVideoAnalysisResult(null);
          return;
        }

        // If we're already processing (after user made a choice), don't show the modal again
        if (isProcessing) {
          return;
        }

        if (showAnalysis && !isStale && !isProcessing) {
          setShowVideoAnalysis(true);

          // Get the analysis result from localStorage
          try {
            const analysisResult = JSON.parse(localStorage.getItem('video_analysis_result'));
            if (analysisResult) {
              setVideoAnalysisResult(analysisResult);
            }
          } catch (error) {
            console.error('Error parsing video analysis result from localStorage:', error);
            // Clear invalid data
            localStorage.removeItem('show_video_analysis');
            localStorage.removeItem('video_analysis_timestamp');
            localStorage.removeItem('video_analysis_result');
            setShowVideoAnalysis(false);
            setVideoAnalysisResult(null);
          }
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [setTheme, setShowWaveformLongVideos, setTimeFormat, setOptimizeVideos, setOptimizedResolution, setUseOptimizedPreview, setShowVideoAnalysis, setVideoAnalysisResult]);

  // Effect to detect when subtitles are loaded from cache and prepare video for segments
  useEffect(() => {
    // Check if subtitles were loaded from cache
    // Look for both the translation key and common text patterns in different languages
    const isCacheLoadMessage =
      (status?.translationKey === 'output.subtitlesLoadedFromCache') ||
      (status?.message && status.type === 'success' &&
       (status.message.includes('cache') ||
        status.message.includes('bộ nhớ đệm') ||
        status.message.includes('캐시')));

    if (isCacheLoadMessage && subtitlesData) {
      // For file upload tab - cached subtitles are ready to use
      if (uploadedFile) {
        // No need to prepare video segments when using cached subtitles
        // The new simplified processing workflow doesn't require video splitting
      }
      // For YouTube tab, we need to download the video first
      else if (handleDownloadAndPrepareYouTubeVideo) {
        // We'll handle YouTube videos in a separate function to avoid making this effect too complex
        handleDownloadAndPrepareYouTubeVideo();
      }
    }
  }, [status, subtitlesData, uploadedFile, t, handleDownloadAndPrepareYouTubeVideo, setStatus]);
};
