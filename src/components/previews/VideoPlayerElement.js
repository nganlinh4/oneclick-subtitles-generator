
/**
 * The native <video> element plus its click/touch (play-pause + double-tap
 * seek) handlers and the optimized->original source fallback on error.
 *
 * videoRef and the shared playback state (isPlaying/setIsPlaying) stay in the
 * parent and are passed in. lastTouchTimeRef tracks double-tap timing and
 * handleSeek drives the on-screen seek indicator.
 *
 * Props:
 *   - videoRef, lastTouchTimeRef: shared refs from the parent
 *   - isPlaying, setIsPlaying: shared playback state
 *   - handleSeek(direction): show the seek indicator
 *   - useOptimizedPreview, optimizedVideoUrl, videoUrl: source selection
 *   - t: i18n translate function
 */
const VideoPlayerElement = ({
  videoRef,
  lastTouchTimeRef,
  isPlaying,
  setIsPlaying,
  handleSeek,
  useOptimizedPreview,
  optimizedVideoUrl,
  videoUrl,
  t,
}) => {
  const activeSrc = useOptimizedPreview && optimizedVideoUrl ? optimizedVideoUrl : videoUrl;

  return (
    <video
      ref={videoRef}
      className="video-player"
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
              setIsPlaying(actuallyPlaying);
            }
          }, 50);
        }
      }}
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
              videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 5);
            } else {
              if (videoRef.current.duration) {
                videoRef.current.currentTime = Math.min(videoRef.current.duration, videoRef.current.currentTime + 5);
              }
            }
          }
          handleSeek(isLeft ? 'backward' : 'forward');
        } else {
          lastTouchTimeRef.current = now;
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
                setIsPlaying(actuallyPlaying);
              }
            }, 50);
          }
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
      src={activeSrc}
      crossOrigin="anonymous"
      onError={(e) => {
        console.error('Video error:', e);
        // If optimized video fails to load, fall back to original video
        if (useOptimizedPreview && optimizedVideoUrl && e.target.src === optimizedVideoUrl) {

          e.target.src = videoUrl;
          e.target.load();
        }
      }}
    >
      <source
        src={activeSrc}
        type="video/mp4"
        onError={(e) => {
          console.error('Source error:', e);
          // If optimized video fails to load, fall back to original video
          if (useOptimizedPreview && optimizedVideoUrl && e.target.src === optimizedVideoUrl) {

            e.target.src = videoUrl;
          }
        }}
      />

      {/* Native track subtitles disabled - using only custom subtitle display */}

      {t('preview.videoNotSupported', 'Your browser does not support the video tag.')}
    </video>
  );
};

export default VideoPlayerElement;
