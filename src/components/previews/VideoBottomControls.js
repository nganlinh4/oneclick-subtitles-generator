import { useRef, useEffect } from 'react';
import LiquidGlass from '../common/LiquidGlass';
import PlayPauseMorphType4 from '../common/PlayPauseMorphType4';
import WavyProgressIndicator from '../common/WavyProgressIndicator';
import VolumeControlPill from './controls/VolumeControlPill';
import PlaybackSpeedMenu from './controls/PlaybackSpeedMenu';

const VideoBottomControls = ({
  showCustomControls,
  isFullscreen,
  controlsVisible,
  isVideoHovered,
  isPlaying,
  setIsPlaying,
  videoRef,
  currentTime,
  videoDuration,
  isDragging,
  dragTime,
  setIsDragging: _setIsDragging,
  setDragTime: _setDragTime,
  dragTimeRef: _dragTimeRef,
  bufferedProgress: _bufferedProgress,
  handleTimelineMouseDown,
  handleTimelineTouchStart,
  volume,
  setVolume,
  isMuted,
  setIsMuted,
  isVolumeSliderVisible,
  setIsVolumeSliderVisible,
  isVolumeDragging,
  setIsVolumeDragging,
  playbackSpeed,
  setPlaybackSpeed,
  isSpeedMenuVisible,
  setIsSpeedMenuVisible,
  isCompactMode,
  handleFullscreenExit,
  setIsFullscreen,
  setControlsVisible,
  setIsVideoHovered,
  hideControlsTimeoutRef,
  videoSource: _videoSource,
  fileType
}) => {
  const wavyProgressRef = useRef(null);

  // Check if the current file is audio
  const isAudioFile = fileType && fileType.startsWith('audio/');

  useEffect(() => {
    const applyFullscreenStyles = () => {
      const videoElement = document.querySelector('.native-video-container video');
      const videoWrapper = document.querySelector('.native-video-container .video-wrapper');
      const container = document.querySelector('.native-video-container');

      if (videoElement && videoWrapper && container) {
        container.style.setProperty('width', '100vw', 'important');
        container.style.setProperty('height', '100vh', 'important');
        container.style.setProperty('position', 'fixed', 'important');
        container.style.setProperty('top', '0', 'important');
        container.style.setProperty('left', '0', 'important');
        container.style.setProperty('z-index', '998', 'important');
        container.style.setProperty('background', 'black', 'important');
        videoWrapper.style.setProperty('width', '100vw', 'important');
        videoWrapper.style.setProperty('height', '100vh', 'important');
        videoWrapper.style.setProperty('position', 'relative', 'important');
        videoElement.style.setProperty('width', '100vw', 'important');
        videoElement.style.setProperty('height', '100vh', 'important');
        videoElement.style.setProperty('object-fit', 'contain', 'important');
        videoElement.style.setProperty('position', 'fixed', 'important');
        videoElement.style.setProperty('top', '0', 'important');
        videoElement.style.setProperty('left', '0', 'important');
        videoElement.style.setProperty('z-index', '1', 'important');
        videoElement.style.setProperty('max-width', 'none', 'important');
        videoElement.style.setProperty('max-height', 'none', 'important');
        videoElement.style.setProperty('min-width', '100vw', 'important');
        videoElement.style.setProperty('min-height', '100vh', 'important');
      }
    };

    const handleFullscreenChange = () => {
      const isCurrentlyFullscreen = !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
      );

      setIsFullscreen(isCurrentlyFullscreen);

      if (isCurrentlyFullscreen) {
        applyFullscreenStyles();
        setControlsVisible(true);
        setIsVideoHovered(false);

        if (hideControlsTimeoutRef.current) {
          clearTimeout(hideControlsTimeoutRef.current);
        }
        if (isPlaying) {
          hideControlsTimeoutRef.current = setTimeout(() => {
            setControlsVisible(false);
            const container = document.querySelector('.native-video-container');
            if (container) container.style.cursor = 'none';
          }, 3000);
        }
      } else {
        handleFullscreenExit();
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('msfullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('msfullscreenchange', handleFullscreenChange);
    };
  }, [
    isPlaying,
    setIsFullscreen,
    setControlsVisible,
    setIsVideoHovered,
    hideControlsTimeoutRef,
    handleFullscreenExit
  ]);

  if (!showCustomControls) return null;

  return (
    <>
      <style dangerouslySetInnerHTML={{
        __html: `
          .expanding-volume-slider-container .standard-slider-inactive-track .track {
            background-color: rgba(0, 0, 0, 0.2);
          }
          .expanding-volume-slider-container .standard-slider-end-stop {
            background-color: #FFFFFF;
          }
        `
      }} />
      <div
        className="custom-video-controls"
        style={{
          position: 'absolute',
          bottom: '2px',
          left: '0',
          right: '0',
          height: '70px',
          background: 'transparent',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          zIndex: 10
        }}
      >
        {/* Play/Pause */}
        <LiquidGlass
          width={50}
          height={50}
          borderRadius="25px"
          className="content-center interactive theme-primary shape-circle video-control"
          cursor="pointer"
          effectIntensity={0.6}
          effectRadius={0.5}
          effectWidth={0.3}
          effectHeight={0.3}
          animateOnHover={true}
          hoverScale={1.1}
          updateOnMouseMove={true}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          onClick={() => {
            if (videoRef.current) {
              if (isPlaying) {
                videoRef.current.pause();
              } else {
                videoRef.current.play().catch(console.error);
              }

              setTimeout(() => {
                const actuallyPlaying = !videoRef.current.paused;
                if (actuallyPlaying !== isPlaying) {
                  setIsPlaying(actuallyPlaying);
                }
              }, 50);
            }
          }}
          style={{
            marginRight: '15px',
            opacity: isFullscreen ? (controlsVisible ? 1 : 0) : (isVideoHovered || controlsVisible) ? 1 : 0,
            transition: 'opacity 0.6s ease-in-out',
            pointerEvents: isFullscreen ? (controlsVisible ? 'auto' : 'none') : (isVideoHovered || controlsVisible) ? 'auto' : 'none'
          }}
        >
          <div style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <PlayPauseMorphType4 playing={isPlaying} color="#FFFFFF" size={24} style={{ filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8))' }} />
          </div>
        </LiquidGlass>

        {/* Progress */}
        <div
          style={{
            flex: 1,
            marginRight: '15px',
            alignSelf: 'center',
            opacity: isFullscreen ? (controlsVisible ? 1 : 0) : (isVideoHovered || controlsVisible) ? 1 : 0,
            transition: 'opacity 0.6s ease-in-out',
            cursor: 'pointer',
            touchAction: 'none',
            position: 'relative',
            height: '20px',
            display: 'flex',
            alignItems: 'center'
          }}
          onMouseDown={handleTimelineMouseDown}
          onTouchStart={handleTimelineTouchStart}
        >
          <WavyProgressIndicator
            ref={wavyProgressRef}
            progress={videoDuration > 0 ? ((isDragging ? dragTime : currentTime) / videoDuration) : 0}
            animate={isPlaying}
            forceFlat={!isPlaying}
            showStopIndicator={true}
            waveSpeed={playbackSpeed * 1.2}
            height={12}
            autoAnimateEntrance={false}
            color="#FFFFFF"
            trackColor="rgba(255, 255, 255, 0.3)"
            stopIndicatorColor="#FFFFFF"
            style={{ width: '100%', position: 'relative' }}
            progressShadow={true}
            progressShadowColor={'rgba(0, 0, 0, 0.8)'}
            progressShadowBlur={2}
            progressShadowOffsetX={0}
            progressShadowOffsetY={1}
            progressShadowBleed={3}
          />

          <div style={{
            position: 'absolute',
            left: videoDuration > 0 ? `${((isDragging ? dragTime : currentTime) / videoDuration) * 100}%` : '0%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: isDragging ? '20px' : '16px',
            height: isDragging ? '20px' : '16px',
            background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,1), rgba(255,255,255,0.95))',
            borderRadius: '50%',
            boxShadow: isDragging ? '0 4px 12px rgba(0,0,0,0.4)' : '0 2px 6px rgba(0,0,0,0.3)',
            transition: isDragging ? 'none' : 'left 0.1s ease, width 0.2s ease, height 0.2s ease',
            cursor: 'pointer',
            zIndex: 10,
            border: '2px solid rgba(255,255,255,0.8)',
            pointerEvents: 'auto'
          }} />
        </div>

        {/* Time */}
        <div style={{
          color: 'white',
          fontSize: '12px',
          fontWeight: '500',
          marginRight: '15px',
          minWidth: '80px',
          textAlign: 'center',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)',
          opacity: isFullscreen ? (controlsVisible ? 1 : 0) : (isVideoHovered || controlsVisible) ? 1 : 0,
          transition: 'opacity 0.6s ease-in-out',
          pointerEvents: isFullscreen ? (controlsVisible ? 'auto' : 'none') : (isVideoHovered || controlsVisible) ? 'auto' : 'none',
          userSelect: 'none'
        }}>
          {Math.floor((isDragging ? dragTime : currentTime) / 60)}:{String(Math.floor((isDragging ? dragTime : currentTime) % 60)).padStart(2, '0')} / {Math.floor(videoDuration / 60)}:{String(Math.floor(videoDuration % 60)).padStart(2, '0')}
        </div>

        {/* Volume pill */}
        <VolumeControlPill
          isFullscreen={isFullscreen}
          controlsVisible={controlsVisible}
          isVideoHovered={isVideoHovered}
          videoRef={videoRef}
          volume={volume}
          setVolume={setVolume}
          isMuted={isMuted}
          setIsMuted={setIsMuted}
          isVolumeSliderVisible={isVolumeSliderVisible}
          setIsVolumeSliderVisible={setIsVolumeSliderVisible}
          isVolumeDragging={isVolumeDragging}
          setIsVolumeDragging={setIsVolumeDragging}
        />

        {/* Combined actions: speed, download, pip */}
        <PlaybackSpeedMenu
          isFullscreen={isFullscreen}
          controlsVisible={controlsVisible}
          isVideoHovered={isVideoHovered}
          videoRef={videoRef}
          playbackSpeed={playbackSpeed}
          setPlaybackSpeed={setPlaybackSpeed}
          isSpeedMenuVisible={isSpeedMenuVisible}
          setIsSpeedMenuVisible={setIsSpeedMenuVisible}
          isCompactMode={isCompactMode}
          isAudioFile={isAudioFile}
        />

        {/* Fullscreen button */}
        <LiquidGlass
          width={50}
          height={50}
          borderRadius="25px"
          className="content-center interactive theme-warning shape-circle video-control"
          cursor="pointer"
          effectIntensity={0.6}
          effectRadius={0.5}
          effectWidth={0.3}
          effectHeight={0.3}
          animateOnHover={true}
          hoverScale={1.1}
          updateOnMouseMove={true}
          aria-label={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          onClick={() => {
            if (isFullscreen) {
              handleFullscreenExit();
            } else {
              const container = document.querySelector('.native-video-container');
              if (container) {
                if (container.requestFullscreen) {
                  container.requestFullscreen().catch(err => console.error(`Error attempting to enable full-screen mode: ${err.message} (${err.name})`));
                } else if (container.webkitRequestFullscreen) {
                  container.webkitRequestFullscreen();
                } else if (container.mozRequestFullScreen) {
                  container.mozRequestFullScreen();
                } else if (container.msRequestFullscreen) {
                  container.msRequestFullscreen();
                }
              } else {
                console.log('ERROR: Container not found!');
              }
            }
          }}
          style={{
            opacity: isFullscreen ? (controlsVisible ? 1 : 0) : (isVideoHovered || controlsVisible) ? 1 : 0,
            transition: 'opacity 0.6s ease-in-out',
            pointerEvents: isFullscreen ? (controlsVisible ? 'auto' : 'none') : (isVideoHovered || controlsVisible) ? 'auto' : 'none'
          }}
        >
          <div style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            {isFullscreen ? (
              <span className="material-symbols-rounded" style={{ color: 'white', fontSize: 20, textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)', display: 'inline-block' }}>
                fullscreen_exit
              </span>
            ) : (
              <span className="material-symbols-rounded" style={{ color: 'white', fontSize: 20, textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)', display: 'inline-block' }}>
                fullscreen
              </span>
            )}
          </div>
        </LiquidGlass>
      </div>
    </>
  );
};

export default VideoBottomControls;
