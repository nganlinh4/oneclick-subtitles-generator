import { useEffect } from 'react';
import { initGeminiButtonEffects, resetAllGeminiButtonEffects, disableGeminiButtonEffects } from '../../utils/geminiEffects';
import initTabPillAnimation from '../../utils/tabPillAnimation';
import { getThemeWithFallback } from '../../utils/systemDetection';

/**
 * Hook for managing application side effects
 */
export const useAppEffects = (props) => {
  const {
    setSegmentsStatus,
    setVideoSegments,
    setTheme,
    setShowWaveformLongVideos,
    setTimeFormat,
    setOptimizeVideos,
    setOptimizedResolution,
    setUseOptimizedPreview,
    subtitlesData,
    status,
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

    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, [setTheme, setShowWaveformLongVideos, setTimeFormat, setOptimizeVideos, setOptimizedResolution, setUseOptimizedPreview]);

};
