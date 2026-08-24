import { useEffect, useRef } from 'react';

// Gated debug logging (enable in the browser console: localStorage.debug_logs = 'true')
const DEBUG_LOGS = (typeof window !== 'undefined') && (localStorage.getItem('debug_logs') === 'true');
const dbg = (...args) => { if (DEBUG_LOGS) console.log(...args); };

/**
 * Applies incoming autoFillData (from e.g. the video-quality modal): expands/scrolls
 * the section and pre-selects video / subtitles / narration. Owns the sectionRef used
 * for the JS-driven smooth scroll.
 *
 * @param {object} ctx parent props + setters this effect closes over
 * @returns {{ sectionRef: React.MutableRefObject<HTMLElement> }}
 */
export const useAutoFill = ({
  autoFillData,
  actualVideoUrl,
  selectedVideo,
  uploadedFile,
  subtitlesData,
  translatedSubtitles,
  narrationResults,
  userHasCollapsed,
  setIsCollapsed,
  setUserHasCollapsed,
  setSelectedVideoFile,
  setSelectedSubtitles,
  setSelectedNarration,
}) => {
  const sectionRef = useRef(null);

  // Auto-fill data when autoFillData changes - with improved state management
  useEffect(() => {
    if (autoFillData) {
      dbg('[VideoRenderingSection] Processing autoFillData:', autoFillData);

      // Expand/scroll sequencing: when coming from video-quality-modal, scroll first, then expand
      const shouldSequenceScrollThenExpand =
        !!(autoFillData.expand && autoFillData.autoScroll && autoFillData.source === 'video-quality-modal');

      // Expand if requested - but defer when sequencing is needed
      if (autoFillData.expand) {
        if (shouldSequenceScrollThenExpand) {
          // Keep collapsed until after scroll completes
          setUserHasCollapsed(false);
        } else {
          setIsCollapsed(false);
          // Reset userHasCollapsed when auto-expanding via render button
          setUserHasCollapsed(false);
        }
      }

      // Auto-fill video - prioritize videoFile from quality modal, then actual video URL
      if (autoFillData.videoFile) {
        // Use the video file selected from the quality modal
        setSelectedVideoFile(autoFillData.videoFile);
      } else if (actualVideoUrl) {
        // Create a video file object that represents the actual playing video
        setSelectedVideoFile({
          url: actualVideoUrl,
          name: uploadedFile?.name || selectedVideo?.title || 'Current Video',
          isActualVideo: true
        });
      }

      // Auto-fill subtitles based on available data
      if (translatedSubtitles && translatedSubtitles.length > 0) {
        setSelectedSubtitles('translated');
      } else if (subtitlesData && subtitlesData.length > 0) {
        setSelectedSubtitles('original');
      }

      // Auto-fill narration if available
      if (narrationResults && narrationResults.length > 0) {
        setSelectedNarration('generated');
      }

      // Auto-scroll ONLY if explicitly requested
      if (shouldSequenceScrollThenExpand) {
        dbg('[VideoRenderingSection] Sequencing: scroll first, then expand');
        // Use a JS-driven smooth scroll to avoid any CSS/UA interruptions
        setTimeout(() => {
          const targetEl = sectionRef.current;
          if (!targetEl) return;
          const startY = window.scrollY || window.pageYOffset;
          const rect = targetEl.getBoundingClientRect();
          const targetY = startY + rect.top - 12; // slight offset for aesthetics
          const distance = targetY - startY;
          const duration = Math.min(1200, Math.max(500, Math.abs(distance) * 0.9));
          let startTime = null;
          const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);
          const animate = (ts) => {
            if (startTime === null) startTime = ts;
            const elapsed = ts - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = easeOutQuart(progress);
            window.scrollTo(0, startY + distance * eased);
            if (progress < 1) {
              requestAnimationFrame(animate);
            } else {
              // Expand after scroll completes
              setIsCollapsed(false);
            }
          };
          requestAnimationFrame(animate);
        }, 50);
      } else if (autoFillData.autoScroll && autoFillData.source !== 'video-quality-modal') {
        dbg('[VideoRenderingSection] Auto-scroll requested but blocked - source:', autoFillData.source);
      }
    }
  }, [autoFillData, actualVideoUrl, selectedVideo, uploadedFile, subtitlesData, translatedSubtitles, narrationResults, userHasCollapsed]); // eslint-disable-line react-hooks/exhaustive-deps

  return { sectionRef };
};

export default useAutoFill;
