import { useState, useRef } from 'react';
import { showInfoToast, showErrorToast } from '../../../utils/toastUtils';
import { EVENTS } from '../../../events/constants';

/**
 * Custom hook encapsulating the auto-generation orchestration flow.
 *
 * Closes over refs/state/setters threaded in via params so behavior matches the
 * original inline implementation in ButtonsContainer.jsx byte-for-byte.
 */
const useAutoGenerateFlow = ({
  apiKeysSet,
  t,
  handleGenerateSubtitles,
  subtitlesData,
  uploadedFile,
  selectedVideo,
  isVercelMode,
  onSegmentSelect,
  currentStateRef
}) => {
  // State for auto-generation flow
  const [isAutoGenerating, setIsAutoGenerating] = useState(false);
  const [autoFlowStep, setAutoFlowStep] = useState('');
  const autoFlowTimeoutRef = useRef(null);
  const autoFlowAbortedRef = useRef(false);

  // Auto-generate flow implementation
  const startAutoGenerateFlow = async () => {
    if (isAutoGenerating) return;

    // Check for Gemini API key before proceeding
    if (!apiKeysSet || !apiKeysSet.gemini) {
      showErrorToast(t('errors.apiKeyRequired', 'Gemini API key is required'), 4000);
      return;
    }

    setIsAutoGenerating(true);
    autoFlowAbortedRef.current = false;

    try {
      // Step 0: Save current subtitle state (especially if cleared/empty)
      console.log('[AutoFlow] Step 0: Saving current subtitle state...');
      const lyricsSaveBtn = document.querySelector('.lyrics-save-btn');
      if (lyricsSaveBtn) {
        console.log('[AutoFlow] Triggering lyrics save to persist current state (including empty state)');
        lyricsSaveBtn.click();
        // Wait a moment for save to complete
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Step 1: Trigger video loading (semi-automatic generate)
      setAutoFlowStep('loading');
      console.log('[AutoFlow] Step 1: Triggering video load...');

      // Click the semi-automatic generate button to trigger video loading
      try {
        console.log('[AutoFlow] Calling handleGenerateSubtitles...');
        handleGenerateSubtitles();
        console.log('[AutoFlow] handleGenerateSubtitles called successfully');
      } catch (error) {
        console.error('[AutoFlow] Error calling handleGenerateSubtitles:', error);
        throw error;
      }

      // Wait for video to be loaded (either uploaded or downloaded)
      console.log('[AutoFlow] Waiting for video to be ready...');
      await waitForVideoReady();
      console.log('[AutoFlow] Video ready, continuing to step 2');

      if (autoFlowAbortedRef.current) return;

      // Step 2: Trigger video analysis
      setAutoFlowStep('analyzing');
      console.log('[AutoFlow] Step 2: Starting video analysis...');

      // Wait a moment for buttons to be ready after video load
      await new Promise(resolve => setTimeout(resolve, 500));

      // Find the video analysis button - check for either the button or its container
      const analysisButton = document.querySelector('.video-analysis-button, .video-analysis-button-container button');
      console.log('[AutoFlow] Found analysis button:', analysisButton);

      if (analysisButton && !analysisButton.disabled) {
        // Check if it already has analysis (edit mode)
        const hasAnalysis = analysisButton.classList.contains('has-analysis');

        if (!hasAnalysis) {
          console.log('[AutoFlow] Triggering video analysis...');
          analysisButton.click();

          // Wait for analysis to complete
          await waitForAnalysisComplete();
        } else {
          console.log('[AutoFlow] Analysis already exists, skipping analysis step');
          // Show info toast about using existing analysis
          showInfoToast(t('autoFlow.usingExistingAnalysis', 'Using existing analysis rules'), 2000);
        }
      } else {
        console.log('[AutoFlow] Analysis button not found or disabled, continuing without analysis');
        // Show info toast about skipping analysis
        showInfoToast(t('autoFlow.analysisSkipped', 'Analysis skipped, continuing with default settings'), 3000);
      }

      if (autoFlowAbortedRef.current) return;

      // Step 3: Programmatically trigger segment selection based on subtitle existence
      setAutoFlowStep('processing');
      console.log('[AutoFlow] Step 3: Checking subtitle state and triggering appropriate action...');

      // Get video duration for the full range selection
      const videoElement = document.querySelector('video');
      const videoDuration = videoElement?.duration || uploadedFile?.duration || selectedVideo?.duration || 0;
      console.log('[AutoFlow] Video duration:', videoDuration);

      // Check if there are subtitles in the timeline
      const hasSubtitles = subtitlesData && subtitlesData.length > 0;
      console.log('[AutoFlow] Has subtitles:', hasSubtitles, 'Count:', subtitlesData?.length || 0);

      if (hasSubtitles) {
        // If subtitles exist, trigger regenerate action (same as clicking Regenerate button)
        console.log('[AutoFlow] Subtitles exist, triggering regenerate action...');
        sessionStorage.setItem('processing_modal_open_reason', 'action-bar-regenerate');
        if (onSegmentSelect) {
          onSegmentSelect({ start: 0, end: videoDuration });
          console.log('[AutoFlow] Regenerate action triggered programmatically for full range');
        } else {
          console.log('[AutoFlow] onSegmentSelect not available, cannot trigger regenerate');
        }
      } else {
        // If no subtitles, trigger normal segment selection (opens method overlay)
        console.log('[AutoFlow] No subtitles, triggering normal segment selection...');
        sessionStorage.setItem('processing_modal_open_reason', 'drag-selection');
        if (onSegmentSelect) {
          onSegmentSelect({ start: 0, end: videoDuration });
          console.log('[AutoFlow] Normal segment selection triggered for full range');

          // Wait for method selection overlay to appear
          console.log('[AutoFlow] Waiting for method selection overlay...');
          await new Promise(resolve => setTimeout(resolve, 1000));

          const overlay = document.querySelector('.transcription-method-overlay');
          console.log('[AutoFlow] Method selection overlay detected:', !!overlay);
          if (overlay) {
            // Choose method based on Vercel mode: new method for Vercel, old method otherwise
            const methodIndex = isVercelMode ? 0 : 1;
            const methodName = isVercelMode ? 'new' : 'old';
            console.log(`[AutoFlow] Auto-selecting Gemini ${methodName} method (Vercel mode: ${isVercelMode})...`);
            // Find the method columns
            const methodColumns = overlay.querySelectorAll('.method-column');
            console.log('[AutoFlow] Found method columns:', methodColumns.length);
            if (methodColumns.length >= 2) {
              console.log(`[AutoFlow] Clicking method column ${methodIndex} (${methodName} method)`);
              methodColumns[methodIndex].click(); // Click the appropriate method based on Vercel mode

              // Wait for the processing modal to appear after method selection
              console.log('[AutoFlow] Waiting for processing modal to appear after method selection...');
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } else {
            console.log('[AutoFlow] Method selection overlay not found');
          }
        } else {
          console.log('[AutoFlow] onSegmentSelect not available, cannot trigger segment selection');
        }
      }

      if (autoFlowAbortedRef.current) return;

      // Step 4: Click the process button in the modal
      console.log('[AutoFlow] Step 4: Starting processing...');
      const processBtn = document.querySelector('.video-processing-modal .process-btn');
      if (processBtn && !processBtn.disabled) {
        processBtn.click();
      }

      // Auto-flow complete
      setAutoFlowStep('complete');
      console.log('[AutoFlow] Auto-generation flow completed successfully');

    } catch (error) {
      console.error('[AutoFlow] Error during auto-generation:', error);
      // Show error toast but continue gracefully
      showErrorToast(t('autoFlow.error', 'Auto-generation encountered an error: {{message}}', { message: error.message }), 4000);
    } finally {
      setIsAutoGenerating(false);
      setAutoFlowStep('');
    }
  };

  // Helper function to wait for video to be ready
  const waitForVideoReady = () => {
    console.log('[AutoFlow] waitForVideoReady started, initial state:', {
      uploadedFile: !!currentStateRef.current.uploadedFile,
      uploadedFileData: !!currentStateRef.current.uploadedFileData,
      isDownloading: currentStateRef.current.isDownloading
    });

    return new Promise((resolve) => {
      let checkCount = 0;
      const maxChecks = 300; // 5 minutes max wait

      const checkInterval = setInterval(() => {
        checkCount++;

        // Get current state from ref (to avoid closure issues)
        const currentState = currentStateRef.current;

        // Log current state every 5 checks
        if (checkCount % 5 === 0) {
          console.log('[AutoFlow] Check #' + checkCount + ', state:', {
            uploadedFile: !!currentState.uploadedFile,
            uploadedFileData: !!currentState.uploadedFileData,
            isDownloading: currentState.isDownloading,
            downloadProgress: currentState.downloadProgress
          });
        }

        // Check if video is ready (uploaded or downloaded)
        // Also check that we're not still downloading
        if ((currentState.uploadedFile || currentState.uploadedFileData) && !currentState.isDownloading) {
          clearInterval(checkInterval);
          console.log('[AutoFlow] Video is ready! File available:', !!currentState.uploadedFile, 'FileData available:', !!currentState.uploadedFileData);
          resolve();
        } else if (checkCount >= maxChecks || autoFlowAbortedRef.current) {
          clearInterval(checkInterval);
          console.log('[AutoFlow] Video loading timeout or aborted');
          resolve();
        } else if (currentState.isDownloading) {
          // Still downloading, keep waiting
          console.log('[AutoFlow] Still downloading video...', currentState.downloadProgress + '%');
        } else {
          // Not downloading but also no file - log this state
          if (checkCount % 5 === 0) {
            console.log('[AutoFlow] Waiting for video, but not downloading. File states:', {
              uploadedFile: !!currentState.uploadedFile,
              uploadedFileData: !!currentState.uploadedFileData
            });
          }
        }
      }, 1000); // Check every second
    });
  };

  // Helper function to wait for analysis to complete
  const waitForAnalysisComplete = () => {
    return new Promise((resolve, reject) => {
      let checkCount = 0;
      const maxChecks = 1200; // 10 minutes; never leave the auto button stuck forever.
      let modalDetected = false;

      const finish = (callback) => {
        clearInterval(checkInterval);
        window.removeEventListener(EVENTS.VIDEO_ANALYSIS_SETTLED, handleSettled);
        callback();
      };
      const handleSettled = (event) => {
        if (event?.detail?.success === false) {
          finish(() => reject(new Error('Video analysis failed')));
        }
      };
      window.addEventListener(EVENTS.VIDEO_ANALYSIS_SETTLED, handleSettled);

      const checkInterval = setInterval(() => {
        checkCount++;


        // Check for the rules editor modal
        const rulesModal = document.querySelector('.rules-editor-modal');
        const hasRules = localStorage.getItem('transcription_rules');

        if (rulesModal) {
          // Rules editor modal is open
          if (!modalDetected) {
            console.log('[AutoFlow] Rules editor modal detected with countdown');
            modalDetected = true;

            // Check if countdown is enabled
            const timeoutSetting = localStorage.getItem('video_analysis_timeout') || '10';
            const showCountdown = sessionStorage.getItem('show_rules_editor_countdown') === 'true';

            if (timeoutSetting !== 'none' && showCountdown) {
              const timeout = parseInt(timeoutSetting, 10);
              if (!isNaN(timeout) && timeout > 0) {
                console.log(`[AutoFlow] Rules editor has ${timeout}s countdown, waiting for it to complete or modal to close...`);
              }
            } else {
              console.log('[AutoFlow] Rules editor opened without countdown or countdown disabled');
            }
          }

          // Just wait while the modal is open
          // The countdown will auto-save or user will manually save/cancel

        } else if (modalDetected && !rulesModal) {
          // Modal was open but now closed - analysis/editing is complete
          console.log('[AutoFlow] Rules editor modal closed');

          // Clean up the countdown flag
          sessionStorage.removeItem('show_rules_editor_countdown');

          // Give a small delay to ensure everything is properly saved
          setTimeout(() => {
            finish(resolve);
          }, 500);

        } else if (!modalDetected && hasRules && checkCount > 10) {
          // Rules exist but modal never opened (might happen if analysis was very fast)
          console.log('[AutoFlow] Analysis complete (rules saved without modal)');
          finish(resolve);

        } else if (autoFlowAbortedRef.current) {
          console.log('[AutoFlow] Analysis aborted');
          finish(resolve);
        } else if (checkCount >= maxChecks) {
          finish(() => reject(new Error('Video analysis timed out')));
        }
      }, 500); // Check every 500ms for faster response
    });
  };

  // Stop auto-flow if user manually intervenes
  const stopAutoFlow = () => {
    if (isAutoGenerating) {
      autoFlowAbortedRef.current = true;
      setIsAutoGenerating(false);
      setAutoFlowStep('');
      console.log('[AutoFlow] Auto-generation stopped by user');
    }
  };

  return {
    isAutoGenerating,
    autoFlowStep,
    autoFlowTimeoutRef,
    autoFlowAbortedRef,
    startAutoGenerateFlow,
    waitForVideoReady,
    waitForAnalysisComplete,
    stopAutoFlow
  };
};

export default useAutoGenerateFlow;
