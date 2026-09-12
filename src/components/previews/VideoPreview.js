import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import LoadingIndicator from '../common/LoadingIndicator';
import '../../styles/common/material-switch.css';
import SubtitleSettings from '../SubtitleSettings';
import VideoTopsideButtons from './VideoTopsideButtons';
import { narrationRefreshHandler } from './narrationRefreshHandler';
import VideoBottomControls from './VideoBottomControls';
import SeekIndicator from './SeekIndicator';
import VideoPlayerStyles from './VideoPlayerStyles';
import VideoPlayerElement from './VideoPlayerElement';
import useVideoControls from './useVideoControls';
import useFullscreenSubtitles from './useFullscreenSubtitles';
import useVideoSeek from './useVideoSeek';
import useVideoSourceLoading from './useVideoSourceLoading';
import useVideoSourceSwitching from './useVideoSourceSwitching';
import useVideoElementEvents from './useVideoElementEvents';
import useVideoSeekCoordinator from './useVideoSeekCoordinator';
import useNarrationRefreshEvents from './useNarrationRefreshEvents';
import useVideoUiSync from './useVideoUiSync';
import CanvasVideoPreview from './canvas/CanvasVideoPreview';
import { selectPreviewCue } from './native/nativePreviewScene';
import useNativePreviewToast from './native/useNativePreviewToast';
import { EDITOR_PREVIEW_RESOLUTION, translatedSubtitlesForRender } from './previewCueSelection';
import {
  applyPreviewSettingsToProjectScene,
  previewSettingsFromProjectScene,
} from './projectPreviewSettings';
// Narration settings now integrated into the translation section
import '../../styles/VideoPreview.css';
import '../../styles/narration/index.css';
import { useProjectNarrationState } from '../../platform/projectNarrationState';
import { useProjectRenderScene } from '../../platform/projectRenderScene';
import { defaultCustomization } from '../subtitleCustomization/defaultCustomization';

export const admittedPlaybackSourceUrl = (committedSource, requestedUrl) => (
  committedSource !== null
  && Object.is(committedSource.requestedUrl, requestedUrl)
    ? committedSource.actualUrl
    : null
);

const VideoPreview = ({ currentTime, setCurrentTime, setDuration, videoSource, fileType, onSeek, seekRequest = null, onSeekRequestConsumed = null, translatedSubtitles, subtitlesArray, onVideoUrlReady, onReferenceAudioChange: _onReferenceAudioChange, onRenderVideo }) => {
  const { t } = useTranslation();
  const narrationState = useProjectNarrationState();
  const {
    status: renderSceneStatus,
    scene: projectRenderScene,
    updateScene: updateProjectRenderScene,
  } = useProjectRenderScene();
  const videoRef = useRef(null);
  const videoContainerRef = useRef(null); // Ref for the main video container
  const lastBlobUrlRef = useRef(null);

  const handleSeek = (direction) => {
    setSeekDirection(direction);
    setShowSeekIndicator(true);
    setTimeout(() => setShowSeekIndicator(false), 1000);
  };

  const lastTouchTimeRef = useRef(0);
  const hideControlsTimeoutRef = useRef(null);
  const [isAudioDownloading, setIsAudioDownloading] = useState(false);
  const [isRefreshingNarration, setIsRefreshingNarration] = useState(false); // Track narration refresh state
  const [isVideoHovered, setIsVideoHovered] = useState(false); // Track video hover state for showing controls

  // Source/download lifecycle (URL resolution, optimized version, YouTube poll).
  const {
    videoUrl,
    optimizedVideoUrl,
    isLoaded,
    setIsLoaded,
    error,
    setError,
    isDownloading,
    downloadProgress,
    useOptimizedPreview,
  } = useVideoSourceLoading({ videoSource, t });

  // Custom video control state that is shared across the extracted hooks/render.
  // (Hook-owned playback state lives in useVideoControls / useVideoSeek below.)
  const [videoDuration, setVideoDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [showCustomControls, setShowCustomControls] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(false);
  // Native track subtitles disabled - using only custom subtitle display
  const [showSeekIndicator, setShowSeekIndicator] = useState(false);
  const [seekDirection, setSeekDirection] = useState('');
  const [isCompactMode, setIsCompactMode] = useState(false);
  const [canvasPreviewState, setCanvasPreviewState] = useState({ status: 'idle', code: null });
  const [canvasPreviewRetryToken, setCanvasPreviewRetryToken] = useState(0);

  // Volume-from-narration-menu sync + compact-mode detection.
  useVideoUiSync({ videoRef, isMuted, setVolume, setIsMuted, setIsCompactMode });

  const requestedVideoSourceUrl = useOptimizedPreview && optimizedVideoUrl
    ? optimizedVideoUrl
    : videoUrl;
  const [committedPlaybackSource, setCommittedPlaybackSource] = useState(null);
  const handlePlaybackSourceChange = useCallback((nextSource) => {
    setCommittedPlaybackSource((previous) => (
      previous !== null
      && Object.is(previous.actualUrl, nextSource.actualUrl)
      && Object.is(previous.requestedUrl, nextSource.requestedUrl)
        ? previous
        : nextSource
    ));
  }, []);
  // A requested optimized URL and the URL actually committed can differ after automatic fallback.
  // During the render before the source owner commits a replacement, there is deliberately no
  // active source identity. Naming the requested URL here would let a child snapshot the outgoing
  // element's already-decoded pixels and label media A as media B. The layout-phase owner publishes
  // the actual URL after taking its transport snapshot and assigning the replacement.
  const activeVideoSourceUrl = admittedPlaybackSourceUrl(
    committedPlaybackSource,
    requestedVideoSourceUrl,
  );
  const { isSeeking, seekBy, seekTo } = useVideoSeekCoordinator({
    videoRef,
    sourceKey: activeVideoSourceUrl,
    setCurrentTime,
    onSeek,
  });
  const handledSeekRequestRef = useRef(null);
  useEffect(() => {
    if (seekRequest === null || typeof seekRequest !== 'object') return;
    if (!Number.isSafeInteger(seekRequest.generation) || !Number.isFinite(seekRequest.time)) return;
    if (typeof seekRequest.mediaKey !== 'string') return;
    if (handledSeekRequestRef.current === seekRequest.generation) return;

    // A command belongs to the logical media that was visible when the lyric was clicked. If the
    // preview was replaced before it could load, consume the obsolete command without applying it
    // to the new media. This identity is intentionally the parent video source, not an optimized
    // rendition URL that can change while the logical asset remains the same.
    if (!Object.is(seekRequest.mediaKey, videoSource)) {
      handledSeekRequestRef.current = seekRequest.generation;
      onSeekRequestConsumed?.(seekRequest);
      return;
    }
    // `isLoaded` belongs to the previous render until useVideoSourceLoading's source-change effect
    // commits. Requiring its source-tagged URL closes the effect-order window where a new command
    // could otherwise seek the outgoing media element.
    if (!isLoaded || !Object.is(videoUrl, videoSource) || videoRef.current === null) return;

    const coordinatorGeneration = seekTo(seekRequest.time, { reason: 'lyric-request' });
    // A loaded element can still reject currentTime assignment after a transport failure. Retain
    // the source-bound command for a later successful load instead of acknowledging data loss.
    if (!Number.isSafeInteger(coordinatorGeneration)) return;
    handledSeekRequestRef.current = seekRequest.generation;
    onSeekRequestConsumed?.(seekRequest);
  }, [isLoaded, onSeekRequestConsumed, seekRequest, seekTo, videoSource, videoUrl]);

  // The main editor and Render tab are two views of this one project-owned scene. The browser-era
  // `subtitle_settings` localStorage record is deliberately not read or mirrored here: it had no
  // project identity, so project B could inherit project A's style while export used a different
  // SQLite scene. A loading scene shows the canonical defaults for a few milliseconds; updates made
  // during loading are queued by the authority and applied to the loaded scene before publication.
  const subtitleSettings = useMemo(
    () => previewSettingsFromProjectScene(projectRenderScene),
    [projectRenderScene],
  );
  const handleSubtitleSettingsChange = useCallback((nextSettings) => {
    try {
      updateProjectRenderScene((previous) => (
        applyPreviewSettingsToProjectScene(previous, nextSettings)
      ));
    } catch (error) {
      window.addToast?.(
        error?.message || t('videoPreview.projectStyleUnavailable', 'Add a video before styling subtitles.'),
        'error',
        8000,
        'project-subtitle-style',
      );
    }
  }, [t, updateProjectRenderScene]);
  const resetSubtitleSettings = useCallback(() => {
    try {
      updateProjectRenderScene((previous) => ({
        ...previous,
        selectedSubtitles: 'original',
        customization: { ...defaultCustomization },
      }));
    } catch (error) {
      window.addToast?.(
        error?.message || t('videoPreview.projectStyleUnavailable', 'Add a video before styling subtitles.'),
        'error',
        8000,
        'project-subtitle-style',
      );
    }
  }, [t, updateProjectRenderScene]);
  // Timeline/volume seek-drag + external seek (owns drag + volume-slider state)
  const {
    isDragging,
    setIsDragging,
    dragTime,
    setDragTime,
    dragTimeRef,
    isVolumeSliderVisible,
    setIsVolumeSliderVisible,
    isVolumeDragging,
    setIsVolumeDragging,
    handleTimelineMouseDown,
    handleTimelineTouchStart,
  } = useVideoSeek({
    videoRef,
    videoDuration,
    sourceKey: activeVideoSourceUrl,
    seekTo,
    setVolume,
    setIsMuted,
  });

  // Fullscreen change/exit (owns isFullscreen)
  const { isFullscreen, setIsFullscreen, handleFullscreenExit } = useFullscreenSubtitles({
    videoRef,
    videoContainerRef,
    setControlsVisible,
    setShowCustomControls,
    setIsVideoHovered,
  });

  // Playback controls: video-element handlers, keyboard shortcuts, fullscreen auto-hide
  const {
    isPlaying,
    setIsPlaying,
    playbackSpeed,
    setPlaybackSpeed,
    isSpeedMenuVisible,
    setIsSpeedMenuVisible,
    bufferedProgress,
    isBuffering,
    isVideoLoading,
  } = useVideoControls({
    videoRef,
    videoContainerRef,
    hideControlsTimeoutRef,
    videoUrl,
    videoDuration,
    isLoaded,
    isFullscreen,
    handleFullscreenExit,
    setDuration,
    setVideoDuration,
    setVolume,
    setIsMuted,
    setShowCustomControls,
    setControlsVisible,
    onDirectionalSeek: handleSeek,
    seekBy,
  });

  // Notify parent of the player URL + blob-mirror it, and hot-swap the <video>
  // src on optimized/original change while preserving playback state.
  useVideoSourceSwitching({
    videoRef,
    lastBlobUrlRef,
    videoUrl,
    optimizedVideoUrl,
    useOptimizedPreview,
    onVideoUrlReady,
    onPlaybackSourceChange: handlePlaybackSourceChange,
    setIsPlaying,
    seekTo,
  });

  // Native <video> metadata/error + play-state events. Transport time and seek completion belong
  // exclusively to useVideoSeekCoordinator, so no second listener can publish an older generation.
  useVideoElementEvents({
    videoRef,
    videoUrl,
    t,
    setError,
    setIsLoaded,
    setDuration,
  });

  // Aligned-narration event wiring + audio cleanup on unmount.
  useNarrationRefreshEvents({ isRefreshingNarration, setIsRefreshingNarration });

  // The native canvas and final export consume the exact same frozen scene object. No conversion is
  // allowed on this path: a conversion would be another place for a field or default to drift.
  const sceneAdmitted = renderSceneStatus === 'ready' && projectRenderScene !== null;
  const nativeCustomization = sceneAdmitted ? projectRenderScene.customization : null;

  // WHICH cue list the compositor draws, decided the way the download decides it.
  //
  // This used to be a real defect rather than a subtlety: the preview was fed `subtitlesArray`
  // unconditionally while the CSS overlay picked the translation, so with "show translated
  // subtitles" on the two layers of the same surface showed different words. Deleting the overlay
  // without moving the choice here would have silently dropped the translated preview entirely.
  //
  // The re-timing is the download handler's, from the download handler's own function: a translation
  // is composed on the ORIGINAL cue's timing, so the frame the user judges is composed from exactly
  // the cue list the file would be written from.
  const previewSubtitles = useMemo(() => {
    if (!subtitleSettings.showTranslatedSubtitles) return subtitlesArray;
    return Array.isArray(translatedSubtitles) && translatedSubtitles.length > 0
      ? translatedSubtitlesForRender(translatedSubtitles, subtitlesArray)
      : [];
  }, [subtitleSettings.showTranslatedSubtitles, translatedSubtitles, subtitlesArray]);

  // Narration alignment follows the same subtitle source the preview and export use. Grouped
  // narration is its own explicit cue plan; otherwise translated and original results are never
  // selected merely because one stale global happens to be non-empty.
  const usesGroupedNarration = narrationState.activeSource === 'grouped'
    && Array.isArray(narrationState.groupedCues)
    && narrationState.groupedCues.length > 0;
  const usesTranslatedNarration = !usesGroupedNarration
    && subtitleSettings.showTranslatedSubtitles
    && Array.isArray(translatedSubtitles)
    && translatedSubtitles.length > 0;
  const groupedNarrationCues = narrationState.groupedCues;
  const groupedNarrationResults = narrationState.resultsBySource.grouped;
  const translatedNarrationResults = narrationState.resultsBySource.translated;
  const originalNarrationResults = narrationState.resultsBySource.original;
  const narrationCuesForAlignment = useMemo(() => (
    usesGroupedNarration ? (groupedNarrationCues || []) : previewSubtitles
  ), [usesGroupedNarration, groupedNarrationCues, previewSubtitles]);
  const narrationResultsForAlignment = useMemo(() => {
    if (usesGroupedNarration) return groupedNarrationResults || [];
    if (usesTranslatedNarration) return translatedNarrationResults || [];
    return originalNarrationResults || [];
  }, [
    usesGroupedNarration,
    usesTranslatedNarration,
    groupedNarrationResults,
    translatedNarrationResults,
    originalNarrationResults,
  ]);

  // Let the timeline's request trigger the same strict refresh as the top-left button. The explicit
  // arrays keep this path tied to the frame the user is looking at.
  useEffect(() => {
    const onRequest = () => narrationRefreshHandler({
      videoRef,
      setIsRefreshingNarration,
      t,
      generationResults: narrationResultsForAlignment,
      currentCues: narrationCuesForAlignment,
    });
    window.addEventListener('request-narration-refresh', onRequest);
    return () => window.removeEventListener('request-narration-refresh', onRequest);
  }, [t, narrationResultsForAlignment, narrationCuesForAlignment]);

  // The preview is a persistent display-resolution canvas. It copies the decoded `<video>` frame
  // directly and paints the exact shaped line-mask atlas native export consumes. Playback therefore
  // performs no Rust frame render, PNG encode, IPC frame transfer, localhost fetch or image decode.
  const previewIdle = Boolean(videoUrl)
    && isLoaded
    && !isVideoLoading
    && canvasPreviewState.status === 'idle'
    && canvasPreviewState.code === null;

  // Three different facts used to arrive here as one sentence claiming the preview was unavailable.
  //
  //   * The project has NO CUES AT ALL. Nothing failed; there is nothing to draw yet. That is a
  //     ready state with an obvious next action, and calling it unavailable teaches a customer to
  //     ignore the notice that also reports real failures.
  //   * The project has cues but NONE COVERS THIS INSTANT. The bare source frame is the correct
  //     picture, exactly as it is between two subtitles in the finished video, so the honest thing
  //     to show is nothing at all.
  //   * Something a frame needs is genuinely missing. That is the only one worth a notice.
  // `previewSubtitles` is null until subtitles exist at all, which is exactly the state this block
  // was added to describe -- so it is checked rather than assumed to be an array.
  const previewCues = Array.isArray(previewSubtitles) ? previewSubtitles : [];
  const previewHasCues = previewCues.length > 0;
  const cueCoversNow = previewHasCues && selectPreviewCue(
    previewCues,
    isDragging ? dragTime : currentTime,
    {
      fadeInDuration: nativeCustomization?.fadeInDuration ?? 0,
      fadeOutDuration: nativeCustomization?.fadeOutDuration ?? 0,
    },
  ) !== null;

  const subtitlePreviewDormant = sceneAdmitted && previewHasCues && cueCoversNow && (
    previewIdle || canvasPreviewState.status === 'font-blocked'
  );

  useNativePreviewToast({
    error: !sceneAdmitted || canvasPreviewState.code === null
      ? null
      : { code: canvasPreviewState.code },
    dormant: subtitlePreviewDormant,
    fontBlocked: canvasPreviewState.status === 'font-blocked',
    onRetry: canvasPreviewState.retryable === true
      ? () => setCanvasPreviewRetryToken(token => token + 1)
      : null,
    t,
  });

  useEffect(() => {
    if (!error) {
      window.removeToastByKey?.('video-source-error');
      return;
    }
    window.addToast?.(error, 'error', 8000, 'video-source-error');
  }, [error]);

  /**
   * One bounded word for what the subtitle preview is doing, published on the surface itself.
   *
   * Not for styling and not for the customer: it is the smallest honest description of which
   * prerequisite the preview is waiting on, so a failure can name the edge that broke instead of
   * being narrowed by elimination. It carries no path, no cue text, no identifier — only a state
   * this file already computes.
   */
  const subtitlePreviewState = (() => {
    if (renderSceneStatus === 'preparing' || renderSceneStatus === 'repairing') {
      return renderSceneStatus;
    }
    if (canvasPreviewState.code !== null) return 'refused';
    if (!isLoaded || isVideoLoading) return 'source-loading';
    // Asked before the frame's own status, because "this project has no subtitles" is true whether
    // or not a source frame has been drawn, and it is the more useful thing to say.
    if (!previewHasCues) return 'empty';
    if (canvasPreviewState.status === 'ready') return 'ready';
    if (canvasPreviewState.status === 'pending') return 'pending';
    if (canvasPreviewState.status === 'font-blocked') return 'font-blocked';
    if (canvasPreviewState.status === 'outside-trim') return 'outside-trim';
    if (!cueCoversNow) return 'between-cues';
    return 'dormant';
  })();

  return (
    <div className="video-preview">
      {/* CSS Animation for spinner and hide native controls */}
      <VideoPlayerStyles />

      {/* Narration Settings moved to unified component in translation section */}

      <div className="video-preview-header">
        <h3>{t('output.videoPreview', 'Video Preview with Subtitles')}</h3>
        <SubtitleSettings
          settings={subtitleSettings}
          onSettingsChange={handleSubtitleSettingsChange}
          onResetSettings={resetSubtitleSettings}
          hasTranslation={translatedSubtitles && translatedSubtitles.length > 0}
          translatedSubtitles={translatedSubtitles}
          targetLanguage={translatedSubtitles && translatedSubtitles.length > 0 && translatedSubtitles[0].language}
          videoRef={videoRef}
          originalNarrations={originalNarrationResults}
          translatedNarrations={translatedNarrationResults}
          alignedNarrations={narrationResultsForAlignment}
          narrationCues={narrationCuesForAlignment}
          onRenderVideo={onRenderVideo}
          volume={volume}
          setVolume={setVolume}
        />
      </div>

      <div
        className="video-container"
        data-osg-preview={subtitlePreviewState}
        data-osg-preview-code={canvasPreviewState.code ?? ''}
      >
        {/* Only show downloading UI if we're actually downloading and have progress > 0 */}
        {isDownloading && downloadProgress > 0 && (
          <div className="video-downloading">
            <div className="download-progress">
              <div className="progress-bar" style={{ width: `${downloadProgress}%` }}></div>
            </div>
            <div className="download-text">
              {t('preview.downloading', 'Downloading video...')} ({downloadProgress}%)
            </div>
          </div>
        )}

        {/* Always show video player if we have a URL, regardless of download state */}
        {videoUrl ? (
          <div
            ref={videoContainerRef}
            className="native-video-container"
            onMouseEnter={() => !isFullscreen && setIsVideoHovered(true)}
            onMouseLeave={() => !isFullscreen && setIsVideoHovered(false)}
          >
              {/* Video quality toggle - only show when optimized video is available */}




              <div className="video-wrapper" style={{ position: 'relative' }}>
                {/* Topside buttons component */}
                <VideoTopsideButtons
                  showCustomControls={showCustomControls}
                  isFullscreen={isFullscreen}
                  controlsVisible={controlsVisible}
                  isVideoHovered={isVideoHovered}
                  isRefreshingNarration={isRefreshingNarration}
                  setIsRefreshingNarration={setIsRefreshingNarration}
                  isAudioDownloading={isAudioDownloading}
                  setIsAudioDownloading={setIsAudioDownloading}
                  setError={setError}
                  videoRef={videoRef}
                  videoSource={videoSource}
                  fileType={fileType}
                  useOptimizedPreview={useOptimizedPreview}
                  optimizedVideoUrl={optimizedVideoUrl}
                  videoUrl={videoUrl}
                  narrationResults={narrationResultsForAlignment}
                  narrationCues={narrationCuesForAlignment}
                />

                <VideoPlayerElement
                  videoRef={videoRef}
                  lastTouchTimeRef={lastTouchTimeRef}
                  handleSeek={handleSeek}
                  seekBy={seekBy}
                  t={t}
                />

                <CanvasVideoPreview
                  key={videoSource ?? 'no-logical-media'}
                  active={sceneAdmitted}
                  videoRef={videoRef}
                  sourceKey={activeVideoSourceUrl}
                  playing={isPlaying}
                  seeking={isSeeking}
                  currentTime={isDragging ? dragTime : currentTime}
                  frameRate={projectRenderScene?.renderSettings?.frameRate ?? 30}
                  customization={nativeCustomization}
                  subtitles={previewSubtitles}
                  resolution={EDITOR_PREVIEW_RESOLUTION}
                  onStateChange={setCanvasPreviewState}
                  retryToken={canvasPreviewRetryToken}
                />

                <SeekIndicator showSeekIndicator={showSeekIndicator} seekDirection={seekDirection} />

                {/* Loading/Buffering Spinner */}
                {(isVideoLoading || isBuffering) && (
                  <LoadingIndicator
                    theme="light"
                    showContainer={true}
                    size={60}
                    style={{
                      position: 'absolute',
                      top: '50%',
                      left: '50%',
                      transform: 'translate(-50%, -50%)',
                      zIndex: 15
                    }}
                  />
                )}

                {/* Bottom controls component */}
                <VideoBottomControls
                  showCustomControls={showCustomControls}
                  isFullscreen={isFullscreen}
                  controlsVisible={controlsVisible}
                  isVideoHovered={isVideoHovered}
                  isPlaying={isPlaying}
                  videoRef={videoRef}
                  frameRate={projectRenderScene?.renderSettings?.frameRate ?? 30}
                  currentTime={currentTime}
                  videoDuration={videoDuration}
                  isDragging={isDragging}
                  dragTime={dragTime}
                  setIsDragging={setIsDragging}
                  setDragTime={setDragTime}
                  dragTimeRef={dragTimeRef}
                  bufferedProgress={bufferedProgress}
                  handleTimelineMouseDown={handleTimelineMouseDown}
                  handleTimelineTouchStart={handleTimelineTouchStart}
                  seekTo={seekTo}
                  volume={volume}
                  setVolume={setVolume}
                  isMuted={isMuted}
                  setIsMuted={setIsMuted}
                  isVolumeSliderVisible={isVolumeSliderVisible}
                  setIsVolumeSliderVisible={setIsVolumeSliderVisible}
                  isVolumeDragging={isVolumeDragging}
                  setIsVolumeDragging={setIsVolumeDragging}
                  playbackSpeed={playbackSpeed}
                  setPlaybackSpeed={setPlaybackSpeed}
                  isSpeedMenuVisible={isSpeedMenuVisible}
                  setIsSpeedMenuVisible={setIsSpeedMenuVisible}
                  isCompactMode={isCompactMode}
                  handleFullscreenExit={handleFullscreenExit}
                  setIsFullscreen={setIsFullscreen}
                  setControlsVisible={setControlsVisible}
                  setIsVideoHovered={setIsVideoHovered}
                  hideControlsTimeoutRef={hideControlsTimeoutRef}
                  videoSource={videoSource}
                  fileType={fileType}
                />




                {/* Loading overlay for narration refresh */}
                {isRefreshingNarration && (
                  <div className="narration-refresh-overlay">
                    <div className="narration-refresh-content">
                      <LoadingIndicator
                        theme="light"
                        showContainer={false}
                        size={48}
                        className="narration-refresh-loading"
                      />
                      <div className="narration-refresh-text">
                        {t('preview.refreshingNarration', 'Refreshing narration...')}
                      </div>
                    </div>
                  </div>
                )}
              </div>

            </div>
          ) : null}

      </div>
    </div>
  );
};

export default VideoPreview;
