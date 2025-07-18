import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/OutputContainer.css';
import '../styles/narration/unifiedNarrationRedesign.css';
import VideoPreview from './previews/VideoPreview';
import LyricsDisplay from './LyricsDisplay';
import TranslationSection from './translation';
import { UnifiedNarrationSection } from './narration';
import ParallelProcessingStatus from './ParallelProcessingStatus';
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
  showWaveform = true,
  useOptimizedPreview = false,
  isSrtOnlyMode = false,
  onViewRules,
  userProvidedSubtitles = '',
  onUserSubtitlesAdd,
  onGenerateBackground,
  onRenderVideo,
  onActualVideoUrlChange
}) => {
  const { t } = useTranslation();
  const [currentTabIndex, setCurrentTabIndex] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [editedLyrics, setEditedLyrics] = useState(null);
  const [translatedSubtitles, setTranslatedSubtitles] = useState(null);
  const [seekTime, setSeekTime] = useState(null); // Track when seeking happens
  const [referenceAudio, setReferenceAudio] = useState(null); // Reference audio for narration

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

  const formatSubtitlesForLyricsDisplay = (subtitles) => {
    // If we have edited lyrics, use those instead of the original subtitles
    const sourceData = editedLyrics || subtitles;
    return sourceData?.map(sub => ({
      ...sub,
      startTime: sub.start,
      endTime: sub.end
    })) || [];
  };

  // Background Image Generator functionality moved back to AppLayout

  // When subtitles are loaded from cache, they should be considered as the source of truth
  // This ensures that saved edits are properly loaded when the page is reloaded

  // Download functionality moved to LyricsDisplay component

  // Set video source when a video is selected or file is uploaded
  const [videoSource, setVideoSource] = useState('');
  const [actualVideoUrl, setActualVideoUrl] = useState('');
  useEffect(() => {
    // Reset the actual video URL when the source changes
    setActualVideoUrl('');

    // First check for uploaded file
    const uploadedFileUrl = localStorage.getItem('current_file_url');
    if (uploadedFileUrl) {
      setVideoSource(uploadedFileUrl);
      return;
    }

    // Then check for YouTube video
    if (selectedVideo?.url) {
      // Store the selected video URL in localStorage to maintain state
      if (selectedVideo.source === 'youtube' || selectedVideo.source === 'douyin' || selectedVideo.source === 'all-sites') {
        localStorage.setItem('current_video_url', selectedVideo.url);
      }
      setVideoSource(selectedVideo.url);
      return;
    }

    // Check if we have a video URL in localStorage but no selectedVideo object
    const videoUrl = localStorage.getItem('current_video_url');
    if (videoUrl && !selectedVideo) {
      setVideoSource(videoUrl);
      return;
    }

    // Clear video source if nothing is selected
    setVideoSource('');
  }, [selectedVideo, uploadedFile]);

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

  // Background Image Generator functionality moved back to AppLayout

  // Don't render anything if there's no content to show
  if (!status?.message && !subtitlesData) {
    return null;
  }

  return (
    <div className="output-container">
      {/* Add Subtitles Button removed - now only in buttons-container */}

      {/* Show status message or segments status - Combined logic to avoid duplicate rendering */}
      {segmentsStatus.length > 0 && (subtitlesData || !activeTab.includes('youtube')) ? (
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
      ) : (
        status?.message && (
          <div className={`status ${status.type}`}>
            {/* Translate common status messages that might be hardcoded */}
            {typeof status.message === 'string' ? (
              status.message.includes('cache') ? t('output.subtitlesLoadedFromCache', 'Subtitles loaded from cache!') :
              status.message.includes('Video segments ready') ? t('output.segmentsReady', 'Video segments are ready for processing!') :
              status.message
            ) : 'Processing...'}
          </div>
        )
      )}

      {subtitlesData && (
        <>
          <div className="preview-section">
            {!isSrtOnlyMode && (
              <VideoPreview
                currentTime={currentTabIndex}
                setCurrentTime={setCurrentTabIndex}
                videoSource={videoSource}
                setDuration={setVideoDuration}
                onSeek={handleVideoSeek}
                translatedSubtitles={translatedSubtitles}
                subtitlesArray={editedLyrics || subtitlesData}
                onVideoUrlReady={setActualVideoUrl}
                useOptimizedPreview={useOptimizedPreview}
                onReferenceAudioChange={setReferenceAudio}
                onRenderVideo={onRenderVideo}
              />
            )}

            {isSrtOnlyMode && (
              <div className="srt-only-message">
                <div className="info-icon">
                  <svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" strokeWidth="2" fill="none">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                  </svg>
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
              showWaveform={showWaveform}
              translatedSubtitles={translatedSubtitles}
              videoTitle={selectedVideo?.title || uploadedFile?.name?.replace(/\.[^/.]+$/, '') || 'subtitles'}
            />

            {/* Download buttons moved to LyricsDisplay component */}
          </div>

          {/* Translation Section */}
          <>
            <TranslationSection
              subtitles={editedLyrics || subtitlesData}
              videoTitle={selectedVideo?.title || uploadedFile?.name?.replace(/\.[^/.]+$/, '') || 'subtitles'}
              onTranslationComplete={setTranslatedSubtitles}
            />
          </>

          {/* Unified Narration Section - Now separate from Translation */}
          <>
            <UnifiedNarrationSection
              subtitles={translatedSubtitles || editedLyrics || subtitlesData}
              originalSubtitles={editedLyrics || subtitlesData}
              translatedSubtitles={translatedSubtitles}
              referenceAudio={referenceAudio}
              videoPath={actualVideoUrl}
              onReferenceAudioChange={setReferenceAudio}
            />
          </>

          {/* Background Image Generator moved back to AppLayout */}
        </>
      )}
    </div>
  );
};

export default OutputContainer;