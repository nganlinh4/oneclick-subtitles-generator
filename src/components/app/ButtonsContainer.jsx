import React, { useState, useEffect, useRef } from 'react';
import SrtUploadButton from '../SrtUploadButton';
import AddSubtitlesButton from '../AddSubtitlesButton';
import VideoAnalysisButton from '../VideoAnalysisButton';
import LoadingIndicator from '../common/LoadingIndicator';
import WavyProgressIndicator from '../common/WavyProgressIndicator';
import { abortAllRequests } from '../../services/geminiService';
import { hasValidDownloadedVideo } from '../../utils/videoUtils';
import { showInfoToast, showErrorToast } from '../../utils/toastUtils';
import '../../styles/ButtonTextBalance.css';
import Tooltip from '../common/Tooltip';
import { publishProcessingRanges } from '../../events/bus';


/**
 * Component for rendering the buttons container
 */
const ButtonsContainer = ({
  handleSrtUpload,
  handleGenerateSubtitles,
  handleCancelDownload,
  handleUserSubtitlesAdd,
  handleAbortVideoAnalysis,
  validateInput,
  isGenerating,
  isDownloading,
  downloadProgress,
  currentDownloadId,
  isRetrying,
  setIsRetrying,
  retryingSegments,
  segmentsStatus,
  subtitlesData,
  setSubtitlesData,
  status,
  userProvidedSubtitles,
  selectedVideo,
  uploadedFile,
  uploadedFileData,
  isSrtOnlyMode,
  t,
  onGenerateBackground,
  isProcessingSegment = false,
  setIsProcessingSegment = () => {},
  apiKeysSet,
  onSegmentSelect
}) => {
  // State for auto-generation flow
  const [isAutoGenerating, setIsAutoGenerating] = useState(false);
  const [autoFlowStep, setAutoFlowStep] = useState('');
  const autoFlowTimeoutRef = useRef(null);
  const autoFlowAbortedRef = useRef(false);

  // State for Vercel mode detection
  const [isVercelMode, setIsVercelMode] = useState(() => {
    return typeof window !== 'undefined' && window.location.hostname.includes('vercel.app');
  });
  // State for tracking uploaded SRT files with localStorage persistence
  const [uploadedSrtInfo, setUploadedSrtInfo] = useState(() => {
    try {
      const saved = localStorage.getItem('uploaded_srt_info');
      return saved ? JSON.parse(saved) : {
        hasUploaded: false,
        fileName: '',
        source: '' // 'srt' or 'generated'
      };
    } catch (error) {
      return {
        hasUploaded: false,
        fileName: '',
        source: ''
      };
    }
  });

  // Ref for WavyProgressIndicator animations
  const wavyProgressRef = useRef(null);

  // Refs to track current state for autoflow (to avoid closure issues)
  const currentStateRef = useRef({
    uploadedFile: null,
    uploadedFileData: null,
    isDownloading: false,
    downloadProgress: 0
  });


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
    return new Promise((resolve) => {
      let checkCount = 0;
      // Removed timeout - let analysis run as long as needed
      let modalDetected = false;
      let errorDetected = false;

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
          clearInterval(checkInterval);
          console.log('[AutoFlow] Rules editor modal closed');

          // Clean up the countdown flag
          sessionStorage.removeItem('show_rules_editor_countdown');

          // Give a small delay to ensure everything is properly saved
          setTimeout(() => {
            resolve();
          }, 500);

        } else if (!modalDetected && hasRules && checkCount > 10) {
          // Rules exist but modal never opened (might happen if analysis was very fast)
          clearInterval(checkInterval);
          console.log('[AutoFlow] Analysis complete (rules saved without modal)');
          resolve();

        } else if (autoFlowAbortedRef.current) {
          clearInterval(checkInterval);
          console.log('[AutoFlow] Analysis aborted');
          resolve();
        }
        // Removed timeout check - analysis will run indefinitely until complete or aborted
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

  // Persist uploadedSrtInfo to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('uploaded_srt_info', JSON.stringify(uploadedSrtInfo));
    } catch (error) {
      console.error('Error saving uploaded SRT info to localStorage:', error);
    }
  }, [uploadedSrtInfo]);

  // Update current state ref whenever props change
  useEffect(() => {
    currentStateRef.current = {
      uploadedFile,
      uploadedFileData,
      isDownloading,
      downloadProgress
    };
  }, [uploadedFile, uploadedFileData, isDownloading, downloadProgress]);

  // If a NEW uploaded file arrives, auto-trigger semi-auto generate once


  // Handle entrance/disappear animations for WavyProgressIndicator
  useEffect(() => {
    if (isDownloading && wavyProgressRef.current) {
      // Start entrance animation when downloading begins
      wavyProgressRef.current.startEntranceAnimation();
    } else if (!isDownloading && wavyProgressRef.current) {
      // Start disappear animation when downloading ends
      wavyProgressRef.current.startDisappearanceAnimation();
    }
  }, [isDownloading]);

  // Initialize SRT upload detection on component mount
  useEffect(() => {
    // On initial load, check if we should detect existing SRT data
    if (subtitlesData && subtitlesData.length > 0 && !uploadedSrtInfo.hasUploaded) {
      // Check multiple indicators that this might be uploaded SRT data
      const isLikelySrtData = isSrtOnlyMode ||
                             status?.message?.includes('SRT') ||
                             status?.message?.includes('uploaded') ||
                             status?.message?.includes('Working with SRT only') ||
                             // Check if subtitles have sequential IDs (typical of SRT files)
                             (subtitlesData.length > 1 && subtitlesData.every((sub, index) => sub.id === index + 1));

      if (isLikelySrtData) {
        setUploadedSrtInfo({
          hasUploaded: true,
          fileName: 'uploaded-file.srt', // Default name since we don't know the original
          source: 'srt'
        });
      }
    }
  }, []); // Run only once on mount

  // Track when subtitles come from SRT upload vs generation
  useEffect(() => {
    // Check if we have subtitles and determine their source
    if (subtitlesData && subtitlesData.length > 0) {
      // Multiple ways to detect SRT upload:
      // 1. Recent status message contains upload keywords
      const isFromRecentSrtUpload = status?.message?.includes('uploaded') ||
                                    status?.message?.includes('SRT') ||
                                    status?.message?.includes('JSON');

      // 2. We're in SRT-only mode (indicates subtitles without video generation)
      const isInSrtOnlyMode = isSrtOnlyMode;

      // 3. Status message indicates SRT-only mode
      const isSrtOnlyModeStatus = status?.message?.includes('Working with SRT only') ||
                                  status?.message?.includes('SRT only');

      // 4. Check if subtitles have the structure typical of uploaded SRT files
      // (they usually have sequential IDs and proper timing)
      const hasSequentialIds = subtitlesData.length > 1 &&
                               subtitlesData.every((sub, index) => sub.id === index + 1);

      // 5. Check if we have subtitles but no generation activity (likely uploaded)
      const hasSubtitlesWithoutGeneration = subtitlesData.length > 0 && !isGenerating &&
                                           !status?.message?.includes('Processing') &&
                                           !status?.message?.includes('Generating');

      const isFromSrtUpload = isFromRecentSrtUpload || isInSrtOnlyMode || isSrtOnlyModeStatus ||
                             (hasSubtitlesWithoutGeneration && hasSequentialIds);

      if (isFromSrtUpload && !uploadedSrtInfo.hasUploaded) {
        // This is a new SRT upload or we detected existing SRT data
        setUploadedSrtInfo(prev => ({
          ...prev,
          hasUploaded: true,
          source: 'srt'
        }));
      } else if (!isFromSrtUpload && !isInSrtOnlyMode && uploadedSrtInfo.source === 'srt') {
        // Subtitles were regenerated and we're not in SRT-only mode, clear SRT upload state
        setUploadedSrtInfo({
          hasUploaded: false,
          fileName: '',
          source: 'generated'
        });
      }
    } else {
      // No subtitles, clear upload state
      setUploadedSrtInfo({
        hasUploaded: false,
        fileName: '',
        source: ''
      });
    }
  }, [subtitlesData, status, isSrtOnlyMode, uploadedSrtInfo.hasUploaded, uploadedSrtInfo.source]);

  // Enhanced SRT upload handler
  const handleSrtUploadWithState = (content, fileName) => {
    setUploadedSrtInfo({
      hasUploaded: true,
      fileName: fileName,
      source: 'srt'
    });
    handleSrtUpload(content, fileName);
  };

  // Clear SRT handler
  const handleSrtClear = () => {
    const clearedInfo = {
      hasUploaded: false,
      fileName: '',
      source: ''
    };
    setUploadedSrtInfo(clearedInfo);

    // Clear from localStorage as well
    try {
      localStorage.setItem('uploaded_srt_info', JSON.stringify(clearedInfo));
    } catch (error) {
      console.error('Error clearing uploaded SRT info from localStorage:', error);
    }

    // Clear subtitles data - this should clear the subtitles completely
    if (typeof handleUserSubtitlesAdd === 'function') {
      handleUserSubtitlesAdd('');
    }

    // Also clear subtitles data directly if available
    if (typeof setSubtitlesData === 'function') {
      setSubtitlesData(null);
    }
  };
  // Check if we have URL + SRT but no downloaded video yet
  const hasUrlAndSrtOnly = selectedVideo &&
                          !uploadedFile &&
                          subtitlesData && subtitlesData.length > 0 &&
                          !hasValidDownloadedVideo(uploadedFile) &&
                          !isSrtOnlyMode;
  // Detect current theme from data-theme attribute (light/dark)
  const isDarkTheme = (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark');


  return (
    <div className="buttons-container">
      <div style={{ flexShrink: 0 }}>
        <SrtUploadButton
          onSrtUpload={handleSrtUploadWithState}
          onSrtClear={handleSrtClear}
          disabled={isGenerating || isDownloading}
          hasSrtUploaded={uploadedSrtInfo.hasUploaded}
          uploadedFileName={uploadedSrtInfo.fileName}
        />
      </div>

      {/* Add Subtitles Button - always visible like SrtUploadButton */}

      <div style={{ flexShrink: 0 }}>
        <AddSubtitlesButton
          onSubtitlesAdd={handleUserSubtitlesAdd}
          hasSubtitles={userProvidedSubtitles.trim() !== ''}
          subtitlesText={userProvidedSubtitles}
          disabled={isGenerating || isDownloading}
          onGenerateBackground={onGenerateBackground}
        />
      </div>

      {/* Hide generate button when retrying segments, when isRetrying is true, or when any segment is being retried */}
      {validateInput() && retryingSegments.length === 0 && !isRetrying && !segmentsStatus.some(segment => segment.status === 'retrying') && (
        <>
          {/* Semi-automatic Generate Button */}
          <Tooltip content={t('output.semiAutoTooltip', 'Tiết kiệm request và token vì không bắt buộc phân tích video')}>
            <button
              className={`generate-btn semi-auto ${isGenerating || isDownloading ? 'processing' : ''}`}
              onClick={handleGenerateSubtitles}
              disabled={isGenerating || isDownloading || isAutoGenerating}
            >
              {/* Static Gemini icons for fallback */}
              <div className="gemini-icon-container">
                <div className="gemini-mini-icon random-1 size-sm">
                  <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>
                    star
                  </span>
                </div>
                <div className="gemini-mini-icon random-3 size-md">
                  <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>
                    star
                  </span>
                </div>
              </div>
              {isGenerating || isDownloading ? (
                <span className="processing-text-container">
                  <LoadingIndicator
                    theme={isDarkTheme ? 'light' : 'dark'}
                    showContainer={false}
                    size={16}
                    className="buttons-processing-loading"
                    color={isDarkTheme ? '#324574' : '#FFFFFF'}
                  />
                  {isDownloading ? (
                    <div className="processing-wavy" style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                      <WavyProgressIndicator
                        ref={wavyProgressRef}
                        progress={Math.max(0, Math.min(1, (downloadProgress || 0) / 100))}
                        animate={true}
                        showStopIndicator={true}
                        waveSpeed={1.2}
                        width={140}
                        autoAnimateEntrance={false}
                        color={isDarkTheme ? '#FFFFFF' : '#FFFFFF'}
                        trackColor={isDarkTheme ? '#404659' : 'rgba(255,255,255,0.35)'}
                      />
                    </div>
                  ) : (
                    <span className="processing-text">
                      {t('output.processingVideo').split('...')[0]}
                    </span>
                  )}
                </span>
              ) : isSrtOnlyMode ? t('output.srtOnlyMode', 'Working with SRT only') :
                hasUrlAndSrtOnly ? t('output.downloadAndViewWithSrt', 'Download + View with Uploaded SRT') :
                selectedVideo && !uploadedFile ? t('output.downloadAndGenerateSemiAuto', 'Download + Generate (semi-auto)') :
                t('output.semiAutoGenerate', 'Semi-auto')}
            </button>
          </Tooltip>

          {/* Auto Generate Button */}
          <button
            className={`generate-btn auto-generate ${isAutoGenerating ? 'processing' : ''}`}
            onClick={startAutoGenerateFlow}
            disabled={isGenerating || isDownloading || isAutoGenerating}
            title={t('header.autoGenerateTooltip', 'Fully automatic subtitle generation with analysis and optimal settings')}
          >
            {/* Gemini stars container - populated by particle system */}
            <div className="gemini-icon-container"></div>
            {isAutoGenerating ? (
              <span className="processing-text-container">
                <LoadingIndicator
                  theme={isDarkTheme ? 'light' : 'dark'}
                  showContainer={false}
                  size={16}
                  className="buttons-processing-loading"
                  color={isDarkTheme ? '#324574' : '#FFFFFF'}
                />
                <span className="processing-text">
                  {/* Show download state when downloading, otherwise show autoflow step */}
                  {isDownloading ? t('autoFlow.loading', 'Loading video...') :
                   autoFlowStep === 'analyzing' ? t('autoFlow.analyzing', 'Analyzing...') :
                   autoFlowStep === 'processing' ? t('autoFlow.processing', 'Processing...') :
                   autoFlowStep === 'complete' ? t('autoFlow.complete', 'Complete!') :
                   t('autoFlow.running', 'Running auto...')}
                </span>
              </span>
            ) : <span className="button-text">{selectedVideo && !uploadedFile ? t('output.downloadAndGenerateAuto', 'Download + Generate subtitles (auto)') :
            t('output.autoFlow', 'Generate subtitles (auto)')}</span>}
          </button>
        </>
      )}

      {/* Add cancel button as a proper member of the buttons-container */}
      {isDownloading && currentDownloadId && validateInput() && retryingSegments.length === 0 && !isRetrying && !segmentsStatus.some(segment => segment.status === 'retrying') && !isAutoGenerating && (
        <button
          className="cancel-download-btn"
          onClick={handleCancelDownload}
          title={t('output.cancelDownload', 'Cancel download')}
        >
          {/* Static Gemini icons for fallback */}
          <div className="gemini-icon-container">
            <div className="gemini-mini-icon random-1 size-sm">
              <span className="material-symbols-rounded" style={{ fontSize: '16px' }}>
                star
              </span>
            </div>
            <div className="gemini-mini-icon random-3 size-md">
              <span className="material-symbols-rounded" style={{ fontSize: '20px' }}>
                star
              </span>
            </div>
          </div>
          <span className="material-symbols-rounded" style={{ fontSize: 20, display: 'inline-block' }}>
            close
          </span>
          {t('output.cancelDownload', 'Cancel Download')}
        </button>
      )}

      {/* Video Analysis Button - always visible like SrtUploadButton */}
      <VideoAnalysisButton
        disabled={isGenerating || isDownloading}
        uploadedFile={uploadedFile}
        uploadedFileData={uploadedFileData}
      />

      {(isGenerating || retryingSegments.length > 0 || isRetrying || isProcessingSegment) && (
        <button
          className="force-stop-btn"
          onClick={(e) => {
            // Add processing class for animation
            e.currentTarget.classList.add('processing');

            // Remove processing class after animation completes
            setTimeout(() => {
              if (e.currentTarget) {
                e.currentTarget.classList.remove('processing');
              }
            }, 1000);

            // Abort all ongoing Gemini API requests (including streaming)
            const aborted = abortAllRequests();
            if (aborted) {
              console.log('[ButtonsContainer] Successfully aborted all Gemini requests');
            }

            // Abort any active video analysis
            handleAbortVideoAnalysis();

            // Reset retrying state immediately
            if (isRetrying) {
              setIsRetrying(false);
            }

            // Also reset processing segment state
            if (isProcessingSegment) {
              setIsProcessingSegment(false);
              // Clear processing ranges overlay
              try {
                publishProcessingRanges({ ranges: [] });
              } catch {}
            }

            // The state will be updated by the event listener in useSubtitles hook
          }}
          title={t('output.forceStopTooltip', 'Force stop all Gemini requests')}
        >
          {/* Dynamic Gemini effects container - populated by particle system */}
          <div className="gemini-icon-container"></div>
          <span className="material-symbols-rounded" style={{ fontSize: 16, display: 'inline-block' }}>
            stop
          </span>
          {t('output.forceStop', 'Force Stop')}
        </button>
      )}
    </div>
  );
};

export default ButtonsContainer;
