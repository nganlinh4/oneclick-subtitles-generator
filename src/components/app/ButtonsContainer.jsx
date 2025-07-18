import React, { useState, useEffect } from 'react';
import SrtUploadButton from '../SrtUploadButton';
import AddSubtitlesButton from '../AddSubtitlesButton';
import { abortAllRequests } from '../../services/geminiService';

/**
 * Component for rendering the buttons container
 */
const ButtonsContainer = ({
  handleSrtUpload,
  handleGenerateSubtitles,
  handleRetryGeneration,
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
  isSrtOnlyMode,
  t,
  onGenerateBackground
}) => {
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

  // Persist uploadedSrtInfo to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('uploaded_srt_info', JSON.stringify(uploadedSrtInfo));
    } catch (error) {
      console.error('Error saving uploaded SRT info to localStorage:', error);
    }
  }, [uploadedSrtInfo]);

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
  // Determine retry button visibility - show more aggressively for force retry
  const hasSubtitlesData = subtitlesData && subtitlesData.length > 0;
  const hasError = status?.type === 'error';
  const hasAnyVideoSource = selectedVideo || uploadedFile || localStorage.getItem('current_video_url') || localStorage.getItem('current_file_url');
  const isNotBusy = !isGenerating && !isDownloading;

  // Show retry button if:
  // 1. We have subtitles data OR there's an error OR there's any video source
  // 2. AND we're not currently busy
  const retryButtonVisible = (hasSubtitlesData || hasError || hasAnyVideoSource) && isNotBusy;

  return (
    <div className="buttons-container">
      <SrtUploadButton
        onSrtUpload={handleSrtUploadWithState}
        onSrtClear={handleSrtClear}
        disabled={isGenerating || isDownloading}
        hasSrtUploaded={uploadedSrtInfo.hasUploaded}
        uploadedFileName={uploadedSrtInfo.fileName}
      />

      {/* Add Subtitles Button - always visible like SrtUploadButton */}

      <AddSubtitlesButton
        onSubtitlesAdd={handleUserSubtitlesAdd}
        hasSubtitles={userProvidedSubtitles.trim() !== ''}
        subtitlesText={userProvidedSubtitles}
        disabled={isGenerating || isDownloading}
        onGenerateBackground={onGenerateBackground}
      />

      {/* Hide generate button when retrying segments, when isRetrying is true, or when any segment is being retried */}
      {validateInput() && retryingSegments.length === 0 && !isRetrying && !segmentsStatus.some(segment => segment.status === 'retrying') && (
        <button
          className={`generate-btn ${isGenerating || isDownloading ? 'processing' : ''}`}
          onClick={handleGenerateSubtitles}
          disabled={isGenerating || isDownloading}
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
              <span className="processing-gemini-icon">
                <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
              </span>
              <span className="processing-text">
                {isDownloading
                  ? t('output.downloadingVideoProgress', 'Downloading video: {{progress}}%', { progress: downloadProgress })
                  : t('output.processingVideo').split('...')[0]
                }
              </span>
              <span className="processing-dots"></span>
            </span>
          ) : isSrtOnlyMode ? t('output.srtOnlyMode', 'Working with SRT only') : t('header.tagline')}
        </button>
      )}

      {/* Add cancel button as a proper member of the buttons-container */}
      {isDownloading && currentDownloadId && validateInput() && retryingSegments.length === 0 && !isRetrying && !segmentsStatus.some(segment => segment.status === 'retrying') && (
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

      {retryButtonVisible && (
        <button
          className={`retry-gemini-btn ${retryingSegments.length > 0 ? 'processing' : ''}`}
          onClick={() => {
            console.log('FORCE RETRY button clicked!');
            try {
              handleRetryGeneration();
              console.log('Force retry initiated successfully');
            } catch (error) {
              console.error('Error calling handleRetryGeneration:', error);
            }
          }}
          disabled={isGenerating || isDownloading}
          title={t('output.retryGeminiTooltip')}
        >
          {/* Static Gemini icons for fallback */}
          <div className="gemini-icon-container">
            <div className="gemini-mini-icon random-2 size-sm">
              <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </div>
            <div className="gemini-mini-icon random-4 size-md">
              <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </div>
          </div>
          {retryingSegments.length > 0 ? (
            <span className="processing-text-container">
              <span className="processing-gemini-icon">
                <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" stroke="currentColor" strokeWidth="1.5"/>
                </svg>
              </span>
              <span className="processing-text">{t('output.processingVideo').split('...')[0]}</span>
              <span className="processing-dots"></span>
            </span>
          ) : (
            <>
              <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
                <path d="M1 4v6h6"></path>
                <path d="M23 20v-6h-6"></path>
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path>
              </svg>
              {t('output.retryGemini')}
            </>
          )}
        </button>
      )}

      {(isGenerating || retryingSegments.length > 0 || isRetrying) && (
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

            // Abort all ongoing Gemini API requests
            abortAllRequests();

            // Abort any active video analysis
            handleAbortVideoAnalysis();

            // Reset retrying state immediately
            if (isRetrying) {
              setIsRetrying(false);
            }
            // The state will be updated by the event listener in useSubtitles hook
          }}
          title={t('output.forceStopTooltip', 'Force stop all Gemini requests')}
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
            <div className="gemini-mini-icon random-2 size-sm">
              <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </div>
            <div className="gemini-mini-icon random-4 size-md">
              <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M14 28C14 26.0633 13.6267 24.2433 12.88 22.54C12.1567 20.8367 11.165 19.355 9.905 18.095C8.645 16.835 7.16333 15.8433 5.46 15.12C3.75667 14.3733 1.93667 14 0 14C1.93667 14 3.75667 13.6383 5.46 12.915C7.16333 12.1683 8.645 11.165 9.905 9.905C11.165 8.645 12.1567 7.16333 12.88 5.46C13.6267 3.75667 14 1.93667 14 0C14 1.93667 14.3617 3.75667 15.085 5.46C15.8317 7.16333 16.835 8.645 18.095 9.905C19.355 11.165 20.8367 12.1683 22.54 12.915C24.2433 13.6383 26.0633 14 28 14C26.0633 14 24.2433 14.3733 22.54 15.12C20.8367 15.8433 19.355 16.835 18.095 18.095C16.835 19.355 15.8317 20.8367 15.085 22.54C14.3617 24.2433 14 26.0633 14 28Z" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </div>
          </div>
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
