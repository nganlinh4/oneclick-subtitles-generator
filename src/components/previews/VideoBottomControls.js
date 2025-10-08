import React, { useRef, useEffect } from 'react';
import LiquidGlass from '../common/LiquidGlass';
import PlayPauseMorphType4 from '../common/PlayPauseMorphType4';
import WavyProgressIndicator from '../common/WavyProgressIndicator';

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
  handleFullscreenExit,
  setIsFullscreen,
  setControlsVisible,
  setIsVideoHovered,
  hideControlsTimeoutRef
}) => {
  // Ref for WavyProgressIndicator
  const wavyProgressRef = useRef(null);

  // --- FIX STARTS HERE ---
  // Centralized listener for fullscreen changes to handle both button clicks and keyboard shortcuts (e.g., 'F' key).
  // This ensures the React state and necessary styles are always in sync with the browser's actual fullscreen state.
  useEffect(() => {
    
    // Function to manually apply styles, acting as a fallback for browsers that don't auto-resize children properly.
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
      
      // Sync React state with the browser's actual state
      setIsFullscreen(isCurrentlyFullscreen);

      if (isCurrentlyFullscreen) {
        // --- Actions on ENTERING fullscreen ---
        applyFullscreenStyles(); // Apply styles to fix height/width issues
        setControlsVisible(true);
        setIsVideoHovered(false); // Reset hover state

        // Start auto-hide timer for controls
        if (hideControlsTimeoutRef.current) {
          clearTimeout(hideControlsTimeoutRef.current);
        }
        if (isPlaying) {
          hideControlsTimeoutRef.current = setTimeout(() => {
            setControlsVisible(false);
            const container = document.querySelector('.native-video-container');
            if (container) container.style.cursor = 'none';
          }, 3000); // 3-second delay in fullscreen
        }
      } else {
        // --- Actions on EXITING fullscreen ---
        // The parent component's `handleFullscreenExit` prop should handle removing styles and other cleanup.
        handleFullscreenExit();
      }
    };

    // Add event listeners for all browser vendors
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('msfullscreenchange', handleFullscreenChange);

    // Cleanup listeners on component unmount
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
  // --- FIX ENDS HERE ---

  return (
    <>
                {/* Custom Liquid Glass Video Controls */}
                {showCustomControls && (
                  <div
                    className="custom-video-controls"
                    style={{
                      position: 'absolute',
                      bottom: '0',
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
                    {/* Play/Pause Button */}
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

                          // Force sync UI state after a short delay to ensure it matches video state
                          setTimeout(() => {
                            const actuallyPlaying = !videoRef.current.paused;
                            if (actuallyPlaying !== isPlaying) {
                              console.log('[VideoPreview] Force syncing UI state after button click:', { actuallyPlaying, uiState: isPlaying });
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

                    {/* WavyProgressIndicator Timeline/Progress Bar */}
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
                        height: '20px', // Taller to accommodate wavy animation without clipping
                        display: 'flex',
                        alignItems: 'center'
                      }}
                      onMouseDown={handleTimelineMouseDown}
                      onTouchStart={handleTimelineTouchStart}
                    >
                      <WavyProgressIndicator
                        ref={wavyProgressRef}
                        progress={videoDuration > 0 ? ((isDragging ? dragTime : currentTime) / videoDuration) : 0}
                        animate={isPlaying} // Only animate when video is playing
                        forceFlat={!isPlaying} // Force flat when video is paused
                        showStopIndicator={true} // Show the dot indicator
                        waveSpeed={playbackSpeed * 1.2} // Adaptive wave speed based on playback speed
                        height={12}
                        autoAnimateEntrance={false}
                        color="#FFFFFF"
                        trackColor="rgba(255, 255, 255, 0.3)"
                        stopIndicatorColor="#FFFFFF" // White dot to match the progress
                        style={{
                          width: '100%',
                          position: 'relative'
                        }}
                        progressShadow={true}
                        progressShadowColor={'rgba(0, 0, 0, 0.8)'}
                        progressShadowBlur={2}
                        progressShadowOffsetX={0}
                        progressShadowOffsetY={1}
                        progressShadowBleed={3}
                      />

                      {/* Seeker Handle - draggable circle for user interaction */}
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

                    {/* Time Display */}
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

                    {/* Volume Control with Expanding Pill */}
                    <div
                      className="volume-pill-wrapper"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        marginRight: '15px',
                        position: 'relative'
                      }}
                      onMouseEnter={() => setIsVolumeSliderVisible(true)}
                      onMouseLeave={() => setIsVolumeSliderVisible(false)}
                      onTouchStart={() => setIsVolumeSliderVisible(true)}
                    >
                      {/* Expanding Volume Pill */}
                      <LiquidGlass
                        width={50}
                        height={180} // Keep LiquidGlass at full height to maintain effect continuity
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
                          // Animate only CSS height and transform; keep LiquidGlass filter at full size
                          height: isVolumeSliderVisible ? '180px' : '50px',
                          overflow: 'hidden',
                          willChange: 'height, transform, opacity',
                          transform: isVolumeSliderVisible ? 'translateY(-65px)' : 'translateY(0px)', // Shoot upward
                          transformOrigin: 'bottom center', // Expand from bottom
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
                          {/* Volume Slider - always present but with opacity transition */}
                          <div
                            className="expanding-volume-slider"
                            style={{
                              width: '6px',
                              height: '60px',
                              background: 'rgba(255,255,255,0.3)',
                              borderRadius: '3px',
                              position: 'absolute',
                              top: '50px', // Moved down to be more visible
                              cursor: 'pointer',
                              opacity: isVolumeSliderVisible ? 1 : 0,
                              transition: 'opacity 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
                              pointerEvents: isVolumeSliderVisible ? 'auto' : 'none',
                              touchAction: 'none'
                            }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setIsVolumeDragging(true);
                                const rect = e.currentTarget.getBoundingClientRect();
                                const newVolume = Math.max(0, Math.min(1, (rect.bottom - e.clientY) / rect.height));
                                setVolume(newVolume);
                                if (videoRef.current) {
                                  videoRef.current.volume = newVolume;
                                  videoRef.current.muted = newVolume === 0;
                                  setIsMuted(newVolume === 0);
                                }
                              }}
                              onTouchStart={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setIsVolumeDragging(true);
                                const rect = e.currentTarget.getBoundingClientRect();
                                const touch = e.touches && e.touches[0];
                                if (touch) {
                                  const newVolume = Math.max(0, Math.min(1, (rect.bottom - touch.clientY) / rect.height));
                                  setVolume(newVolume);
                                  if (videoRef.current) {
                                    videoRef.current.volume = newVolume;
                                    videoRef.current.muted = newVolume === 0;
                                    setIsMuted(newVolume === 0);
                                  }
                                }
                              }}
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const rect = e.currentTarget.getBoundingClientRect();
                                const newVolume = Math.max(0, Math.min(1, (rect.bottom - e.clientY) / rect.height));
                                setVolume(newVolume);
                                if (videoRef.current) {
                                  videoRef.current.volume = newVolume;
                                  videoRef.current.muted = newVolume === 0;
                                  setIsMuted(newVolume === 0);
                                }
                              }}
                            >
                            {/* Glass-style volume fill with gradient */}
                            <div style={{
                              position: 'absolute',
                              bottom: 0,
                              left: 0,
                              width: '100%',
                              height: `${volume * 100}%`,
                              background: 'linear-gradient(to top, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0.4) 50%, rgba(255,255,255,0.6) 100%)',
                              borderRadius: '3px',
                              backdropFilter: 'blur(4px)',
                              boxShadow: 'inset 0 1px 2px rgba(255,255,255,0.3), 0 1px 3px rgba(0,0,0,0.2)',
                              transition: isVolumeDragging ? 'none' : 'height 0.2s ease'
                            }} />

                            {/* Glass orb handle */}
                            <div
                              style={{
                                position: 'absolute',
                                bottom: `${volume * 100}%`,
                                left: '50%',
                                transform: 'translate(-50%, 50%)',
                                width: isVolumeDragging ? '18px' : '16px',
                                height: isVolumeDragging ? '18px' : '16px',
                                background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,1), rgba(255,255,255,0.95), rgba(255,255,255,0.85))',
                                borderRadius: '50%',
                                backdropFilter: 'blur(2px)',
                                boxShadow: isVolumeDragging
                                  ? '0 4px 12px rgba(0,0,0,0.3), inset 0 1px 2px rgba(255,255,255,0.6), 0 0 8px rgba(255,255,255,0.4)'
                                  : '0 2px 6px rgba(0,0,0,0.2), inset 0 1px 2px rgba(255,255,255,0.6), 0 0 4px rgba(255,255,255,0.3)',
                                border: '1px solid rgba(255,255,255,0.8)',
                                transition: isVolumeDragging ? 'none' : 'all 0.2s ease',
                                cursor: 'pointer',
                                zIndex: 10
                              }}
                              onMouseDown={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setIsVolumeDragging(true);
                              }}
                              onTouchStart={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setIsVolumeDragging(true);
                              }}
                            />

                            {/* Volume percentage indicator - Simple text */}
                            <div
                              style={{
                                position: 'absolute',
                                top: '-35px', // Even higher at the very top
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

                          {/* Volume Icon - Fixed position at bottom */}
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '30px',
                              height: '30px',
                              cursor: 'pointer',
                              position: 'absolute',
                              bottom: '10px', // Back to original position
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
                              // Muted icon
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="white" style={{ filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8))' }}>
                                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                              </svg>
                            ) : volume < 0.5 ? (
                              // Low volume icon
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="white" style={{ filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8))' }}>
                                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                              </svg>
                            ) : (
                              // High volume icon
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="white" style={{ filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8))' }}>
                                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                              </svg>
                            )}
                          </div>
                        </div>
                      </LiquidGlass>
                    </div>

                    {/* Combined Actions Pill (Speed, Download, PiP) */}
                    <div
                      style={{
                        position: 'relative',
                        marginRight: '15px'
                      }}
                      onMouseEnter={() => setIsSpeedMenuVisible(true)}
                      onMouseLeave={() => setIsSpeedMenuVisible(false)}
                    >
                      {/* Invisible hover area extension */}
                      <div style={{
                        position: 'absolute',
                        top: '-200px',
                        left: '-10px',
                        right: '-10px',
                        height: '200px',
                        zIndex: 5
                      }} />
                      {/* Speed Menu */}
                      {isSpeedMenuVisible && (
                        <div
                          style={{
                            position: 'absolute',
                            bottom: '60px',
                            left: '35px', // Moved right to align better with speed button
                            transform: 'translateX(-50%)',
                            zIndex: 20,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                            padding: '8px'
                          }}
                        >
                          {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map(speed => (
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
                              onClick={() => {
                                setPlaybackSpeed(speed);
                                if (videoRef.current) {
                                  videoRef.current.playbackRate = speed;
                                }
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

                      {/* Combined Actions Pill */}
                      <LiquidGlass
                        width={150}
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
                          {/* Speed Button */}
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '40px',
                              height: '30px',
                              borderRadius: '15px',
                              background: 'rgba(33, 150, 243, 0.2)',
                              cursor: 'pointer',
                              transition: 'all 0.2s ease'
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              // Speed functionality handled by hover menu
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

                          {/* Download Video Button */}
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
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="white" style={{ filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8))' }}>
                              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
                            </svg>
                          </div>

                          {/* Picture-in-Picture Button */}
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
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="white" style={{ filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8))' }}>
                              <path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z"/>
                            </svg>
                          </div>
                        </div>
                      </LiquidGlass>
                    </div>

                    {/* Fullscreen Button */}
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
                        // The button's only job is to request or exit fullscreen.
                        // The useEffect hook will handle the resulting state changes.
                        if (isFullscreen) {
                          handleFullscreenExit(); // Call prop to exit/clean up
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
                            console.log('ðŸŽ¬ ERROR: Container not found!');
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
                          // Exit fullscreen icon
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="white" style={{ filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8))' }}>
                            <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>
                          </svg>
                        ) : (
                          // Fullscreen icon
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="white" style={{ filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8))' }}>
                            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
                          </svg>
                        )}
                      </div>
                    </LiquidGlass>
                  </div>
                )}

    </>
  );
};

export default VideoBottomControls;