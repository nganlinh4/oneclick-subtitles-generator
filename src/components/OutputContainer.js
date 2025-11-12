import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/OutputContainer.css';
import '../styles/narration/unifiedNarrationRedesign.css';
import VideoPreview from './previews/VideoPreview';
import LyricsDisplay from './LyricsDisplay';
import TranslationSection from './translation';
import { UnifiedNarrationSection } from './narration';
import ParallelProcessingStatus from './ParallelProcessingStatus';
import { EVENTS, subscribe } from '../events/bus';
import { hasValidDownloadedVideo, isBlobUrlValid } from '../utils/videoUtils';
// BackgroundImageGenerator moved back to AppLayout

const OutputContainer = ({
  status,
  subtitlesData,
  setSubtitlesData,
  selectedVideo,
  uploadedFile,
  isGenerating,
  segmentsStatus = [],
  activeTab,
  onRetrySegment,
  onRetryWithModel,
  onGenerateSegment,
  videoSegments = [],
  retryingSegments = [],
  timeFormat = 'seconds',
  useOptimizedPreview = false,
  useCookiesForDownload = true,
  isSrtOnlyMode = false,
  onViewRules,
  userProvidedSubtitles = '',
  onUserSubtitlesAdd,
  onGenerateBackground,
  onRenderVideo,
  onActualVideoUrlChange,
  onSegmentSelect = null, // Callback for segment selection
  selectedSegment = null, // Currently selected segment
  isUploading = false, // Whether video is currently uploading
  isProcessingSegment = false, // Whether a segment is being processed
  onLiveSubtitlesChange = null // Optional: report live timeline state upstream
}) => {
  const { t } = useTranslation();
  const [currentTabIndex, setCurrentTabIndex] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [editedLyrics, setEditedLyrics] = useState(null);
  const [translatedSubtitles, setTranslatedSubtitles] = useState(null);
  const [seekTime, setSeekTime] = useState(null); // Track when seeking happens
  const [referenceAudio, setReferenceAudio] = useState(null); // Reference audio for narration
  const [renderedSections, setRenderedSections] = useState({ preview: false, translation: false, narration: false }); // Track staggered rendering

  const handleLyricClick = (time) => {
    setCurrentTabIndex(time);
  };

  const handleVideoSeek = (time) => {
    // Set the seek time to trigger timeline centering
    setSeekTime(time);

    // Reset the seek time in the next frame to allow future seeks
    requestAnimationFrame(() => {
      setSeekTime(null);
    });
  };

  const handleUpdateLyrics = (updatedLyrics) => {
    setEditedLyrics(updatedLyrics);
  };

  // Handle saving subtitles
  const handleSaveSubtitles = (savedLyrics) => {
    // Update the edited lyrics state with the saved lyrics
    setEditedLyrics(savedLyrics);
    // Also update the subtitlesData in the parent component
    // This ensures that if the page is reloaded, the saved subtitles will be used
    if (setSubtitlesData) {
      setSubtitlesData(savedLyrics);
    }
  };

  const [preferLiveDuringProcessing, setPreferLiveDuringProcessing] = useState(false);

  useEffect(() => {
    // Prefer live stream while generating or processing
    if (isGenerating || isProcessingSegment || (Array.isArray(retryingSegments) && retryingSegments.length > 0)) {
      setPreferLiveDuringProcessing(true);
    }
  }, [isGenerating, isProcessingSegment, retryingSegments]);

  useEffect(() => {
    const onRetry = () => setPreferLiveDuringProcessing(true);
    const onStreamUpdate = () => setPreferLiveDuringProcessing(true);
    const onStreamDone = () => setPreferLiveDuringProcessing(false);
    const onRetryDone = () => setPreferLiveDuringProcessing(false);
    const un1 = subscribe(EVENTS.RETRY_SEGMENT_FROM_CACHE, onRetry);
    const un2 = subscribe(EVENTS.STREAMING_UPDATE, onStreamUpdate);
    const un3 = subscribe(EVENTS.STREAMING_COMPLETE, onStreamDone);
    const un4 = subscribe(EVENTS.RETRY_SEGMENT_FROM_CACHE_COMPLETE, onRetryDone);
    return () => { un1(); un2(); un3(); un4(); };
  }, []);

  const formatSubtitlesForLyricsDisplay = (subtitles) => {
    // While processing/retrying, show live subtitles instead of stale edits
    const sourceData = preferLiveDuringProcessing ? subtitles : (editedLyrics || subtitles);
    return sourceData?.map(sub => ({
      ...sub,
      startTime: sub.start,
      endTime: sub.end
    })) || [];
  };
  // Whenever editedLyrics changes, report live timeline state (only when non-empty)
  useEffect(() => {
    if (!onLiveSubtitlesChange) return;
    const arr = editedLyrics || subtitlesData;
    if (Array.isArray(arr) && arr.length > 0) {
      onLiveSubtitlesChange(arr);
    }
  }, [editedLyrics, subtitlesData, onLiveSubtitlesChange]);


  // Background Image Generator functionality moved back to AppLayout

  // When subtitles are loaded from cache, they should be considered as the source of truth
  // This ensures that saved edits are properly loaded when the page is reloaded

  // Download functionality moved to LyricsDisplay component

  // Set video source when a video is selected or file is uploaded
  const [videoSource, setVideoSource] = useState('');
  const [actualVideoUrl, setActualVideoUrl] = useState('');
  const [fileType, setFileType] = useState('');
  useEffect(() => {
    // Reset the actual video URL when the source changes
    setActualVideoUrl('');
    setFileType('');

    // First check for uploaded file
    const uploadedFileUrl = localStorage.getItem('current_file_url');
    if (uploadedFileUrl) {
      // Check if it's a blob URL and if we have an uploadedFile
      if (uploadedFileUrl.startsWith('blob:')) {
        // Only use blob URLs if we have an uploadedFile (indicates current session)
        if (uploadedFile) {
          setVideoSource(uploadedFileUrl);
          setFileType(uploadedFile.type || '');
        } else {
          // No uploadedFile means this is a stale blob URL, clear it
          localStorage.removeItem('current_file_url');
          setVideoSource('');
          setFileType('');
        }
        return;
      } else {
        // Non-blob URL, use it directly
        setVideoSource(uploadedFileUrl);
        // For non-blob URLs from localStorage, check if we have a downloaded video file
        const downloadedFile = window.downloadedVideoFile;
        if (downloadedFile && downloadedFile.type) {
          setFileType(downloadedFile.type);
        } else {
          // Assume video if no type info available
          setFileType('video/mp4');
        }
        return;
      }
    }

    // Then check for YouTube video
    if (selectedVideo?.url) {
      // Store the selected video URL in localStorage to maintain state
      if (selectedVideo.source === 'youtube' || selectedVideo.source === 'douyin' || selectedVideo.source === 'all-sites') {
        localStorage.setItem('current_video_url', selectedVideo.url);
      }

      // Special case: If we're in SRT-only mode, don't set videoSource
      if (isSrtOnlyMode) {
        setVideoSource('');
        setFileType('');
        return;
      }

      setVideoSource(selectedVideo.url);
      // For YouTube/Douyin URLs, assume video
      setFileType('video/mp4');
      return;
    }

    // Check if we have a video URL in localStorage but no selectedVideo object
    const videoUrl = localStorage.getItem('current_video_url');
    if (videoUrl && !selectedVideo && !isSrtOnlyMode) {

      setVideoSource(videoUrl);
      // For URLs from localStorage, assume video
      setFileType('video/mp4');
      return;
    }

    // Clear video source if nothing is selected
    setVideoSource('');
    setFileType('');
  }, [selectedVideo, uploadedFile, isSrtOnlyMode]);

  // Notify parent when actualVideoUrl changes
  useEffect(() => {
    if (onActualVideoUrlChange) {
      onActualVideoUrlChange(actualVideoUrl);
    }
  }, [actualVideoUrl, onActualVideoUrlChange]);

  // Calculate virtual duration for SRT-only mode
  useEffect(() => {
    if (isSrtOnlyMode && subtitlesData && subtitlesData.length > 0) {
      // Find the last subtitle's end time to use as virtual duration
      const lastSubtitle = [...subtitlesData].sort((a, b) => b.end - a.end)[0];
      if (lastSubtitle && lastSubtitle.end) {
        // Add a small buffer to the end (10 seconds)
        setVideoDuration(lastSubtitle.end + 10);
      }
    }
  }, [isSrtOnlyMode, subtitlesData]);

  // Reset edited lyrics when subtitlesData changes (new video/generation)
  useEffect(() => {
    setEditedLyrics(null);
  }, [subtitlesData]);

  // Show status messages as toasts instead of inline
  useEffect(() => {
    if (status?.message) {
      const message = typeof status.message === 'string' ? (
        status.message.includes('cache') ? t('output.subtitlesLoadedFromCache', 'Subtitles loaded from cache!') :
        status.message.includes('Video segments ready') ? t('output.segmentsReady', 'Video segments are ready for processing!') :
        status.message
      ) : 'Processing...';

      // Check if onboarding is active before showing toast
      const hasVisited = localStorage.getItem('has_visited_site') === 'true';
      const controlsDismissed = localStorage.getItem('onboarding_controls_dismissed') === 'true';
      const isOnboardingActive = !(hasVisited && controlsDismissed);

      if (!isOnboardingActive) {
        window.addToast(message, status.type || 'info', 5000, 'output-status');
      }
    } else {
      window.removeToastByKey && window.removeToastByKey('output-status');
    }
  }, [status?.message, status?.type, t]);

  // Staggered rendering to ease resource burden during expansion
  const [previousCondition, setPreviousCondition] = useState(false);
  useEffect(() => {
    const currentCondition = (subtitlesData || uploadedFile || isUploading || status?.message?.includes('select a segment'));
    if (currentCondition && !previousCondition) {
      // Condition just became true, wait for container animation (500ms) then start staggered rendering
      setTimeout(() => {
        setRenderedSections({ preview: true, translation: false, narration: false });
        setTimeout(() => setRenderedSections(prev => ({ ...prev, translation: true })), 150);
        setTimeout(() => setRenderedSections(prev => ({ ...prev, narration: true })), 300);
      }, 500);
    } else if (!currentCondition && previousCondition) {
      // Condition became false, reset
      setRenderedSections({ preview: false, translation: false, narration: false });
    }
    setPreviousCondition(currentCondition);
  }, [subtitlesData, uploadedFile, isUploading, status?.message, previousCondition]);

  // Background Image Generator functionality moved back to AppLayout

  // Determine if there's any content to show
  const hasParallelProcessingStatus = segmentsStatus.length > 0 && (subtitlesData || !activeTab.includes('youtube'));
  const hasMainContent = (subtitlesData || uploadedFile || isUploading || status?.message?.includes('select a segment'));

  // Don't render anything if there's no content to show
  if (!hasParallelProcessingStatus && !hasMainContent) {
    return null;
  }

  return (
    <div className="output-container">
      {/* Add Subtitles Button removed - now only in buttons-container */}

      {/* Show status message or segments status - Combined logic to avoid duplicate rendering */}
      {hasParallelProcessingStatus ? (
        <ParallelProcessingStatus
          segments={segmentsStatus}
          overallStatus={
            // Translate common status messages that might be hardcoded
            typeof status?.message === 'string' ? (
              status.message.includes('cache') ? t('output.subtitlesLoadedFromCache', 'Subtitles loaded from cache!') :
              status.message.includes('Video segments ready') ? t('output.segmentsReady', 'Video segments are ready for processing!') :
              status.message
            ) : t('output.segmentsReady', 'Video segments are ready for processing!')
          }
          statusType={status?.type || 'success'}
          onRetrySegment={(segmentIndex, _, options) => {
            onRetrySegment && onRetrySegment(segmentIndex, videoSegments, options);
          }}
          userProvidedSubtitles={userProvidedSubtitles}
          onRetryWithModel={(segmentIndex, modelId) => {
            onRetryWithModel && onRetryWithModel(segmentIndex, modelId, videoSegments);
          }}
          onGenerateSegment={(segmentIndex) => {
            onGenerateSegment && onGenerateSegment(segmentIndex, videoSegments);
          }}
          retryingSegments={retryingSegments}
          onViewRules={onViewRules}
        />
      ) : null}

      {(subtitlesData || uploadedFile || isUploading || status?.message?.includes('select a segment')) && (
        <>
          {renderedSections.preview && (
            <div className="preview-section">
            {/* Check if we should hide sections for URL + SRT without downloaded video */}
            {(() => {
              // Show sections if:
              // 1. Not in SRT-only mode AND
              // 2. Either we have an uploaded file OR we have a valid downloaded video
              const hasActualVideo = uploadedFile || hasValidDownloadedVideo(uploadedFile);
              return !isSrtOnlyMode && hasActualVideo;
            })() && (
              <VideoPreview
                currentTime={currentTabIndex}
                setCurrentTime={setCurrentTabIndex}
                videoSource={videoSource}
                fileType={fileType}
                setDuration={setVideoDuration}
                onSeek={handleVideoSeek}
                translatedSubtitles={translatedSubtitles}
                subtitlesArray={editedLyrics || subtitlesData}
                onVideoUrlReady={setActualVideoUrl}
                useOptimizedPreview={useOptimizedPreview}
                useCookiesForDownload={useCookiesForDownload}
                onReferenceAudioChange={setReferenceAudio}
                onRenderVideo={onRenderVideo}
              />
            )}

            {isSrtOnlyMode && (
              <div className="srt-only-message">
                <div className="info-icon">
                  <span className="material-symbols-rounded" style={{ fontSize: '24px' }}>info</span>
                </div>
                <p>{t('output.srtOnlyModeInfo', 'Working with SRT file only. No video source available.')}</p>
                <p>{t('output.srtOnlyModeHint', 'You can still edit, translate, and download the subtitles.')}</p>
              </div>
            )}
            <LyricsDisplay
              matchedLyrics={formatSubtitlesForLyricsDisplay(subtitlesData)}
              currentTime={currentTabIndex}
              onLyricClick={handleLyricClick}
              onUpdateLyrics={handleUpdateLyrics}
              onSaveSubtitles={handleSaveSubtitles}
              allowEditing={true}
              duration={videoDuration}
              seekTime={seekTime}
              timeFormat={timeFormat}
              videoSource={isSrtOnlyMode ? null : actualVideoUrl}
              translatedSubtitles={translatedSubtitles}
              videoTitle={selectedVideo?.title || uploadedFile?.name?.replace(/\.[^/.]+$/, '') || 'subtitles'}
              onSegmentSelect={onSegmentSelect}
              selectedSegment={selectedSegment}
              isProcessingSegment={isProcessingSegment}
            />

            {/* Download buttons moved to LyricsDisplay component */}
            </div>
          )}

          {/* Translation Section */}
          {renderedSections.translation && (
            <TranslationSection
              subtitles={editedLyrics || subtitlesData}
              videoTitle={selectedVideo?.title || uploadedFile?.name?.replace(/\.[^/.]+$/, '') || 'subtitles'}
              onTranslationComplete={setTranslatedSubtitles}
            />
          )}

          {/* Unified Narration Section - Now separate from Translation */}
          {renderedSections.narration && (
            <UnifiedNarrationSection
              subtitles={translatedSubtitles || editedLyrics || subtitlesData}
              originalSubtitles={editedLyrics || subtitlesData}
              translatedSubtitles={translatedSubtitles}
              referenceAudio={referenceAudio}
              videoPath={actualVideoUrl}
              onReferenceAudioChange={setReferenceAudio}
            />
          )}

          {/* Background Image Generator moved back to AppLayout */}
        </>
      )}
    </div>
  );
};

export default OutputContainer;