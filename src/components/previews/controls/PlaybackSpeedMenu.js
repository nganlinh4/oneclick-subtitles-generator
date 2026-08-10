import LiquidGlass from '../../common/LiquidGlass';
import ActionButtons from './ActionButtons';

const PlaybackSpeedMenu = ({
  isFullscreen,
  controlsVisible,
  isVideoHovered,
  videoRef,
  playbackSpeed,
  setPlaybackSpeed,
  isSpeedMenuVisible,
  setIsSpeedMenuVisible,
  isCompactMode,
  isAudioFile
}) => {
  return (
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

          <ActionButtons videoRef={videoRef} isAudioFile={isAudioFile} />
        </div>
      </LiquidGlass>
    </div>
  );
};

export default PlaybackSpeedMenu;
