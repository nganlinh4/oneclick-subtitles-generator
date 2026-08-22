import { useEffect, useMemo, useRef, useState } from 'react';
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
import useNarrationRefreshEvents from './useNarrationRefreshEvents';
import useVideoUiSync from './useVideoUiSync';
import CanvasVideoPreview from './canvas/CanvasVideoPreview';
import { selectPreviewCue } from './native/nativePreviewScene';
import useNativePreviewToast from './native/useNativePreviewToast';
import {
  EDITOR_PREVIEW_RESOLUTION,
  createDownloadWithSubtitlesHandler,
  createDownloadWithTranslatedSubtitlesHandler,
  previewCustomizationForNativeRender,
  translatedSubtitlesForRender,
} from './videoDownloadHandlers';
// Narration settings now integrated into the translation section
import '../../styles/VideoPreview.css';
import '../../styles/narration/index.css';
import { SERVER_URL } from '../../config';
import useVideoSeekControls from '../../hooks/useVideoSeekControls';
import { DEFAULT_SUBTITLE_FONT_FAMILY } from '../../services/fontCapability';

const VideoPreview = ({ currentTime, setCurrentTime, setDuration, videoSource, fileType, onSeek, translatedSubtitles, subtitlesArray, onVideoUrlReady, onReferenceAudioChange: _onReferenceAudioChange, onRenderVideo }) => {
  const { t } = useTranslation();
  const videoRef = useRef(null);
  const videoContainerRef = useRef(null); // Ref for the main video container
  const lastBlobUrlRef = useRef(null);

  const handleSeek = (direction) => {
    setSeekDirection(direction);
    setShowSeekIndicator(true);
    setTimeout(() => setShowSeekIndicator(false), 1000);
  };

  useVideoSeekControls(videoRef, handleSeek);

  const seekLockRef = useRef(false);
  const lastTimeUpdateRef = useRef(0); // Track last time update to throttle updates
  const lastPlayStateRef = useRef(false); // Track last play state to avoid redundant updates
  const lastTouchTimeRef = useRef(0);
  const hideControlsTimeoutRef = useRef(null);
  const [isAudioDownloading, setIsAudioDownloading] = useState(false);
  const [isRenderingVideo, setIsRenderingVideo] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
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

  // Volume-from-narration-menu sync + compact-mode detection.
  useVideoUiSync({ videoRef, isMuted, setVolume, setIsMuted, setIsCompactMode });

  const [subtitleSettings, setSubtitleSettings] = useState(() => {
    // Try to load settings from localStorage
    const savedSettings = localStorage.getItem('subtitle_settings');
    if (savedSettings) {
      try {
        return JSON.parse(savedSettings);
      } catch (e) {
        console.error('Error parsing saved subtitle settings:', e);
      }
    }

    // Default settings if nothing is saved
    return {
      fontFamily: DEFAULT_SUBTITLE_FONT_FAMILY,
      fontSize: '24',
      fontWeight: '500',
      position: '90', // Now a percentage value from 0 (top) to 100 (bottom)
      boxWidth: '80',
      backgroundColor: '#000000',
      opacity: '0.4',
      textColor: '#ffffff',
      showTranslatedSubtitles: false,
      backgroundRadius: '16',
      textShadow: true,
      fontVariationSettings: '"ROND" 100'
    };
  });
  // We track play state in lastPlayStateRef instead of using state to avoid unnecessary re-renders

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
    seekLockRef,
    lastPlayStateRef,
    lastTimeUpdateRef,
    videoDuration,
    currentTime,
    isLoaded,
    setCurrentTime,
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
    isDragging,
    isLoaded,
    isFullscreen,
    handleFullscreenExit,
    setCurrentTime,
    setDuration,
    setVideoDuration,
    setVolume,
    setIsMuted,
    setShowCustomControls,
    setControlsVisible,
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
    isPlaying,
    setIsPlaying,
  });

  // Native <video> element events: metadata/error/timeupdate (the playhead) +
  // seeking/seeked + play-state ref tracking. It resolves no cue and draws nothing.
  useVideoElementEvents({
    videoRef,
    videoUrl,
    t,
    setError,
    setIsLoaded,
    setDuration,
    setCurrentTime,
    seekLockRef,
    lastTimeUpdateRef,
    lastPlayStateRef,
    isDragging,
    onSeek,
  });

  // Aligned-narration event wiring + audio cleanup on unmount.
  useNarrationRefreshEvents({ isRefreshingNarration, setIsRefreshingNarration });

  // Let the timeline's "Pull subtitles to narration" trigger the SAME narration refresh as the
  // top-left button. Wired here (VideoPreview is always mounted) rather than in the buttons, which
  // unmount when the controls aren't hovered.
  useEffect(() => {
    const onRequest = () => narrationRefreshHandler({ videoRef, setIsRefreshingNarration, t });
    window.addEventListener('request-narration-refresh', onRequest);
    return () => window.removeEventListener('request-narration-refresh', onRequest);
  }, [t]);

  // The 54-field customization the native compositor draws from, mapped by the SAME bridge the
  // download handler uses. There is deliberately no second mapping: if the preview and the file it
  // downloads disagreed about a style, the mapping would be the only place they could.
  const nativeCustomization = useMemo(
    () => previewCustomizationForNativeRender(subtitleSettings),
    [subtitleSettings]
  );

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
    const showTranslated = subtitleSettings.showTranslatedSubtitles
      && Array.isArray(translatedSubtitles)
      && translatedSubtitles.length > 0;
    return showTranslated
      ? translatedSubtitlesForRender(translatedSubtitles, subtitlesArray)
      : subtitlesArray;
  }, [subtitleSettings.showTranslatedSubtitles, translatedSubtitles, subtitlesArray]);

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

  const subtitlePreviewDormant = previewIdle && previewHasCues && cueCoversNow;

  useNativePreviewToast({
    error: canvasPreviewState.code === null ? null : { code: canvasPreviewState.code },
    dormant: subtitlePreviewDormant,
    onRetry: null,
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
    if (canvasPreviewState.code !== null) return 'refused';
    if (!isLoaded || isVideoLoading) return 'source-loading';
    // Asked before the frame's own status, because "this project has no subtitles" is true whether
    // or not a source frame has been drawn, and it is the more useful thing to say.
    if (!previewHasCues) return 'empty';
    if (canvasPreviewState.status === 'ready') return 'ready';
    if (canvasPreviewState.status === 'pending') return 'pending';
    if (canvasPreviewState.status === 'outside-trim') return 'outside-trim';
    if (!cueCoversNow) return 'between-cues';
    return 'dormant';
  })();

  // Handle downloading video with subtitles
  const handleDownloadWithSubtitles = createDownloadWithSubtitlesHandler({
    videoUrl,
    subtitlesArray,
    subtitleSettings,
    videoSource,
    t,
    setError,
    setIsRenderingVideo,
    setRenderProgress,
  });

  // Handle downloading video with translated subtitles
  const handleDownloadWithTranslatedSubtitles = createDownloadWithTranslatedSubtitlesHandler({
    videoUrl,
    subtitlesArray,
    translatedSubtitles,
    subtitleSettings,
    videoSource,
    t,
    setError,
    setIsRenderingVideo,
    setRenderProgress,
  });

  return (
    <div className="video-preview">
      {/* CSS Animation for spinner and hide native controls */}
      <VideoPlayerStyles />

      {/* Narration Settings moved to unified component in translation section */}

      <div className="video-preview-header">
        <h3>{t('output.videoPreview', 'Video Preview with Subtitles')}</h3>
        <SubtitleSettings
          settings={subtitleSettings}
          onSettingsChange={setSubtitleSettings}
          onDownloadWithSubtitles={handleDownloadWithSubtitles}
          onDownloadWithTranslatedSubtitles={handleDownloadWithTranslatedSubtitles}
          hasTranslation={translatedSubtitles && translatedSubtitles.length > 0}
          translatedSubtitles={translatedSubtitles}
          targetLanguage={translatedSubtitles && translatedSubtitles.length > 0 && translatedSubtitles[0].language}
          videoRef={videoRef}
          originalNarrations={window.originalNarrations || (() => {
            try {
              const stored = localStorage.getItem('originalNarrations');
              return stored ? JSON.parse(stored) : [];
            } catch (e) {
              console.error('Error parsing originalNarrations from localStorage:', e);
              return [];
            }
          })()}
          translatedNarrations={window.translatedNarrations || (() => {
            try {
              const stored = localStorage.getItem('translatedNarrations');
              return stored ? JSON.parse(stored) : [];
            } catch (e) {
              console.error('Error parsing translatedNarrations from localStorage:', e);
              return [];
            }
          })()}
          {...(() => {
            // Store subtitles data in window for access by other components
            if (subtitlesArray && subtitlesArray.length > 0) {
              window.subtitlesData = subtitlesArray;
              // Only log in development mode
              if (process.env.NODE_ENV === 'development' && !window._loggedSubtitlesData) {

                window._loggedSubtitlesData = true;
              }
            }
            // Store original subtitles (same as subtitlesArray in this context)
            if (subtitlesArray && subtitlesArray.length > 0) {
              window.originalSubtitles = subtitlesArray;
              // Only log in development mode
              if (process.env.NODE_ENV === 'development' && !window._loggedOriginalSubtitles) {

                window._loggedOriginalSubtitles = true;
              }
            }
            // Store translated subtitles if available
            if (translatedSubtitles && translatedSubtitles.length > 0) {
              window.translatedSubtitles = translatedSubtitles;
              // Only log in development mode
              if (process.env.NODE_ENV === 'development' && !window._loggedTranslatedSubtitles) {

                window._loggedTranslatedSubtitles = true;
              }
            }
            return {};
          })()}
          getAudioUrl={(filename) => `${SERVER_URL}/narration/audio/${filename || 'test.wav'}`}
          onRenderVideo={onRenderVideo}
          volume={volume}
          setVolume={setVolume}
        />
      </div>

      {isRenderingVideo && (
        <div className="rendering-overlay">
          <div className="rendering-progress">
            <div className="progress-bar" style={{ width: `${renderProgress * 100}%` }}></div>
          </div>
          <div className="rendering-text">
            {t('videoPreview.rendering', 'Rendering video with subtitles...')} ({Math.round(renderProgress * 100)}%)
          </div>
        </div>
      )}

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
                />

                <VideoPlayerElement
                  videoRef={videoRef}
                  lastTouchTimeRef={lastTouchTimeRef}
                  isPlaying={isPlaying}
                  setIsPlaying={setIsPlaying}
                  handleSeek={handleSeek}
                  useOptimizedPreview={useOptimizedPreview}
                  optimizedVideoUrl={optimizedVideoUrl}
                  videoUrl={videoUrl}
                  t={t}
                />

                <CanvasVideoPreview
                  videoRef={videoRef}
                  sourceKey={videoUrl}
                  playing={isPlaying}
                  currentTime={isDragging ? dragTime : currentTime}
                  customization={nativeCustomization}
                  subtitles={previewSubtitles}
                  resolution={EDITOR_PREVIEW_RESOLUTION}
                  onStateChange={setCanvasPreviewState}
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
                  setIsPlaying={setIsPlaying}
                  videoRef={videoRef}
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
