import { useState, useEffect, useRef } from 'react';
import SrtUploadButton from '../SrtUploadButton';
import AddSubtitlesButton from '../AddSubtitlesButton';
import VideoAnalysisButton from '../VideoAnalysisButton';
import LoadingIndicator from '../common/LoadingIndicator';
import WavyProgressIndicator from '../common/WavyProgressIndicator';
import { abortAllRequests } from '../../services/geminiService';
import { hasValidDownloadedVideo } from '../../utils/videoUtils';
import '../../styles/ButtonTextBalance.css';
import Tooltip from '../common/Tooltip';
import { publishProcessingRanges } from '../../events/bus';
import useAutoGenerateFlow from './hooks/useAutoGenerateFlow';
import { useSrtUploadState } from './utils/srtUploadState';


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
  // State for Vercel mode detection
  const [isVercelMode] = useState(() => {
    return typeof window !== 'undefined' && window.location.hostname.includes('vercel.app');
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

  // Auto-generation orchestration (start/wait/stop flow)
  const {
    isAutoGenerating,
    autoFlowStep,
    startAutoGenerateFlow
  } = useAutoGenerateFlow({
    apiKeysSet,
    t,
    handleGenerateSubtitles,
    subtitlesData,
    uploadedFile,
    selectedVideo,
    isVercelMode,
    onSegmentSelect,
    currentStateRef
  });

  // SRT upload tracking with localStorage persistence
  const {
    uploadedSrtInfo,
    handleSrtUploadWithState,
    handleSrtClear
  } = useSrtUploadState({
    subtitlesData,
    setSubtitlesData,
    status,
    isSrtOnlyMode,
    isGenerating,
    handleSrtUpload,
    handleUserSubtitlesAdd
  });

  // Update current state ref whenever props change
  useEffect(() => {
    currentStateRef.current = {
      uploadedFile,
      uploadedFileData,
      isDownloading,
      downloadProgress
    };
  }, [uploadedFile, uploadedFileData, isDownloading, downloadProgress]);

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
              } catch {
                // Overlay cleanup is advisory after force-stop.
              }
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
