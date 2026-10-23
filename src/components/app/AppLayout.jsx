import { useCallback, useEffect, useState } from 'react';
import Header from '../Header';
import InputMethods from '../InputMethods';
import OutputContainer from '../OutputContainer';
import ButtonsContainer from './ButtonsContainer';
import BackgroundImageGenerator from '../BackgroundImageGenerator';
import VideoRenderingSection from '../VideoRenderingSection';
import VideoQualityModal from '../VideoQualityModal';
import FloatingScrollbar from '../FloatingScrollbar';
import VideoProcessingOptionsModal from '../VideoProcessingOptionsModal';
import { useVideoInfo } from '../../hooks/useVideoInfo';
import BackgroundMusicSection from '../BackgroundMusicSection';
import { hasValidDownloadedVideo } from '../../utils/videoUtils';
import { initializeMobileZoom } from '../../utils/mobileZoom';
import { showErrorToast } from '../../utils/toastUtils';
import { activateOwnedLocalMedia } from '../../hooks/useNativeMediaSessionHydration';
import { updateActiveMedia } from '../../platform/activeMediaSource';
import { useProjectNarrationState } from '../../platform/projectNarrationState';
import SettingsModal from '../settings/SettingsModal';

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
  const [translatedSubtitles, setTranslatedSubtitles] = useState(null);
  const narrationState = useProjectNarrationState();

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
      }

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
    userProvidedSubtitles,
    useUserProvidedSubtitles,
    subtitlesData, setSubtitlesData,
    status, statusEventId, setStatus,
    timeFormat,
    showWaveformLongVideos,
    useOptimizedPreview,
    enableYoutubeSearch,
    optimizeVideos,
    optimizedResolution,
    // Video processing workflow
    isUploading,
    selectedSegment, setSelectedSegment,
    showProcessingModal, setShowProcessingModal,
    uploadedFileData,
    setUploadedFileData,
    isProcessingSegment
  } = appState;

  // A timeline range belongs to one exact media selection. Downloading or activating another
  // video must invalidate it even when React keeps the editor subtree mounted; otherwise the old
  // range is clamped onto the new duration and remains an interactive modal/range lock.
  const activeMediaSelectionKey = [
    uploadedFile?.assetId ?? uploadedFile?.playbackUrl ?? uploadedFile?.path ?? uploadedFile?.name ?? '',
    selectedVideo?.id ?? selectedVideo?.videoId ?? selectedVideo?.url ?? '',
  ].join('|');
  useEffect(() => {
    setSelectedSegment(null);
    setShowProcessingModal(false);
  }, [activeMediaSelectionKey, setSelectedSegment, setShowProcessingModal]);

  // A translation is a projection of one exact source timeline. Clear it as soon as that source
  // changes so sibling preview/export surfaces can never observe rows from the previous revision.
  useEffect(() => {
    setTranslatedSubtitles(null);
  }, [subtitlesData]);

  const {
    validateInput,
    handleSrtUpload,
    handleSrtClear,
    handleGenerateSubtitles,
    handleCancelDownload,
    handleTabChange,
    saveApiKeys,
    // New workflow handlers
    handleSegmentSelect,
    handleProcessWithOptions
  } = appHandlers;

  const {
    handleUserSubtitlesAdd,
    handleAbortVideoAnalysis
  } = modalHandlers;

  const handleNativeRenderVideoSelected = useCallback(async (media) => {
    await activateOwnedLocalMedia({ media, setUploadedFile });
    updateActiveMedia({ sourceUrl: null });
    setSelectedVideo(null);
    setUploadedFileData?.(null);
    setIsSrtOnlyMode(false);
  }, [setIsSrtOnlyMode, setSelectedVideo, setUploadedFile, setUploadedFileData]);

  // A quality re-download replaced the active media of the same project; the preview and any
  // processed-file copy must follow the newly published playback capability.
  const handleQualityMediaReplaced = useCallback((media) => {
    setUploadedFile(media);
    setUploadedFileData?.((current) => (current ? media : current));
  }, [setUploadedFile, setUploadedFileData]);

  // Use video info hook to track current video and available versions
  const {
    videoInfo,
    availableVersions,
    getVideoInfoForModal,
    getVideoFileForRendering
  } = useVideoInfo(selectedVideo, uploadedFile);

  // Initialize mobile zoom on component mount
  useEffect(() => {
    initializeMobileZoom(0.5); // Set zoom to 50% for mobile devices
  }, []);

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

      // If there would be only the "current" option, skip the modal and carry the native media
      // descriptor into rendering. Passing null here used to make the export panel reconstruct a
      // browser-era `{ url }` wrapper from an asynchronously published playback URL. A downloaded
      // video could therefore be active, playable and project-owned while Render opened an empty
      // panel when that URL notification had not arrived (or had just been reset).
      if (!showRedownloadOption && !showVersionOption) {
        proceedWithVideoRendering(uploadedFile, true);
        return;
      }

      // Otherwise, show the quality modal
      setShowVideoQualityModal(true);
    } else {
      // Preserve the selected native descriptor even while optional video metadata is loading.
      proceedWithVideoRendering(uploadedFile, false);
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
      console.error('Video quality selection failed:', error);
      showErrorToast(t('videoRendering.errorPrefix', 'Error: {{message}}', { message: error?.message }));
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
    if (hasAnyVideoSource && status?.code === 'srtOnlyMode') {
      setStatus({});
    }
  }, [selectedVideo, uploadedFile, status, setStatus]);

  return (
    <>
      <Header
        onSettingsClick={() => setShowSettings(true)}
        settingsOpen={showSettings}
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
            setUploadedFileData={appState.setUploadedFileData}
            apiKeysSet={apiKeysSet}
            isSrtOnlyMode={isSrtOnlyMode}
            setIsSrtOnlyMode={setIsSrtOnlyMode}
            setStatus={setStatus}
            subtitlesData={subtitlesData}
            enableYoutubeSearch={enableYoutubeSearch}
          />

          {/* Consistent layout container for buttons and output */}
          <div className="content-layout-container">
            <ButtonsContainer
              handleSrtUpload={handleSrtUpload}
              handleSrtClear={handleSrtClear}
              handleGenerateSubtitles={handleGenerateSubtitles}
              handleProcessWithOptions={handleProcessWithOptions}
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
              subtitlesData={subtitlesData}
              userProvidedSubtitles={userProvidedSubtitles}
              selectedVideo={selectedVideo}
              uploadedFile={uploadedFile}
              uploadedFileData={uploadedFileData}
              activeTab={activeTab}
              isSrtOnlyMode={isSrtOnlyMode}
              t={t}
              onGenerateBackground={handleGenerateBackground}
              isProcessingSegment={isProcessingSegment}
              setIsProcessingSegment={appState.setIsProcessingSegment}
              apiKeysSet={apiKeysSet}
            />

            <OutputContainer
              status={status}
              statusEventId={statusEventId}
              subtitlesData={subtitlesData}
              setSubtitlesData={setSubtitlesData}
              selectedVideo={selectedVideo}
              uploadedFile={uploadedFile}
              isDownloading={isDownloading}
              timeFormat={timeFormat}
              showWaveformLongVideos={showWaveformLongVideos}
              useOptimizedPreview={useOptimizedPreview}
              isSrtOnlyMode={isSrtOnlyMode}
              onRenderVideo={handleRenderVideo}
              onActualVideoUrlChange={setActualVideoUrl}
              onSegmentSelect={handleSegmentSelect}
              selectedSegment={selectedSegment}
              isUploading={isUploading}
              isProcessingSegment={isProcessingSegment}
              translatedSubtitles={translatedSubtitles}
              onTranslatedSubtitlesChange={setTranslatedSubtitles}
            />
          </div>

          {/* Video Rendering Section - Above Background Generator */}
          <VideoRenderingSection
            selectedVideo={selectedVideo}
            uploadedFile={uploadedFile}
            actualVideoUrl={actualVideoUrl}
            subtitlesData={subtitlesData}
            translatedSubtitles={translatedSubtitles}
            narrationResults={narrationState.resultsBySource.original}
            autoFillData={videoRenderingAutoFill}
            onNativeVideoSelected={handleNativeRenderVideoSelected}
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

      {/* Video Quality Modal */}
      {showVideoQualityModal && (
        <VideoQualityModal
          isOpen={showVideoQualityModal}
          onClose={() => setShowVideoQualityModal(false)}
          onConfirm={handleVideoQualityConfirm}
          onMediaReplaced={handleQualityMediaReplaced}
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
