import LiquidGlass from '../../common/LiquidGlass';
import StandardSlider from '../../common/StandardSlider';

const VolumeControlPill = ({
  isFullscreen,
  controlsVisible,
  isVideoHovered,
  videoRef,
  volume,
  setVolume,
  isMuted,
  setIsMuted,
  isVolumeSliderVisible,
  setIsVolumeSliderVisible,
  isVolumeDragging,
  setIsVolumeDragging
}) => {
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

  return (
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
  );
};

export default VolumeControlPill;
