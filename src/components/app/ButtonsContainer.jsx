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
  setIsProcessingSegment = () => {}
}) => {
  // State for auto-generation flow
  const [isAutoGenerating, setIsAutoGenerating] = useState(false);
  const [autoFlowStep, setAutoFlowStep] = useState('');
  const autoFlowTimeoutRef = useRef(null);
  const autoFlowAbortedRef = useRef(false);
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

      // Step 3: Trigger Ctrl+A to select all and open processing modal
      setAutoFlowStep('processing');
      console.log('[AutoFlow] Step 3: Selecting all timeline and opening processing modal...');

      // Dispatch Ctrl+A keyboard event
      const ctrlAEvent = new KeyboardEvent('keydown', {
        key: 'a',
        code: 'KeyA',
        ctrlKey: true,
        bubbles: true
      });
      document.dispatchEvent(ctrlAEvent);

      // Wait a moment for modal to open
      await new Promise(resolve => setTimeout(resolve, 1000));

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

        // Check for error toasts that might have appeared
        const errorToast = document.querySelector('.custom-toast.error');
        if (errorToast && !errorDetected) {
          errorDetected = true;
          console.log('[AutoFlow] Analysis error detected via toast, continuing with flow');
          clearInterval(checkInterval);
          // Continue with the flow even if analysis failed
          setTimeout(() => {
            resolve();
          }, 1000);
          return;
        }

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
                  <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
                </div>
                <div className="gemini-mini-icon random-3 size-md">
                  <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" stroke="currentColor" strokeWidth="1.5"/>
                  </svg>
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
              <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </div>
            <div className="gemini-mini-icon random-3 size-md">
              <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </div>
          </div>
          <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" strokeWidth="2" fill="none">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
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
                window.dispatchEvent(new CustomEvent('processing-ranges', { detail: { ranges: [] } }));
              } catch {}
            }

            // The state will be updated by the event listener in useSubtitles hook
          }}
          title={t('output.forceStopTooltip', 'Force stop all Gemini requests')}
        >
          {/* Dynamic Gemini effects container - populated by particle system */}
          <div className="gemini-icon-container"></div>
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          </svg>
          {t('output.forceStop', 'Force Stop')}
        </button>
      )}
    </div>
  );
};

export default ButtonsContainer;
