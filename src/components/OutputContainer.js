import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../styles/OutputContainer.css';
import '../styles/narration/unifiedNarrationRedesign.css';
import VideoPreview from './previews/VideoPreview';
import LyricsDisplay from './LyricsDisplay';
import TranslationSection from './translation';
import { UnifiedNarrationSection } from './narration';
import ParallelProcessingStatus from './ParallelProcessingStatus';
import { hasValidDownloadedVideo } from '../utils/videoUtils';
import { useLyricsSave } from '../hooks/useLyricsSave';
import { isNativeMediaDescriptor } from '../platform/mediaService';
import { isDesktopRuntime } from '../platform/desktopRuntime';
// BackgroundImageGenerator moved back to AppLayout

const markSavedOutsideEditor = () => undefined;

const OutputContainer = ({
  status,
  statusEventId,
  subtitlesData,
  setSubtitlesData,
  selectedVideo,
  uploadedFile,
  isDownloading = false,
  segmentsStatus = [],
  activeTab,
  onRetrySegment,
  onRetryWithModel,
  onGenerateSegment,
  videoSegments = [],
  retryingSegments = [],
  timeFormat = 'seconds',
  useOptimizedPreview = false,
  isSrtOnlyMode = false,
  onViewRules,
  userProvidedSubtitles = '',
  onUserSubtitlesAdd: _onUserSubtitlesAdd,
  onGenerateBackground: _onGenerateBackground,
  onRenderVideo,
  onActualVideoUrlChange,
  onSegmentSelect = null, // Callback for segment selection
  selectedSegment = null, // Currently selected segment
  isUploading = false, // Whether video is currently uploading
  isProcessingSegment = false, // Whether a segment is being processed
  translatedSubtitles = null,
  onTranslatedSubtitlesChange = null,
}) => {
  const { t } = useTranslation();
  const [seekTime, setSeekTime] = useState(null); // Track when seeking happens
  const [lyricSeekRequest, setLyricSeekRequest] = useState(null);
  const lyricSeekGenerationRef = useRef(0);
  const [browserVideoSource, setBrowserVideoSource] = useState('');
  const [browserFileType, setBrowserFileType] = useState('');
  const nativeMedia = isNativeMediaDescriptor(uploadedFile) ? uploadedFile : null;
  // Native activation publishes an opaque playback capability as part of the media descriptor.
  // Derive it during render so project B can never render with project A's effect-synchronized URL.
  const videoSource = nativeMedia?.playbackUrl ?? browserVideoSource;
  const fileType = nativeMedia?.type ?? browserFileType;
  const [playheadState, setPlayheadState] = useState({ mediaKey: videoSource, time: 0 });
  const [durationState, setDurationState] = useState({ mediaKey: videoSource, value: 0 });
  const [actualVideoState, setActualVideoState] = useState({ mediaKey: videoSource, url: '' });
  const currentTabIndex = Object.is(playheadState.mediaKey, videoSource)
    ? playheadState.time
    : 0;
  const videoDuration = Object.is(durationState.mediaKey, videoSource)
    ? durationState.value
    : 0;
  const actualVideoUrl = Object.is(actualVideoState.mediaKey, videoSource)
    ? actualVideoState.url
    : '';
  const setCurrentTabIndex = useCallback((nextTime) => {
    setPlayheadState((current) => {
      const currentTime = Object.is(current.mediaKey, videoSource) ? current.time : 0;
      const resolvedTime = typeof nextTime === 'function' ? nextTime(currentTime) : nextTime;
      return { mediaKey: videoSource, time: resolvedTime };
    });
  }, [videoSource]);
  const setVideoDuration = useCallback((nextDuration) => {
    setDurationState((current) => {
      const currentDuration = Object.is(current.mediaKey, videoSource) ? current.value : 0;
      const resolvedDuration = typeof nextDuration === 'function'
        ? nextDuration(currentDuration)
        : nextDuration;
      return { mediaKey: videoSource, value: resolvedDuration };
    });
  }, [videoSource]);
  const setActualVideoUrl = useCallback((nextUrl) => {
    setActualVideoState((current) => {
      const currentUrl = Object.is(current.mediaKey, videoSource) ? current.url : '';
      const resolvedUrl = typeof nextUrl === 'function' ? nextUrl(currentUrl) : nextUrl;
      return { mediaKey: videoSource, url: resolvedUrl };
    });
  }, [videoSource]);
  const [referenceAudio, setReferenceAudio] = useState(null); // Reference audio for narration
  const consumedStatusEventRef = useRef({ hasValue: false, identity: undefined });

  const handleLyricClick = (time) => {
    // SRT-only mode has no media transport to acknowledge a command; preserve its local selection
    // behavior without pretending that a video seek occurred.
    if (isSrtOnlyMode) {
      setCurrentTabIndex(time);
      return;
    }
    lyricSeekGenerationRef.current += 1;
    setLyricSeekRequest({
      generation: lyricSeekGenerationRef.current,
      mediaKey: videoSource,
      time,
    });
  };

  const handleLyricSeekConsumed = useCallback((consumedRequest) => {
    if (!Number.isSafeInteger(consumedRequest?.generation)) return;
    if (typeof consumedRequest.mediaKey !== 'string') return;
    setLyricSeekRequest((current) => (
      current?.generation === consumedRequest.generation
        && Object.is(current.mediaKey, consumedRequest.mediaKey)
        ? null
        : current
    ));
  }, []);

  const handleVideoSeek = (time) => {
    // Set the seek time to trigger timeline centering
    setSeekTime(time);

    // Reset the seek time in the next frame to allow future seeks
    requestAnimationFrame(() => {
      setSeekTime(null);
    });
  };

  const handleUpdateLyrics = (updatedLyrics) => {
    // The app-level subtitle track is the presentation authority as well as the native history
    // mirror. Keeping a second editedLyrics array here let an empty edit disappear upstream and
    // later generation merged against the stale downloaded track.
    setSubtitlesData?.(updatedLyrics);
  };

  // Handle saving subtitles
  const handleSaveSubtitles = (savedLyrics) => {
    setSubtitlesData?.(savedLyrics);
  };

  // This coordinator must remain mounted even when the output UI has no content yet. A fresh URL
  // starts automatic generation before LyricsDisplay is stagger-mounted, but its pre-run checkpoint
  // still has to settle (and remain cancellable) immediately.
  useLyricsSave({
    lyrics: subtitlesData ?? [],
    updateSavedLyrics: markSavedOutsideEditor,
    onSaveSubtitles: handleSaveSubtitles,
  });

  const displayLyrics = useMemo(() => subtitlesData?.map(sub => ({
      ...sub,
      startTime: sub.start,
      endTime: sub.end
    })) || [], [subtitlesData]);


  // Background Image Generator functionality moved back to AppLayout

  // When subtitles are loaded from cache, they should be considered as the source of truth
  // This ensures that saved edits are properly loaded when the page is reloaded

  // Download functionality moved to LyricsDisplay component

  // Set video source when a video is selected or file is uploaded
  const activeVideoTitle = nativeMedia
    ? uploadedFile.name.replace(/\.[^/.]+$/, '')
    : selectedVideo?.title || uploadedFile?.name?.replace(/\.[^/.]+$/, '') || 'subtitles';
  useEffect(() => {
    setBrowserFileType('');

    if (isNativeMediaDescriptor(uploadedFile)) {
      setBrowserVideoSource('');
      return undefined;
    }

    // The browser build has no native playback host. A browser File gets an object URL owned by
    // this effect and revoked on replacement; it is never persisted or reused as identity.
    if (!isDesktopRuntime() && uploadedFile instanceof File) {
      const objectUrl = URL.createObjectURL(uploadedFile);
      setBrowserVideoSource(objectUrl);
      setBrowserFileType(uploadedFile.type || '');
      return () => URL.revokeObjectURL(objectUrl);
    }

    if (!isDesktopRuntime() && selectedVideo?.url) {
      // Special case: If we're in SRT-only mode, don't set videoSource
      if (isSrtOnlyMode) {
        setBrowserVideoSource('');
        setBrowserFileType('');
        return;
      }

      setBrowserVideoSource(selectedVideo.url);
      // For YouTube/Douyin URLs, assume video
      setBrowserFileType('video/mp4');
      return undefined;
    }

    // Clear video source if nothing is selected
    setBrowserVideoSource('');
    setBrowserFileType('');
    return undefined;
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
  }, [isSrtOnlyMode, setVideoDuration, subtitlesData]);

  // Show status messages as toasts instead of inline
  useEffect(() => {
    // Production supplies the monotonic publication ID. Falling back to object identity keeps this
    // component usable in isolation without turning translation/unrelated rerenders into new events.
    const eventIdentity = statusEventId ?? status;
    if (consumedStatusEventRef.current.hasValue
      && Object.is(consumedStatusEventRef.current.identity, eventIdentity)) {
      return;
    }
    consumedStatusEventRef.current = { hasValue: true, identity: eventIdentity };

    if (status?.message) {
      const message = typeof status.message === 'string' ? (
        status.message.includes('cache') ? t('output.subtitlesLoadedFromCache', 'Subtitles loaded from cache!') :
        status.message.includes('Video segments ready') ? t('output.segmentsReady', 'Video segments are ready for processing!') :
        status.message
      ) : 'Processing...';

      // ToastPanel is the single onboarding policy owner. In particular it keeps warnings, errors
      // and actionable notices visible; filtering here used to consume a first-run failure before
      // that policy could ever see it or replay it after onboarding.
      const toastType = status.type || 'info';
      if (toastType === 'error' || toastType === 'warning') {
        // Each failure is an occurrence, not the current value of one progress slot. A stable key
        // would replace the live toast and its history record, erasing an earlier failure when two
        // operations finish close together.
        window.addToast(message, toastType, 5000);
      } else {
        window.addToast(message, toastType, 5000, 'output-status');
      }
    } else {
      window.removeToastByKey && window.removeToastByKey('output-status');
    }
  }, [status, statusEventId, t]);

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
          {!isDownloading && (
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
                seekRequest={lyricSeekRequest}
                onSeekRequestConsumed={handleLyricSeekConsumed}
                translatedSubtitles={translatedSubtitles}
                subtitlesArray={subtitlesData}
                onVideoUrlReady={setActualVideoUrl}
                useOptimizedPreview={useOptimizedPreview}
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
              key={videoSource || 'no-video-source'}
              matchedLyrics={displayLyrics}
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
              videoTitle={activeVideoTitle}
              onSegmentSelect={onSegmentSelect}
              selectedSegment={selectedSegment}
              isProcessingSegment={isProcessingSegment}
            />

            {/* Download buttons moved to LyricsDisplay component */}
            </div>
          )}

          {/* Translation Section */}
          {!isDownloading && (
            <TranslationSection
              subtitles={subtitlesData}
              videoTitle={activeVideoTitle}
              onTranslationComplete={onTranslatedSubtitlesChange}
            />
          )}

          {/* Unified Narration Section - Now separate from Translation */}
          {!isDownloading && (
            <UnifiedNarrationSection
              subtitles={translatedSubtitles || subtitlesData}
              originalSubtitles={subtitlesData}
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
