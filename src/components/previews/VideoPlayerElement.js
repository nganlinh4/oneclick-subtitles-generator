
/**
 * The native <video> element plus its click/touch (play-pause + double-tap
 * seek) handlers.
 *
 * videoRef stays in the parent. lastTouchTimeRef tracks double-tap timing and
 * handleSeek drives the on-screen seek indicator.
 *
 * Props:
 *   - videoRef, lastTouchTimeRef: shared refs from the parent
 *   - handleSeek(direction): show the seek indicator
 *
 * This component deliberately renders no `src` and no `<source>` child. React commits declarative
 * media sources before source-switch effects can snapshot the outgoing transport, so
 * useVideoSourceSwitching is the element's only source writer and owns optimized fallback.
 *   - t: i18n translate function
 */
const VideoPlayerElement = ({
  videoRef,
  lastTouchTimeRef,
  handleSeek,
  seekBy,
  t,
}) => {
  const togglePlayback = () => {
    const video = videoRef.current;
    if (video === null || video === undefined) return;
    if (!video.paused) {
      video.pause();
      return;
    }

    try {
      Promise.resolve(video.play()).catch(console.error);
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <video
      ref={videoRef}
      className="video-player"
      onClick={togglePlayback}
      onTouchEnd={(e) => {
        // Prevent double-tap zoom on mobile
        e.preventDefault();
        const now = Date.now();
        if (now - lastTouchTimeRef.current < 300) { // double tap
          const rect = e.target.getBoundingClientRect();
          const touch = e.changedTouches[0];
          const x = touch.clientX - rect.left;
          const isLeft = x < rect.width / 2;
          if (videoRef.current) {
            if (isLeft) {
              seekBy(-5, { reason: 'video-double-tap' });
            } else {
              seekBy(5, { reason: 'video-double-tap' });
            }
          }
          handleSeek(isLeft ? 'backward' : 'forward');
        } else {
          lastTouchTimeRef.current = now;
          togglePlayback();
        }
      }}
      style={{
        cursor: 'pointer',
        touchAction: 'manipulation',
        width: '100%',
        height: '100%',
        objectFit: 'contain',
        display: 'block',
        zIndex: 1
      }}
      playsInline
      controlsList="nodownload nofullscreen noremoteplayback"
      disablePictureInPicture={false}
      crossOrigin="anonymous"
    >
      {/* Native track subtitles disabled - using only custom subtitle display */}

      {t('preview.videoNotSupported', 'Your browser does not support the video tag.')}
    </video>
  );
};

export default VideoPlayerElement;
