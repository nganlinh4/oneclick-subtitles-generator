import { useEffect } from 'react';

const useVideoSeekControls = (videoRef, onSeek) => {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!videoRef.current) return;

      if (event.code === 'ArrowLeft') {
        event.preventDefault();
        videoRef.current.currentTime = Math.max(0, videoRef.current.currentTime - 5);
        onSeek && onSeek('backward');
      } else if (event.code === 'ArrowRight') {
        event.preventDefault();
        if (videoRef.current.duration) {
          videoRef.current.currentTime = Math.min(videoRef.current.duration, videoRef.current.currentTime + 5);
        }
        onSeek && onSeek('forward');
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [videoRef, onSeek]);
};

export default useVideoSeekControls;