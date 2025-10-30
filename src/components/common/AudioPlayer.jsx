import React, { useEffect, useRef, useState } from 'react';
import PlayPauseMorphType4 from './PlayPauseMorphType4';
import WavyProgressIndicator from './WavyProgressIndicator';

// Local formatter for time display with one decimal
const formatTimeOneDecimal = (timeInSeconds) => {
  const truncated = Math.floor(timeInSeconds * 10) / 10;
  const formatted = truncated.toFixed(1);
  const cleanFormatted = formatted.replace(/\.0$/, '');
  return cleanFormatted + 's';
};

const AudioPlayer = ({ audioSrc, referenceAudio, height = 18, style = { flex: 1 } }) => {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragTime, setDragTime] = useState(0);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const audioRef = useRef(null);
  const wavyProgressRef = useRef(null);
  const thumbRef = useRef(null);
  const timeDisplayRef = useRef(null);

  // Theme detection based on data-theme and classes (no prefers-color-scheme)
  const detectDarkTheme = () => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    const root = document.documentElement;
    const body = document.body;
    if ((root.getAttribute('data-theme') || '').toLowerCase() === 'dark') return true;
    if ((body?.getAttribute('data-theme') || '').toLowerCase() === 'dark') return true;
    if (root.classList.contains('dark') || body?.classList.contains('dark')) return true;
    return false;
  };

  const [isDark, setIsDark] = useState(detectDarkTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setIsDark(detectDarkTheme()));
    try {
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
      if (document.body) observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    } catch (e) {}
    return () => observer.disconnect();
  }, []);

  // Define colors based on theme
  const progressIndicatorColor = isDark ? '#FFFFFF' : '#485E92';
  const progressTrackColor = isDark ? 'rgba(255,255,255,0.35)' : '#D9DFF6';

  // Clamp waveform height to a smaller range for a less tall wave
  const waveformHeight = Math.max(8, Math.min(height, 18));

  // Reset audio state when audioSrc changes
  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    if (audioRef.current) {
      audioRef.current.load();
    }
  }, [audioSrc]);

  // Continuous update of thumb position for smooth animation
  useEffect(() => {
    if (!playing && !isDragging) {
      if (thumbRef.current) {
        thumbRef.current.style.left = duration > 0 ? `${(currentTime / duration) * 100}%` : '0%';
      }
      if (timeDisplayRef.current) {
        timeDisplayRef.current.style.left = duration > 0 ? `${(currentTime / duration) * 100}%` : '0%';
        timeDisplayRef.current.textContent = `${formatTimeOneDecimal(currentTime)} / ${formatTimeOneDecimal(duration)}`;
      }
      if (wavyProgressRef.current) {
        wavyProgressRef.current.setProgress(duration > 0 ? currentTime / duration : 0, false);
      }
      return;
    }

    let rafId;
    const update = () => {
      const time = isDragging ? dragTime : (audioRef.current && isFinite(audioRef.current.currentTime) ? audioRef.current.currentTime : 0);
      if (thumbRef.current) {
        thumbRef.current.style.left = duration > 0 ? `${(time / duration) * 100}%` : '0%';
      }
      if (timeDisplayRef.current) {
        timeDisplayRef.current.style.left = duration > 0 ? `${(time / duration) * 100}%` : '0%';
      }
      if (wavyProgressRef.current) {
        wavyProgressRef.current.setProgress(duration > 0 ? time / duration : 0, false);
      }
      rafId = requestAnimationFrame(update);
    };
    rafId = requestAnimationFrame(update);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [playing, isDragging, duration, currentTime, dragTime]);

  // Separate effect for time display text update at 10fps
  useEffect(() => {
    if (!playing && !isDragging) return;

    const updateText = () => {
      const time = isDragging ? dragTime : (audioRef.current && isFinite(audioRef.current.currentTime) ? audioRef.current.currentTime : 0);
      if (timeDisplayRef.current) {
        timeDisplayRef.current.textContent = `${formatTimeOneDecimal(time)} / ${formatTimeOneDecimal(duration)}`;
      }
    };

    updateText();
    const id = setInterval(updateText, 100);

    return () => clearInterval(id);
  }, [playing, isDragging, dragTime, duration]);

  const togglePlayPause = () => {
    if (playing) {
      audioRef.current.pause();
      setPlaying(false);
    } else {
      audioRef.current.play().catch(e => {
        if (e.name !== 'AbortError') {
          console.error('Play failed', e);
        }
      });
      setPlaying(true);
    }
  };

  const handleTimelineMouseDown = (e) => {
    e.preventDefault();
    setIsDragging(true);
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));
    const newTime = (duration > 0 && isFinite(duration)) ? percentage * duration : 0;
    setDragTime(newTime);
    if (audioRef.current && isFinite(newTime)) {
      audioRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }

    const handleMouseMove = (e) => {
      const clickX = e.clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, clickX / rect.width));
      const newTime = (duration > 0 && isFinite(duration)) ? percentage * duration : 0;
      setDragTime(newTime);
      if (audioRef.current && isFinite(newTime)) {
        audioRef.current.currentTime = newTime;
        setCurrentTime(newTime);
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleTimelineTouchStart = (e) => {
    e.preventDefault();
    setIsDragging(true);
    const rect = e.currentTarget.getBoundingClientRect();
    const touch = e.touches[0];
    const clickX = touch.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));
    const newTime = (duration > 0 && isFinite(duration)) ? percentage * duration : 0;
    setDragTime(newTime);
    if (audioRef.current && isFinite(newTime)) {
      audioRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }

    const handleTouchMove = (e) => {
      const touch = e.touches[0];
      const clickX = touch.clientX - rect.left;
      const percentage = Math.max(0, Math.min(1, clickX / rect.width));
      const newTime = (duration > 0 && isFinite(duration)) ? percentage * duration : 0;
      setDragTime(newTime);
      if (audioRef.current && isFinite(newTime)) {
        audioRef.current.currentTime = newTime;
        setCurrentTime(newTime);
      }
    };

    const handleTouchEnd = () => {
      setIsDragging(false);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };

    document.addEventListener('touchmove', handleTouchMove);
    document.addEventListener('touchend', handleTouchEnd);
  };

  return (
    <div className="custom-audio-player" style={{ height: `${height}px`, ...style }}>
      <PlayPauseMorphType4 playing={playing} onToggle={togglePlayPause} size={20} color="var(--md-primary)" config={{ rotateDegrees: 0 }} />
      <div className="audio-progress-container" style={{ flex: 1, WebkitFlex: 1, position: 'relative', height: `${height}px` }}>
        <div style={{ position: 'relative', zIndex: 0, width: '100%', height: '100%', display: 'flex', alignItems: 'center' }}>
          <WavyProgressIndicator
            ref={wavyProgressRef}
            progress={duration > 0 ? currentTime / duration : 0}
            animate={false}
            forceFlat={!playing}
            height={12}
            wavelength={18}
            strokeWidth={5}
            style={{ width: '100%' }}
            color={progressIndicatorColor}
            trackColor={progressTrackColor}
          />
        </div>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            cursor: 'pointer',
            background: 'transparent'
          }}
          onMouseDown={handleTimelineMouseDown}
          onTouchStart={handleTimelineTouchStart}
        />
        <div
          ref={thumbRef}
          style={{
            display: 'none',
            position: 'absolute',
            left: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: isDragging ? '16px' : '12px',
            height: isDragging ? '16px' : '12px',
            background: 'var(--md-primary)',
            borderRadius: '50%',
            boxShadow: isDragging ? '0 4px 12px rgba(0, 0, 0, 0.4)' : '0 2px 6px rgba(0, 0, 0, 0.3)',
            cursor: 'pointer',
            zIndex: 1,
            border: '1px solid color-mix(in srgb, var(--md-primary), transparent 0.2)',
            pointerEvents: 'none',
            transition: isDragging ? 'none' : 'left 0.1s ease, width 0.2s ease, height 0.2s ease'
          }}
        />
        <div
          ref={timeDisplayRef}
          style={{
            position: 'absolute',
            left: duration > 0 ? `${(currentTime / duration) * 100}%` : '0%',
            top: '-18px',
            transform: 'translateX(-50%)',
            fontSize: '12px',
            fontWeight: '500',
            fontStretch: 'extra-condensed',
            color: 'var(--md-on-surface)',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 2,
            opacity: (playing || isDragging) ? 1 : 0,
            transition: 'opacity 1s ease'
          }}
        ></div>
      </div>

      {audioSrc && (
        <button
          onClick={async () => {
            try {
              const response = await fetch(audioSrc);
              const blob = await response.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = referenceAudio?.filename || 'audio.wav';
              a.click();
              URL.revokeObjectURL(url);
              setDownloadSuccess(true);
              setTimeout(() => setDownloadSuccess(false), 500);
            } catch (e) {
              console.error('Download failed', e);
            }
          }}
          style={{
            marginLeft: '0px',
            background: 'none',
            border: 'none',
            color: 'var(--md-primary)',
            fontSize: '16px',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0
          }}
          title="Download audio"
        >
          <span className="material-symbols-rounded">{downloadSuccess ? 'done' : 'arrow_downward_alt'}</span>
        </button>
      )}
      <audio
        ref={audioRef}
        src={audioSrc}
        preload="metadata"
        onLoadedMetadata={() => setDuration(audioRef.current.duration)}
        onTimeUpdate={() => setCurrentTime(audioRef.current.currentTime)}
        onEnded={() => setPlaying(false)}
        style={{ display: 'none' }}
      >
        Your browser does not support the audio element.
      </audio>
    </div>
  );
};

export default AudioPlayer;
