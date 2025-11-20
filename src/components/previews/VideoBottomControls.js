import React, { useRef, useEffect } from 'react';
import LiquidGlass from '../common/LiquidGlass';
import PlayPauseMorphType4 from '../common/PlayPauseMorphType4';
import WavyProgressIndicator from '../common/WavyProgressIndicator';
import StandardSlider from '../common/StandardSlider'; // Import the slider

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
  setIsDragging,
  setDragTime,
  dragTimeRef,
  bufferedProgress,
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
  videoSource,
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

  const handleVolumeChange = (newVolume) => {
    setVolume(newVolume);
    if (videoRef.current) {
      videoRef.current.volume = newVolume;
      const newMuted = newVolume <= 0;
      if (isMuted !== newMuted) {
        videoRef.current.muted = newMuted;
        setIsMuted(newMuted);
      }
    }
  };

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
        <div
          className="volume-pill-wrapper"
          style={{ display: 'flex', alignItems: 'center', marginRight: '15px', position: 'relative' }}
          onMouseEnter={() => setIsVolumeSliderVisible(true)}
          onMouseLeave={() => setIsVolumeSliderVisible(false)}
          onTouchStart={() => setIsVolumeSliderVisible(true)}
        >
          <LiquidGlass
            width={50}
            height={180}
            borderRadius="25px"
            className="content-center interactive theme-secondary volume-pill-slow video-control"
            cursor="pointer"
            effectIntensity={0.7}
            effectRadius={0.6}
            effectWidth={0.4}
            effectHeight={0.4}
            animateOnHover={true}
            hoverScale={1.02}
            updateOnMouseMove={true}
            style={{
              height: isVolumeSliderVisible ? '180px' : '50px',
              overflow: 'hidden',
              willChange: 'height, transform, opacity',
              transform: isVolumeSliderVisible ? 'translateY(-65px)' : 'translateY(0px)',
              transformOrigin: 'bottom center',
              opacity: isFullscreen ? (controlsVisible ? 1 : 0) : (isVideoHovered || controlsVisible) ? 1 : 0,
              transition: 'height 0.3s ease-in-out, opacity 0.6s ease-in-out, transform 0.6s ease-in-out',
              pointerEvents: isFullscreen ? (controlsVisible ? 'auto' : 'none') : (isVideoHovered || controlsVisible) ? 'auto' : 'none'
            }}
          >
            <div style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              position: 'relative'
            }}>
              <div
                className="expanding-volume-slider-container"
                style={{
                  width: '30px',
                  height: '80px',
                  position: 'absolute',
                  top: '48px',
                  display: 'flex',
                  justifyContent: 'center',
                  opacity: isVolumeSliderVisible ? 1 : 0,
                  transition: 'opacity 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
                  pointerEvents: isVolumeSliderVisible ? 'auto' : 'none',
                  filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.35)) drop-shadow(0 1px 3px rgba(0,0,0,0.25))'
                }}
              >
                <StandardSlider
                  orientation="vertical"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={handleVolumeChange}
                  onDragStart={() => setIsVolumeDragging(true)}
                  onDragEnd={() => setIsVolumeDragging(false)}
                  showValueIndicator={false}
                  showValueBadge={false}
                  className="video-volume-slider"
                />
                <div
                  style={{
                    position: 'absolute',
                    top: '-30px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    fontSize: '12px',
                    fontWeight: '600',
                    color: 'white',
                    textShadow: '0 1px 3px rgba(0,0,0,0.7)',
                    opacity: isVolumeDragging || isVolumeSliderVisible ? 1 : 0,
                    transition: 'opacity 0.6s ease-in-out',
                    pointerEvents: 'none',
                    zIndex: 15,
                    textAlign: 'center'
                  }}
                >
                  {Math.round(volume * 100)}%
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '30px',
                  height: '30px',
                  cursor: 'pointer',
                  position: 'absolute',
                  bottom: '10px',
                  left: '50%',
                  transform: 'translateX(-50%)'
                }}
                onClick={() => {
                  if (videoRef.current) {
                    const newMuted = !videoRef.current.muted;
                    videoRef.current.muted = newMuted;
                    setIsMuted(newMuted);
                    if (newMuted) {
                      setVolume(0);
                    } else {
                      const newVolume = volume === 0 ? 0.5 : volume;
                      setVolume(newVolume);
                      videoRef.current.volume = newVolume;
                    }
                  }
                }}
              >
                {isMuted || volume === 0 ? (
                  <span className="material-symbols-rounded" style={{ color: 'white', fontSize: 18, textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)', display: 'inline-block' }}>
                    volume_off
                  </span>
                ) : volume < 0.5 ? (
                  <span className="material-symbols-rounded" style={{ color: 'white', fontSize: 18, textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)', display: 'inline-block' }}>
                    volume_down
                  </span>
                ) : (
                  <span className="material-symbols-rounded" style={{ color: 'white', fontSize: 18, textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)', display: 'inline-block' }}>
                    volume_up
                  </span>
                )}
              </div>
            </div>
          </LiquidGlass>
        </div>

        {/* Combined actions: speed, download, pip */}
        <div style={{ position: 'relative', marginRight: '15px' }}
          onMouseEnter={() => !isCompactMode && setIsSpeedMenuVisible(true)}
          onMouseLeave={() => !isCompactMode && setIsSpeedMenuVisible(false)}
        >
          {/* Speed menu dropdown (only for expanded mode) */}
          {!isCompactMode && (
            <div style={{
              position: 'absolute',
              bottom: '50px',
              left: '24%',
              transform: 'translateX(-50%)',
              zIndex: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              padding: '8px'
            }}>
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((speed, index) => (
                <LiquidGlass
                  key={speed}
                  width={60}
                  height={32}
                  borderRadius="16px"
                  className={`content-center interactive ${playbackSpeed === speed ? 'theme-success' : 'theme-secondary'}`}
                  cursor="pointer"
                  effectIntensity={0.3}
                  effectRadius={0.5}
                  effectWidth={0.2}
                  effectHeight={0.3}
                  animateOnHover={true}
                  hoverScale={1.1}
                  updateOnMouseMove={true}
                  style={{
                    opacity: isSpeedMenuVisible ? 1 : 0,
                    transition: 'opacity 0.1s ease-in-out',
                    transitionDelay: isSpeedMenuVisible ? `${(6 - index) * 0.015}s` : `${index * 0.015}s`,
                    pointerEvents: isSpeedMenuVisible ? 'auto' : 'none'
                  }}
                  onClick={() => {
                    setPlaybackSpeed(speed);
                    if (videoRef.current) videoRef.current.playbackRate = speed;
                  }}
                >
                  <div style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    fontWeight: playbackSpeed === speed ? '600' : '500',
                    color: 'white',
                    textShadow: '0 1px 2px rgba(0,0,0,0.5)'
                  }}>
                    {speed}x
                  </div>
                </LiquidGlass>
              ))}
            </div>
          )}

          <LiquidGlass
            width={isCompactMode ? 140 : 150}
            height={50}
            borderRadius="25px"
            className="content-center interactive theme-secondary video-control"
            cursor="pointer"
            effectIntensity={0.6}
            effectRadius={0.5}
            effectWidth={0.3}
            effectHeight={0.2}
            animateOnHover={true}
            hoverScale={1.02}
            updateOnMouseMove={false}
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
              justifyContent: 'space-around',
              padding: '0 10px'
            }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: isCompactMode ? '40px' : '40px',
                  height: '30px',
                  borderRadius: '15px',
                  background: 'rgba(33, 150, 243, 0.2)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (isCompactMode) {
                    // Cycle to next speed
                    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
                    const currentIndex = speeds.indexOf(playbackSpeed);
                    const nextIndex = (currentIndex + 1) % speeds.length;
                    const newSpeed = speeds[nextIndex];
                    setPlaybackSpeed(newSpeed);
                    if (videoRef.current) videoRef.current.playbackRate = newSpeed;
                  }
                }}
              >
                <span style={{
                  fontSize: '11px',
                  fontWeight: 'bold',
                  color: 'white',
                  textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)'
                }}>
                  {playbackSpeed}x
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '30px',
                  height: '30px',
                  borderRadius: '15px',
                  background: 'rgba(76, 175, 80, 0.2)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (videoRef.current && videoRef.current.src) {
                    const link = document.createElement('a');
                    link.href = videoRef.current.src;
                    link.download = `video_${Date.now()}.mp4`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                  }
                }}
              >
                <span className="material-symbols-rounded" style={{ color: 'white', fontSize: 18, textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)', display: 'inline-block' }}>
                  download
                </span>
              </div>

              {/* PiP button - only show for video files, not audio files */}
              {!isAudioFile && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '30px',
                    height: '30px',
                    borderRadius: '15px',
                    background: 'rgba(255, 152, 0, 0.2)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease'
                  }}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (videoRef.current) {
                      try {
                        if (document.pictureInPictureElement) {
                          await document.exitPictureInPicture();
                        } else if (videoRef.current.requestPictureInPicture) {
                          await videoRef.current.requestPictureInPicture();
                        }
                      } catch (error) {
                        console.error('Picture-in-Picture error:', error);
                      }
                    }
                  }}
                >
                  <span className="material-symbols-rounded" style={{ color: 'white', fontSize: 18, textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)', display: 'inline-block' }}>
                    picture_in_picture_alt
                  </span>
                </div>
              )}
            </div>
          </LiquidGlass>
        </div>

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