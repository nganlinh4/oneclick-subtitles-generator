import React, { useEffect, useState } from 'react';
import Header from '../Header';
import InputMethods from '../InputMethods';
import OutputContainer from '../OutputContainer';
import ButtonsContainer from './ButtonsContainer';
import SettingsModal from '../settings/SettingsModal';
import VideoAnalysisModal from '../VideoAnalysisModal';
import TranscriptionRulesEditor from '../TranscriptionRulesEditor';
import BackgroundImageGenerator from '../BackgroundImageGenerator';
import VideoRenderingSection from '../VideoRenderingSection';
import VideoQualityModal from '../VideoQualityModal';
import FloatingScrollbar from '../FloatingScrollbar';
import OnboardingBanner from '../OnboardingBanner';
import VideoProcessingOptionsModal from '../VideoProcessingOptionsModal';
import { useVideoInfo } from '../../hooks/useVideoInfo';
import BackgroundMusicSection from '../BackgroundMusicSection';
import { hasValidDownloadedVideo } from '../../utils/videoUtils';
import { initializeMobileZoom } from '../../utils/mobileZoom';

/**
 * Main application layout component
 */
const AppLayout = ({
  appState,
  appHandlers,
  modalHandlers,
  t
}) => {
  // State for background image generator
  const [showBackgroundGenerator, setShowBackgroundGenerator] = useState(false);
  const [backgroundLyrics, setBackgroundLyrics] = useState('');
  const [backgroundAlbumArt, setBackgroundAlbumArt] = useState('');
  const [backgroundSongName, setBackgroundSongName] = useState('');

  // State for video rendering section
  const [videoRenderingAutoFill, setVideoRenderingAutoFill] = useState(null);
  const [actualVideoUrl, setActualVideoUrl] = useState('');

  // State for video quality modal
  const [showVideoQualityModal, setShowVideoQualityModal] = useState(false);

  // Handler for generating background image
  const handleGenerateBackground = (lyrics, albumArt, songName) => {



    // Set the state variables immediately
    setBackgroundLyrics(lyrics);
    setBackgroundAlbumArt(albumArt);
    setBackgroundSongName(songName || '');

    // Force expand the component
    setShowBackgroundGenerator(true);


    // Scroll to the BackgroundImageGenerator after it's rendered
    setTimeout(() => {
      const backgroundGenerator = document.querySelector('.background-generator-container');
      if (backgroundGenerator) {
        // JS-driven smooth scroll (same "flying" animation as rendering section)
        const startY = window.scrollY || window.pageYOffset;
        const rect = backgroundGenerator.getBoundingClientRect();
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
          }
        };
        requestAnimationFrame(animate);
      } else {

      }

      // Check if the container is still collapsed
      const isStillCollapsed = backgroundGenerator?.classList.contains('collapsed');

    }, 500); // Increased timeout to ensure component is rendered
  };

  const {
    showSettings, setShowSettings,
    activeTab,
    selectedVideo, setSelectedVideo,
    uploadedFile, setUploadedFile,
    apiKeysSet, setApiKeysSet,
    isAppReady,
    isGenerating,
    isDownloading,
    downloadProgress,
    currentDownloadId,
    isRetrying,
    isSrtOnlyMode, setIsSrtOnlyMode,
    showVideoAnalysis, setShowVideoAnalysis,
    videoAnalysisResult, setVideoAnalysisResult,
    segmentsStatus,
    videoSegments,
    showRulesEditor, setShowRulesEditor,
    userProvidedSubtitles,
    useUserProvidedSubtitles,
    transcriptionRules,
    subtitlesData, setSubtitlesData,
    status, setStatus,
    timeFormat,
    showWaveformLongVideos,
    useOptimizedPreview,
    useCookiesForDownload,
    enableYoutubeSearch,
    optimizeVideos,
    optimizedResolution,
    retryingSegments,
    retrySegment,
    // Video processing workflow
    isUploading,
    selectedSegment, setSelectedSegment,
    showProcessingModal, setShowProcessingModal,
    uploadedFileData,
    isProcessingSegment
  } = appState;

  const {
    validateInput,
    handleSrtUpload,
    handleGenerateSubtitles,
    handleRetryGeneration,
    handleCancelDownload,
    handleTabChange,
    saveApiKeys,
    // New workflow handlers
    handleSegmentSelect,
    handleProcessWithOptions
  } = appHandlers;

  const {
    handleUseRecommendedPreset,
    handleUseDefaultPreset,
    handleEditRules,
    handleSaveRules,
    handleViewRules,
    handleUserSubtitlesAdd,
    handleAbortVideoAnalysis
  } = modalHandlers;

  // Use video info hook to track current video and available versions
  const {
    videoInfo,
    availableVersions,
    getVideoInfoForModal,
    getVideoFileForRendering
  } = useVideoInfo(selectedVideo, uploadedFile, actualVideoUrl);

  // Initialize mobile zoom on component mount
  useEffect(() => {
    initializeMobileZoom(0.5); // Set zoom to 50% for mobile devices
  }, []);

  // Handler for generating a specific segment
  const handleGenerateSegment = async (segmentIndex, segments) => {
    if (!segments || !segments[segmentIndex]) {
      console.error('No segment found at index', segmentIndex);
      return;
    }

    // Prepare options for segment generation
    const segmentOptions = {};

    // Add user-provided subtitles if available and enabled
    if (useUserProvidedSubtitles && userProvidedSubtitles) {
      segmentOptions.userProvidedSubtitles = userProvidedSubtitles;
    }

    // Use the retrySegment function which will properly combine this segment's results
    // with any previously processed segments
    await retrySegment(segmentIndex, segments, segmentOptions);
  };

  // Handler for retrying a segment with a specific model
  const handleRetryWithModel = async (segmentIndex, modelId, segments) => {
    if (!segments || !segments[segmentIndex]) {
      console.error('No segment found at index', segmentIndex);
      return;
    }

    // Save the current model
    const currentModel = localStorage.getItem('gemini_model');

    // Temporarily set the selected model
    localStorage.setItem('gemini_model', modelId);

    // Prepare options for segment retry
    const segmentOptions = {};

    // Add user-provided subtitles if available and enabled
    if (useUserProvidedSubtitles && userProvidedSubtitles) {
      segmentOptions.userProvidedSubtitles = userProvidedSubtitles;
    }

    try {
      // Use the retrySegment function with the temporarily set model
      await retrySegment(segmentIndex, segments, segmentOptions);
    } finally {
      // Restore the original model
      if (currentModel) {
        localStorage.setItem('gemini_model', currentModel);
      } else {
        localStorage.removeItem('gemini_model');
      }
    }
  };
  // Handler for render video action
  const handleRenderVideo = () => {
    // If we have video info, decide whether the quality modal would present more than one option
    if (videoInfo) {
      const infoForModal = getVideoInfoForModal()?.videoInfo || videoInfo;
      // Mirror VideoQualityModal's option visibility logic
      const showRedownloadOption = !!(infoForModal?.source &&
        ['youtube', 'all-sites'].includes(infoForModal.source) &&
        infoForModal.url);
      const showVersionOption = Array.isArray(availableVersions) && availableVersions.length > 0;

      // If there would be only the "current" option, skip the modal and auto-scroll to rendering
      if (!showRedownloadOption && !showVersionOption) {
        proceedWithVideoRendering(null, true); // will expand + scroll (source set to 'video-quality-modal')
        return;
      }

      // Otherwise, show the quality modal
      setShowVideoQualityModal(true);
    } else {
      // Fallback to original behavior if no video info - no auto-scroll for fallback
      proceedWithVideoRendering(null, false);
    }
  };

  // Proceed with video rendering (original behavior)
  const proceedWithVideoRendering = (videoFile = null, shouldAutoScroll = false) => {
    // Auto-fill the video rendering section and ensure it's expanded
    setVideoRenderingAutoFill({
      timestamp: Date.now(), // Use timestamp to trigger re-render
      expand: true, // Signal to expand the section
      autoScroll: shouldAutoScroll, // Only scroll when explicitly requested
      videoFile: videoFile, // Pass selected video file if any
      source: shouldAutoScroll ? 'video-quality-modal' : 'fallback' // Track the source of the request
    });

    // Clear the auto-fill data after a short delay to prevent reuse on subsequent re-renders
    setTimeout(() => {
      setVideoRenderingAutoFill(null);
    }, 1000);
  };

  // Handler for video quality modal confirmation
  const handleVideoQualityConfirm = async (option, data = {}) => {
    try {
      // Get the appropriate video file based on user selection
      const videoFile = await getVideoFileForRendering(option, data);

      // Close the modal
      setShowVideoQualityModal(false);

      // Proceed with video rendering using the selected video - enable auto-scroll for quality modal
      proceedWithVideoRendering(videoFile, true);
    } catch (error) {
      const context = {
        option,
        data,
        actualVideoUrl,
        online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
        name: error?.name,
        message: error?.message,
        cause: error?.cause,
        stack: error?.stack
      };
      console.error('Error handling video quality selection (with context):', context);
      const isFailedToFetch = error?.message === 'Failed to fetch' || error?.name === 'TypeError';
      let hint = '';
      if (isFailedToFetch) {
        if (String(actualVideoUrl || '').startsWith('blob:')) {
          hint = 'The temporary video blob may have been revoked or expired. Try re-adding the video.';
        } else if (typeof window !== 'undefined' && window.location?.protocol === 'https:' && (String(actualVideoUrl || '').startsWith('http:') || (data?.url && String(data.url).startsWith('http:')))) {
          hint = 'Blocked mixed content: page is HTTPS but the video/API is HTTP. Use HTTPS for the API/video or run the app over HTTP.';
        } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          hint = 'You appear to be offline.';
        } else {
          hint = 'Network/CORS issue. Check the Network tab for the failing request and the server logs.';
        }
      }
      alert(`Error: ${error?.message}${hint ? `\n\nHint: ${hint}` : ''}`);
    }
  };

  // Handle when video source is removed or added
  useEffect(() => {
    // Check if we have an actual downloaded video file (not just a pasted URL)
    const hasDownloadedVideo = hasValidDownloadedVideo(uploadedFile);

    // Determine availability
    const hasAnyVideoSource = !!(selectedVideo || uploadedFile || hasDownloadedVideo);
    const hasAnySubtitles = Array.isArray(subtitlesData) && subtitlesData.length > 0;

    // Only enter SRT-only mode when we truly have subtitles loaded but no video source
    if (!hasAnyVideoSource && hasAnySubtitles) {
      setIsSrtOnlyMode(true);
    }
    // Exit SRT-only mode when any video source becomes available
    else if (hasAnyVideoSource && isSrtOnlyMode) {
      setIsSrtOnlyMode(false);
    }
  }, [selectedVideo, uploadedFile, subtitlesData, isSrtOnlyMode, setIsSrtOnlyMode]);

  // Separate useEffect to clear SRT-only status messages when we have a video source
  useEffect(() => {
    const hasDownloadedVideo = hasValidDownloadedVideo(uploadedFile);
    const hasAnyVideoSource = selectedVideo || uploadedFile || hasDownloadedVideo;

    // Only clear specific SRT-only messages, not all status messages
    if (hasAnyVideoSource && status?.message && status.type === 'info' && (
      status.message.includes('Working with SRT only') ||
      status.message.includes('SRT only') ||
      status.message.includes('No video source available')
    )) {
      console.log('Clearing SRT-only status message:', status.message);
      setStatus({});
    }
  }, [selectedVideo, uploadedFile, status, setStatus]);

  return (
    <>
      <Header
        onSettingsClick={() => setShowSettings(true)}
      />

      {isAppReady && (
        <main className="app-main">
          <InputMethods
            activeTab={activeTab}
            setActiveTab={handleTabChange}
            selectedVideo={selectedVideo}
            setSelectedVideo={setSelectedVideo}
            uploadedFile={uploadedFile}
            setUploadedFile={setUploadedFile}
            apiKeysSet={apiKeysSet}
            isSrtOnlyMode={isSrtOnlyMode}
            setIsSrtOnlyMode={setIsSrtOnlyMode}
            setStatus={setStatus}
            subtitlesData={subtitlesData}
            setVideoSegments={appState.setVideoSegments}
            setSegmentsStatus={appState.setSegmentsStatus}
            enableYoutubeSearch={enableYoutubeSearch}
          />

          {/* Consistent layout container for buttons and output */}
          <div className="content-layout-container">
            <ButtonsContainer
              handleSrtUpload={handleSrtUpload}
              handleGenerateSubtitles={handleGenerateSubtitles}
              handleCancelDownload={handleCancelDownload}
              handleUserSubtitlesAdd={handleUserSubtitlesAdd}
              handleAbortVideoAnalysis={handleAbortVideoAnalysis}
              validateInput={validateInput}
              isGenerating={isGenerating}
              isDownloading={isDownloading}
              downloadProgress={downloadProgress}
              currentDownloadId={currentDownloadId}
              isRetrying={isRetrying}
              setIsRetrying={appState.setIsRetrying}
              retryingSegments={retryingSegments}
              segmentsStatus={segmentsStatus}
              subtitlesData={subtitlesData}
              setSubtitlesData={setSubtitlesData}
              status={status}
              userProvidedSubtitles={userProvidedSubtitles}
              selectedVideo={selectedVideo}
              uploadedFile={uploadedFile}
              uploadedFileData={uploadedFileData}
              isSrtOnlyMode={isSrtOnlyMode}
              t={t}
              onGenerateBackground={handleGenerateBackground}
              isProcessingSegment={isProcessingSegment}
              setIsProcessingSegment={appState.setIsProcessingSegment}
              apiKeysSet={apiKeysSet}
              onSegmentSelect={handleSegmentSelect}
            />

            <OutputContainer
              status={status}
              subtitlesData={subtitlesData}
              setSubtitlesData={setSubtitlesData}
              selectedVideo={selectedVideo}
              uploadedFile={uploadedFile}
              isGenerating={isGenerating}
              segmentsStatus={segmentsStatus}
              activeTab={activeTab}
              onRetrySegment={retrySegment}
              onRetryWithModel={handleRetryWithModel}
              onGenerateSegment={handleGenerateSegment}
              videoSegments={videoSegments}
              retryingSegments={retryingSegments}
              timeFormat={timeFormat}
              showWaveformLongVideos={showWaveformLongVideos}
              useOptimizedPreview={useOptimizedPreview}
              useCookiesForDownload={useCookiesForDownload}
              isSrtOnlyMode={isSrtOnlyMode}
              onViewRules={handleViewRules}
              userProvidedSubtitles={userProvidedSubtitles}
              onUserSubtitlesAdd={(text) => {
                handleUserSubtitlesAdd(text);
                // Close background generator if open
                setShowBackgroundGenerator(false);
              }}
              onGenerateBackground={handleGenerateBackground}
              onRenderVideo={handleRenderVideo}
              onActualVideoUrlChange={setActualVideoUrl}
              onSegmentSelect={handleSegmentSelect}
              selectedSegment={selectedSegment}
              isUploading={isUploading}
              isProcessingSegment={isProcessingSegment}
              onLiveSubtitlesChange={(live) => setSubtitlesData(live)}
            />
          </div>

          {/* Video Rendering Section - Above Background Generator */}
          <VideoRenderingSection
            selectedVideo={selectedVideo}
            uploadedFile={uploadedFile}
            actualVideoUrl={actualVideoUrl}
            subtitlesData={subtitlesData}
            translatedSubtitles={window.translatedSubtitles}
            narrationResults={window.originalNarrations || window.translatedNarrations}
            autoFillData={videoRenderingAutoFill}
          />

          {/* Background Image Generator - Always visible but collapsed at page start */}
          <BackgroundImageGenerator
            lyrics={backgroundLyrics}
            albumArt={backgroundAlbumArt}
            songName={backgroundSongName}
            isExpanded={showBackgroundGenerator}
            onExpandChange={(expanded) => setShowBackgroundGenerator(expanded)}
          />

          {/* Background Music Generator */}
          <BackgroundMusicSection />
        </main>
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSave={saveApiKeys}
          apiKeysSet={apiKeysSet}
          setApiKeysSet={setApiKeysSet}
          optimizeVideos={optimizeVideos}
          optimizedResolution={optimizedResolution}
          useOptimizedPreview={useOptimizedPreview}
        />
      )}

      {/* Video Analysis Modal */}
      {/* Check if we should show the modal */}
      {((showVideoAnalysis || localStorage.getItem('show_video_analysis') === 'true') &&
        (videoAnalysisResult || localStorage.getItem('video_analysis_result'))) && (
        <VideoAnalysisModal
          isOpen={true}
          onClose={() => {
            // Clear localStorage flags
            localStorage.removeItem('show_video_analysis');
            localStorage.removeItem('video_analysis_timestamp');
            localStorage.removeItem('video_analysis_result');
            setShowVideoAnalysis(false);
            setVideoAnalysisResult(null);
            // Use default preset if user closes the modal
            handleUseDefaultPreset();
          }}
          analysisResult={videoAnalysisResult}
          onUsePreset={handleUseRecommendedPreset}
          onUseDefaultPreset={handleUseDefaultPreset}
          onEditRules={handleEditRules}
        />
      )}

      {/* Transcription Rules Editor */}
      {showRulesEditor && transcriptionRules && (
        <TranscriptionRulesEditor
          isOpen={showRulesEditor}
          onClose={(action) => {
            setShowRulesEditor(false);
            // Reopen the video analysis modal only if it was previously open
            if ((action === 'cancel' || action === 'save') && videoAnalysisResult) {
              setShowVideoAnalysis(true);
              // Set localStorage flag to ensure modal stays open
              localStorage.setItem('show_video_analysis', 'true');
              // If we have a video analysis result, make sure it's available
              localStorage.setItem('video_analysis_result', JSON.stringify(videoAnalysisResult));
              localStorage.setItem('video_analysis_timestamp', Date.now().toString());
            }
          }}
          initialRules={transcriptionRules}
          onSave={handleSaveRules}
          onChangePrompt={(preset) => {

            // If we're using a recommended preset from video analysis, update the session storage
            if (sessionStorage.getItem('current_session_preset_id')) {
              sessionStorage.setItem('current_session_preset_id', preset.id);
              sessionStorage.setItem('current_session_prompt', preset.prompt);
            } else {
              // Otherwise update the localStorage
              localStorage.setItem('transcription_prompt', preset.prompt);
            }
          }}
        />
      )}

      {/* Video Quality Modal */}
      {showVideoQualityModal && (
        <VideoQualityModal
          isOpen={showVideoQualityModal}
          onClose={() => setShowVideoQualityModal(false)}
          onConfirm={handleVideoQualityConfirm}
          videoInfo={getVideoInfoForModal()?.videoInfo || videoInfo}
          actualDimensions={getVideoInfoForModal()?.actualDimensions}
          availableVersions={availableVersions}
        />
      )}

      {/* Video Processing Options Modal */}
      {showProcessingModal && (
        <VideoProcessingOptionsModal
          key={`${(uploadedFileData || uploadedFile)?.name || 'no-file'}-${(uploadedFileData || uploadedFile)?.size || 0}-${(uploadedFileData || uploadedFile)?.type || 'no-type'}`}
          isOpen={showProcessingModal}
          onClose={() => {
            try {
              const reason = sessionStorage.getItem('processing_modal_open_reason');
              if (reason === 'retry-offline' && selectedSegment && typeof selectedSegment.start === 'number' && typeof selectedSegment.end === 'number') {
                window.dispatchEvent(new CustomEvent('retry-offline-modal-closed', { detail: { start: selectedSegment.start, end: selectedSegment.end, confirmed: false } }));
              }
            } catch {}
            setShowProcessingModal(false);
            setSelectedSegment(null);
          }}
          onProcess={handleProcessWithOptions}
          onSelectedSegmentChange={setSelectedSegment}
          selectedSegment={selectedSegment}
          videoDuration={uploadedFile?.duration || selectedVideo?.duration || 0}
          isUploading={isUploading}
          videoFile={uploadedFileData || uploadedFile}
          userProvidedSubtitles={userProvidedSubtitles}
          useUserProvidedSubtitles={useUserProvidedSubtitles}
          subtitlesData={subtitlesData}
        />
      )}


      {/* Floating scrollbar component */}
      <FloatingScrollbar />
    </>
  );
};

export default AppLayout;
